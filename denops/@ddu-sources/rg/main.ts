import type { DduOptions, Item, SourceOptions } from "@shougo/ddu-vim/types";
import { BaseSource } from "@shougo/ddu-vim/source";
import { treePath2Filename } from "@shougo/ddu-vim/utils";
import type { ActionData } from "@shougo/ddu-kind-file";

import type { Denops } from "@denops/std";
import * as fn from "@denops/std/function";

import { resolve } from "@std/path/resolve";
import { relative } from "@std/path/relative";
import { abortable } from "@std/async/abortable";
import { TextLineStream } from "@std/streams/text-line-stream";

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
  category: boolean;
  cmd: string;
  globs: string[];
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
    const parseLine = (line: string, cwd: string, input: string) => {
      line = line.trim();
      const result = line.match(re);
      const getParam = (ary: string[], index: number) => {
        return ary[index] ?? "";
      };

      const path = result ? getParam(result, 1) : "";
      const lineNr = result ? Number(getParam(result, 2)) : 0;
      const col = result ? Number(getParam(result, 3)) : 0;
      const text = result ? getParam(result, 4) : "";
      const header = `${path}:${lineNr}:${col}: `;

      const textStart = utf8Length(path) + 2 + utf8Length(String(lineNr)) +
        utf8Length(String(col)) + 2;

      return {
        word: header + text,
        action: {
          // When paths given, path is absolute path
          path: path ? resolve(cwd, path) : "",
          lineNr,
          col,
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
            col: textStart + col,
            width: utf8Length(input),
          },
        ],
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
          // Inline expansion of globs into ["--glob", g, "--glob", g2, ...]
          ...((args.sourceParams.globs ?? []).flatMap((g) => ["--glob", g])),
          "--",
          input,
          ...args.sourceParams.paths,
        ];

        let items: Item<ActionData>[] = [];
        const categories = new Set<string>();
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

        const pushItem = (item: Item<ActionData>) => {
          if (args.sourceParams.category) {
            if (item?.action?.path && !categories.has(item.action.path)) {
              // Add category
              const path = item.action.path;
              const relativePath = relative(cwd, path);
              items.push({
                word: `${path}:`,
                display: `${relativePath}:`,
                action: {
                  path,
                },
                highlights: [
                  {
                    name: "path",
                    hl_group: hlGroupPath,
                    col: 1,
                    width: utf8Length(relativePath),
                  },
                ],
              });

              categories.add(path);
            }

            // Remove item path
            item.display = item.word.replace(/^([^:]+):(\d+):(\d+):/, " ");
            item.highlights = [
              {
                name: "word",
                hl_group: hlGroupWord,
                col: (item?.action?.col ?? 1) + 2,
                width: utf8Length(input),
              },
            ];
          }

          items.push(item);
          totalSize += 1;
        };

        try {
          for await (
            const line of abortable(
              iterLine(proc.stdout),
              abortController.signal,
            )
          ) {
            if (args.sourceParams.args.includes("--json")) {
              const ret = parseJson(line, cwd);
              if (ret && ret.word.length > 0) {
                pushItem(ret);
              }
            } else {
              const ret = parseLine(line, cwd, input);
              if (ret && ret.word.length > 0) {
                pushItem(ret);
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
          proc.kill("SIGTERM");

          if (e instanceof Error && e.name.includes("AbortReason")) {
            // Ignore AbortReason errors
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
      category: false,
      cmd: "rg",
      globs: [],
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
