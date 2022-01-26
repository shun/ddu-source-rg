import {
  BaseSource,
  Item,
} from "https://deno.land/x/ddu_vim@v0.2.4/types.ts";
import { Denops, fn } from "https://deno.land/x/ddu_vim@v0.2.4/deps.ts";

type DduRgParam = {
  input: string;
};

type Params = Record<DduRgParam, unknown>;

export class Source extends BaseSource<Params> {
  kind = "file";

  gather(args: {
    denops: Denops;
    sourceParams: Params;
  }): ReadableStream<Item<ActionData>[]> {
    const findby = async(input: string) => {
      const cwd = await fn.getcwd(args.denops) as string;
      const p = Deno.run({
        cmd: ["rg", "--column", "--no-heading", "--color", "never", input],
        stdout: "piped",
        stderr: "piped",
        stdin: "null",
        cwd: cwd,
      });

      const output = await p.output();
      const list = new TextDecoder().decode(output).split(/\r?\n/);
      const ret = list.map((e) => {
        const re = /^([^:]+):(\d+):(\d+):(.*)$/;
        const result = e.match(re);
        const get_param = (ary: string[], index: number) => {
          if (!ary) return "";
          if (!ary[index]) return "";
          return ary[index];
        };

        const path = get_param(result, 1);;
        const lineNr = get_param(result, 2);;
        const col = get_param(result, 3);;

        return {
          word: e,
          action: {
            path: path,
            lineNr: lineNr,
            col: col,
          },
        }
      });
      return ret;
    };

    return new ReadableStream({
      async start(controller) {
        controller.enqueue(
          await findby(args.sourceParams.input),
        );
        controller.close();
      },
    });
  }

  params(): Params {
    return {};
  }
}
