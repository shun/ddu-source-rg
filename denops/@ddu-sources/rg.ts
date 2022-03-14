import {
  BaseSource,
  DduOptions,
  Item,
} from "https://deno.land/x/ddu_vim@v1.2.0/types.ts";
import { Denops, fn } from "https://deno.land/x/ddu_vim@v1.2.0/deps.ts";
import { ActionData } from "https://deno.land/x/ddu_kind_file@v0.3.0/file.ts";
import { BufReader } from "https://deno.land/std@0.129.0/io/buffer.ts";
import { join } from "https://deno.land/std@0.129.0/path/mod.ts";
import { abortable } from "https://deno.land/std@0.129.0/async/mod.ts";
import { TextProtoReader } from "https://deno.land/std@0.129.0/textproto/mod.ts";

const enqueueSize1st = 1000;

type HighlightGroup = {
  path?: string;
  lineNr?: string;
  word?: string;
};

type Params = {
  args: string[];
  input: string;
  path: string;
  highlights?: HighlightGroup;
};

async function* iterLine(r: Deno.Reader): AsyncIterable<string> {
  const reader = new TextProtoReader(BufReader.create(r));
  while (true) {
    const line = await reader.readLine();
    if (!line) break;
    yield line;
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

    const hl_group_path = args.sourceParams.highlights?.path ?? "";
    const hl_group_lineNr = args.sourceParams.highlights?.lineNr ?? "";
    const hl_group_word = args.sourceParams.highlights?.word ?? "";

    const parse_json = (line: string, cwd: string) => {
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
          lineNr: lineNr,
          col: col + 1,
          text: text,
        },
        highlights: [
          {
            name: "path",
            "hl_group": hl_group_path,
            col: 1,
            width: path.length,
          },
          {
            name: "lineNr",
            "hl_group": hl_group_lineNr,
            col: path.length + 2,
            width: String(lineNr).length,
          },
          {
            name: "word",
            "hl_group": hl_group_word,
            col: header.length + col + 1,
            width: jo.data.submatches[0].end - col,
          },
        ],
      };
    };
    const re = /^([^:]+):(\d+):(\d+):(.*)$/;
    const parse_line = (line: string, cwd: string) => {
      line = line.trim();
      const result = line.match(re);
      const get_param = (ary: string[], index: number) => {
        return ary[index] ?? "";
      };

      const path = result ? get_param(result, 1) : "";
      const lineNr = result ? Number(get_param(result, 2)) : 0;
      const col = result ? Number(get_param(result, 3)) : 0;
      const text = result ? get_param(result, 4) : "";

      return {
        word: line,
        action: {
          path: join(cwd, path),
          lineNr: lineNr,
          col: col,
          text: text,
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
          cmd: cmd,
          stdout: "piped",
          stderr: "piped",
          stdin: "null",
          cwd: cwd,
        });

        try {
          for await (
            const line of abortable(
              iterLine(proc.stdout),
              abortController.signal,
            )
          ) {
            if (args.sourceParams.args.includes("--json")) {
              const ret = parse_json(line, cwd);
              if (ret) {
                items.push(ret);
              }
            } else {
              items.push(parse_line(line, cwd));
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
            if (!args.options.volatile || !mes.match(/regex parse error/)) {
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
    };
  }
}
