import { generate, type GenNames, type GenOptions, type GenStage } from "../trace/gen/generate";
import type { Picture, Uvtt } from "../trace/uvtt";
import type { ReliefData } from "../types";

// "Generar relieve" away from the page (see generateDialog.ts): the work takes
// a second or more, and the editor goes on answering meanwhile. The names
// come as templates ("{n}", "{h}"), functions can't be sent.

export type GenTemplates = Record<Exclude<keyof GenNames, "room" | "wall" | "hedge" | "object" | "stair" | "level" | "pond" | "tree" | "bush" | "cliff">, string> &
  Record<"room" | "wall" | "hedge" | "object" | "stair" | "level" | "pond" | "tree" | "bush" | "cliff", string>;

export type GenRequest = { pic: Picture; uvtt: Uvtt | null; base: ReliefData; names: GenTemplates; options: GenOptions };
export type GenReply = { kind: "stage"; stage: GenStage } | { kind: "done"; data: ReliefData; counts: ReturnType<typeof generate>["counts"] } | { kind: "error"; message: string };

const fill = (template: string) => (n: number) => template.replace("{n}", String(n)).replace("{h}", String(n));

self.onmessage = (event: MessageEvent<GenRequest>) => {
  const { pic, uvtt, base, names: t, options } = event.data;
  const post = (reply: GenReply) => (self as unknown as Worker).postMessage(reply);
  try {
    const names: GenNames = {
      ...t,
      room: fill(t.room),
      wall: fill(t.wall),
      hedge: fill(t.hedge),
      object: fill(t.object),
      stair: fill(t.stair),
      level: fill(t.level),
      pond: fill(t.pond),
      tree: fill(t.tree),
      bush: fill(t.bush),
      cliff: fill(t.cliff),
    };
    const { data, counts } = generate(pic, uvtt, base, names, options, (stage) => post({ kind: "stage", stage }));
    post({ kind: "done", data, counts });
  } catch (error) {
    post({ kind: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
