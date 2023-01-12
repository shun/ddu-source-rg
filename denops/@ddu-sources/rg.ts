import {
  BaseSource,
  DduOptions,
  Item,
} from "https://deno.land/x/ddu_vim@v2.2.0/types.ts";
import { Denops, fn } from "https://deno.land/x/ddu_vim@v2.2.0/deps.ts";
import { ActionData } from "https://deno.land/x/ddu_kind_file@v0.3.2/file.ts";
import { join } from "https://deno.land/std@0.171.0/path/mod.ts";
import { abortable } from "https://deno.land/std@0.171.0/async/mod.ts";
import { TextLineStream } from "https://deno.land/std@0.171.0/streams/mod.ts";

const enqueueSize1st = 1000;

type HighlightGroup = {
  path: string;
  lineNr: string;
  word: string;
};

type Params = {
  args: string[];
  input: string;
  path: string;
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

export class Source extends BaseSource<Params> {
  kind = "file";

  gather(args: {
    denops: Denops;
    options: DduOptions;
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
      const text = jo.data.lines.text?.replace("\n", "");
      const header = `${path}:${lineNr}:${col}: `;
      return {
        word: header + text,
        action: {
          path: join(cwd, path),
          lineNr,
          col: col + 1,
          text,
        },
        highlights: [
          {
            name: "path",
            "hl_group": hlGroupPath,
            col: 1,
            width: path.length,
          },
          {
            name: "lineNr",
            "hl_group": hlGroupLineNr,
            col: path.length + 2,
            width: String(lineNr).length,
          },
          {
            name: "word",
            "hl_group": hlGroupWord,
            col: header.length + col + 1,
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

      return {
        word: text,
        display: line,
        action: {
          path: join(cwd, path),
          lineNr,
          col,
          text,
        },
      };
    };

    return new ReadableStream({
      async start(controller) {
        const input = args.options.volatile
          ? args.input
          : args.sourceParams.input;

        if (input == "") {
          controller.close();
          return;
        }

        const cmd = ["rg", ...args.sourceParams.args, input];
        const cwd = args.sourceParams.path != ""
          ? args.sourceParams.path
          : await fn.getcwd(args.denops) as string;

        let items: Item<ActionData>[] = [];
        const enqueueSize2nd = 100000;
        let enqueueSize = enqueueSize1st;
        let numChunks = 0;

        const proc = Deno.run({
          cmd,
          stdout: "piped",
          stderr: "piped",
          stdin: "null",
          cwd,
        });

        try {
          for await (
            const line of abortable(
              iterLine(proc.stdout.readable),
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
          const [status, stderr] = await Promise.all([
            proc.status(),
            proc.stderrOutput(),
          ]);
          proc.close();
          if (!status.success) {
            const mes = new TextDecoder().decode(stderr);
            if (mes.length > 0 && (!args.options.volatile ||
                                   !mes.match(/regex parse error/))) {
              console.error(mes);
            }
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
      input: "",
      path: "",
      highlights: {
        path: "Normal",
        lineNr: "Normal",
        word: "Search",
      },
    };
  }
}
