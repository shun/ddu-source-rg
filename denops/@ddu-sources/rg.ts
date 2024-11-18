import {
  type DduOptions,
  type Item,
  type SourceOptions,
} from "jsr:@shougo/ddu-vim@~6.4.0/types";
import { BaseSource } from "jsr:@shougo/ddu-vim@~6.4.0/source";
import { treePath2Filename } from "jsr:@shougo/ddu-vim@~6.4.0/utils";
import { type ActionData } from "jsr:@shougo/ddu-kind-file@~0.9.0";

import type { Denops } from "jsr:@denops/core@~7.0.0";
import * as fn from "jsr:@denops/std@~7.3.0/function";

import { resolve } from "jsr:@std/path@~1.0.3/resolve";
import { abortable } from "jsr:@std/async@~1.0.4/abortable";
import { TextLineStream } from "jsr:@std/streams@~1.0.3/text-line-stream";

const enqueueSize1st = 1000;
const enqueueSize2nd = 100000;

type HighlightGroup = {
  path: string;
  lineNr: string;
  word: string;
};

type InputType =
  | "regex"
  | "migemo";

type Params = {
  args: string[];
  cmd: string;
  displayText: boolean;
  highlights: HighlightGroup;
  input: string;
  maxEnqueSize: number;
  minVolatileInputLength: number;
  inputType: InputType;
  paths: string[];
};

async function* iterLine(r: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const lines = r
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());

  for await (const line of lines) {
    if ((line as string).length) {
      yield line as string;
    }
  }
}

function kensakuQuery(denops: Denops, text: string): Promise<string> {
  return denops.dispatch("kensaku", "query", text) as Promise<string>;
}

function utf8Length(str: string): number {
  return new TextEncoder().encode(str).length;
}

export class Source extends BaseSource<Params> {
  override kind = "file";

  gather(args: {
    denops: Denops;
    options: DduOptions;
    sourceOptions: SourceOptions;
    sourceParams: Params;
    input: string;
  }): ReadableStream<Item<ActionData>[]> {
    const abortController = new AbortController();

    const hlGroupPath = args.sourceParams.highlights?.path ?? "";
    const hlGroupLineNr = args.sourceParams.highlights?.lineNr ?? "";
    const hlGroupWord = args.sourceParams.highlights?.word ?? "";
    const displayText = args.sourceParams.displayText;

    const parseJson = (line: string, cwd: string) => {
      line = line.trim();

      const jo = JSON.parse(line);
      if (jo.type !== "match") {
        return null;
      }
      const path = jo.data.path.text;
      const lineNr = jo.data.line_number;
      const col = jo.data.submatches[0].start;
      const text = jo.data.lines.text?.replace(/\r?\n/, "");
      const header = `${path}:${lineNr}:${col}: `;
      return {
        word: header + text,
        action: {
          // When paths given, path is absolute path
          path: path ? resolve(cwd, path) : "",
          lineNr,
          col: col + 1,
          text,
        },
        highlights: [
          {
            name: "path",
            hl_group: hlGroupPath,
            col: 1,
            width: utf8Length(path),
          },
          {
            name: "lineNr",
            hl_group: hlGroupLineNr,
            col: utf8Length(path) + 2,
            width: utf8Length(String(lineNr)),
          },
          {
            name: "word",
            hl_group: hlGroupWord,
            col: utf8Length(header) + col + 1,
            width: jo.data.submatches[0].end - col,
          },
        ],
      };
    };
    const re = /^([^:]+):(\d+):(\d+):(.*)$/;
    const parseLine = (line: string, cwd: string) => {
      line = line.trim();
      const result = line.match(re);
      const getParam = (ary: string[], index: number) => {
        return ary[index] ?? "";
      };

      const path = result ? getParam(result, 1) : "";
      const lineNr = result ? Number(getParam(result, 2)) : 0;
      const col = result ? Number(getParam(result, 3)) : 0;
      const text = result ? getParam(result, 4) : "";
      const display = result
        ? displayText ? line : result.slice(1, 3).join(":")
        : "";

      return {
        word: text,
        display,
        action: {
          // When paths given, path is absolute path
          path: path ? resolve(cwd, path) : "",
          lineNr,
          col,
          text,
        },
      };
    };

    const getInput = async (): Promise<string> => {
      const input = args.sourceOptions.volatile
        ? args.input
        : args.sourceParams.input;
      switch (args.sourceParams.inputType) {
        case "migemo":
          return await kensakuQuery(args.denops, input);
        default: // "regex"
          return input;
      }
    };

    return new ReadableStream({
      async start(controller) {
        const input = await getInput();

        if (
          input == "" ||
          args.sourceOptions.volatile &&
            input.length < args.sourceParams.minVolatileInputLength
        ) {
          controller.close();
          return;
        }

        const cmd = [
          await fn.exepath(args.denops, args.sourceParams.cmd),
          ...args.sourceParams.args,
          "--",
          input,
          ...args.sourceParams.paths,
        ];

        let items: Item<ActionData>[] = [];
        let enqueueSize = enqueueSize1st;
        let numChunks = 0;

        const cwd = args.sourceOptions.path.length !== 0
          ? treePath2Filename(args.sourceOptions.path)
          : await fn.getcwd(args.denops) as string;

        const proc = new Deno.Command(
          cmd[0],
          {
            args: cmd.slice(1),
            stdout: "piped",
            stderr: "piped",
            stdin: "null",
            cwd,
          },
        ).spawn();

        let totalSize = 0;
        try {
          for await (
            const line of abortable(
              iterLine(proc.stdout),
              abortController.signal,
            )
          ) {
            if (args.sourceParams.args.includes("--json")) {
              const ret = parseJson(line, cwd);
              if (ret) {
                items.push(ret);
                totalSize += 1;
              }
            } else {
              const ret = parseLine(line, cwd);
              if (ret.word.length !== 0) {
                items.push(ret);
                totalSize += 1;
              }
            }

            if (totalSize >= args.sourceParams.maxEnqueSize) {
              controller.enqueue(items);
              // Need to kill the process before return because don't exit
              // stderr iteration until process exit.
              proc.kill("SIGTERM");
              return;
            }

            if (items.length >= enqueueSize) {
              numChunks++;
              if (numChunks > 1) {
                enqueueSize = enqueueSize2nd;
              }
              controller.enqueue(items);
              items = [];
            }
          }

          if (items.length) {
            controller.enqueue(items);
          }
        } catch (e: unknown) {
          if (e instanceof DOMException) {
            proc.kill("SIGTERM");
          } else {
            console.error(e);
          }
        } finally {
          for await (
            const mes of abortable(
              iterLine(proc.stderr),
              abortController.signal,
            )
          ) {
            console.error(mes);
          }

          controller.close();
        }
      },

      cancel(reason): void {
        abortController.abort(reason);
      },
    });
  }

  params(): Params {
    return {
      args: ["--column", "--no-heading", "--color", "never"],
      cmd: "rg",
      displayText: true,
      inputType: "regex",
      input: "",
      maxEnqueSize: 10000,
      minVolatileInputLength: 2,
      paths: [],
      highlights: {
        path: "Normal",
        lineNr: "Normal",
        word: "Search",
      },
    };
  }
}
