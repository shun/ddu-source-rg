import {
  BaseSource,
  DduOptions,
  Item,
  SourceOptions,
} from "https://deno.land/x/ddu_vim@v3.4.3/types.ts";
import { Denops, fn } from "https://deno.land/x/ddu_vim@v3.4.3/deps.ts";
import { ActionData } from "https://deno.land/x/ddu_kind_file@v0.5.3/file.ts";
import { resolve } from "https://deno.land/std@0.195.0/path/mod.ts";
import { abortable } from "https://deno.land/std@0.195.0/async/mod.ts";
import { TextLineStream } from "https://deno.land/std@0.195.0/streams/mod.ts";
import { treePath2Filename } from "https://deno.land/x/ddu_vim@v3.4.3/utils.ts";

const enqueueSize1st = 1000;

type HighlightGroup = {
  path: string;
  lineNr: string;
  word: string;
};

type InputType =
  | "regex"
  | "migemo";

type Params = {
  cmd: string;
  args: string[];
  displayText: boolean;
  inputType: InputType;
  input: string;
  paths: string[];
  highlights: HighlightGroup;
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
  kind = "file";

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

        if (input == "") {
          controller.close();
          return;
        }

        const cmd = [
          await fn.exepath(args.denops, args.sourceParams.cmd || "rg"),
          ...args.sourceParams.args,
          "--",
          input,
          ...args.sourceParams.paths,
        ];

        let items: Item<ActionData>[] = [];
        const enqueueSize2nd = 100000;
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
              }
            } else {
              items.push(parseLine(line, cwd));
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
      displayText: true,
      inputType: "regex",
      input: "",
      paths: [],
      highlights: {
        path: "Normal",
        lineNr: "Normal",
        word: "Search",
      },
    };
  }
}
