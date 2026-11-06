import { planInSquares, uvttRelief, type Picture, type UvttCounts } from "../trace/uvtt";
import type { FogPlan } from "../trace/fogPlan";
import type { ReliefData } from "../types";

// "Convertir niebla en relieve" away from the page (see generateDialog.ts):
// measuring the walls on the map's picture takes a moment, and the editor goes
// on answering meanwhile. The names come as templates ("{n}"): functions
// can't be sent.

// Only types leave this file: importing a value from it would run it in the page (its onmessage on the window).
export type GenStage = "walls" | "stairs" | "shapes";

export type GenTemplates = Record<"group" | "rooms" | "walls" | "hedges" | "objects" | "stairs" | "solids" | "room" | "wall" | "hedge" | "object" | "stair" | "solid", string>;

export type GenRequest = {
  pic: Picture;
  plan: Pick<FogPlan, "walls" | "portals" | "openings" | "rooms">;
  base: ReliefData;
  names: GenTemplates;
  /** The scene's squares a cell of the relief takes (a map scaled up: more than one); the work is done in squares. */
  unit: number;
  options: { wallH: number; stairs: boolean };
};
export type GenReply = { kind: "stage"; stage: GenStage } | { kind: "done"; data: ReliefData; counts: UvttCounts } | { kind: "error"; message: string };

const fill = (template: string) => (n: number) => template.replace("{n}", String(n));

self.onmessage = (event: MessageEvent<GenRequest>) => {
  const { pic: cellPic, plan: lines, base, names: t, options, unit: u } = event.data;
  const post = (reply: GenReply) => (self as unknown as Worker).postMessage(reply);
  try {
    const plan = planInSquares(lines, cellPic, u, options.stairs, (stage) => post({ kind: "stage", stage }));
    post({ kind: "stage", stage: "shapes" });
    const { data, counts } = uvttRelief(plan, base, {
      ...t,
      room: fill(t.room),
      wall: fill(t.wall),
      hedge: fill(t.hedge),
      object: fill(t.object),
      stair: fill(t.stair),
      solid: fill(t.solid),
    }, { wallH: options.wallH });
    post({ kind: "done", data, counts });
  } catch (error) {
    post({ kind: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
