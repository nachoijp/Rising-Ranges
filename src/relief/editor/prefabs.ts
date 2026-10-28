import type { TranslationKey } from "../../i18n/translate";
import type { Pt, Shape } from "../types";
import type { ReliefEditor } from "./editor";
import type { IconName } from "./icons";
import { pickedGroup } from "./groups";
import { newVerts } from "./shapes";

// Shapes ready to put down (the Formas listas tool): a click puts one there,
// centred on it, at its own size and heights (relative to what's under it),
// to be changed after as any other.

export type PrefabId = "column" | "pit" | "stairs" | "platform" | "wall" | "mound";

export const PREFABS: { id: PrefabId; icon: IconName; label: TranslationKey; hint: TranslationKey }[] = [
  { id: "column", icon: "column", label: "relief.prefab.column", hint: "relief.prefab.columnHint" },
  { id: "pit", icon: "pit", label: "relief.prefab.pit", hint: "relief.prefab.pitHint" },
  { id: "stairs", icon: "stairs", label: "relief.prefab.stairs", hint: "relief.prefab.stairsHint" },
  { id: "platform", icon: "platform", label: "relief.prefab.platform", hint: "relief.prefab.platformHint" },
  { id: "wall", icon: "wall", label: "relief.prefab.wall", hint: "relief.prefab.wallHint" },
  { id: "mound", icon: "mound", label: "relief.prefab.mound", hint: "relief.prefab.moundHint" },
];

/** A piece of a prefab: its outline (cells, round its middle) and what it is. */
type Part = { ring: Pt[]; shape: Omit<Shape, "ring"> };

const circle = (r: number, n = 24): Pt[] => Array.from({ length: n }, (_, k): Pt => [r * Math.cos((k / n) * Math.PI * 2), r * Math.sin((k / n) * Math.PI * 2)]);
const box = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** A prefab's pieces, round (0, 0). */
function partsOf(id: PrefabId): Part[] {
  switch (id) {
    case "column":
      return [{ ring: circle(0.5, 16), shape: { kind: "flat", rel: true, h: 3 } }];
    case "pit":
      return [{ ring: circle(1), shape: { kind: "flat", rel: true, h: -2 } }];
    case "stairs":
      // Up from its foot (the bottom) to its top, four steps.
      return [{ ring: box(-1, -2, 1, 2), shape: { kind: "ramp", rel: true, h: 0, ramp: { a: [0, 2], b: [0, -2], from: 0, to: 2, steps: 4 } } }];
    case "platform":
      // Its top, and a ramp up to it from below.
      return [
        { ring: box(-2, -3, 2, 1), shape: { kind: "flat", rel: true, h: 2 } },
        { ring: box(-1, 1, 1, 4), shape: { kind: "ramp", rel: true, h: 0, ramp: { a: [0, 4], b: [0, 1], from: 0, to: 2, steps: 0 } } },
      ];
    case "wall":
      return [{ ring: box(-2, -0.25, 2, 0.25), shape: { kind: "flat", rel: true, h: 2 } }];
    case "mound":
      return [{ ring: circle(2), shape: { kind: "flat", rel: true, h: 1, soft: 1.5 } }];
  }
}

/** A prefab's outlines put at `at` (for the map to show where it'd go). */
export function prefabOutlines(id: PrefabId, at: { x: number; y: number }): Pt[][] {
  return partsOf(id).map((part) => part.ring.map(([x, y]): Pt => [x + at.x, y + at.y]));
}

/** A prefab put down at `at`: its shapes, the last ones of the relief, picked. */
export function placePrefab(ed: ReliefEditor, id: PrefabId, at: { x: number; y: number }) {
  const first = ed.data.shapes.length;
  // In the group of the shape picked, if it's in one.
  const group = pickedGroup(ed);
  for (const part of partsOf(id)) {
    const ring = part.ring.map(([x, y]): Pt => [x + at.x, y + at.y]);
    const shape: Shape = { ...part.shape, ring: newVerts(ed, ring), ...(group ? { group } : {}) };
    if (shape.ramp) {
      shape.ramp = { ...shape.ramp, a: [shape.ramp.a[0] + at.x, shape.ramp.a[1] + at.y], b: [shape.ramp.b[0] + at.x, shape.ramp.b[1] + at.y] };
    }
    ed.data.shapes.push(shape);
  }
  const added = Array.from({ length: ed.data.shapes.length - first }, (_, k) => first + k);
  ed.sel = { kind: "shape", i: added[0], ...(added.length > 1 ? { more: added.slice(1) } : {}) };
}
