import { cellToScene, sceneToCell, type Anchor } from "./anchor";
import type { Relief } from "./relief";

// Map images with reliefs over one another (a prop with its own relief on the map's): each one's
// ground, where it has none of its own (see Relief.clear), is the terrain of those under it, so its
// shapes stand on that (a pillar on the stands), instead of its picture's box carving everything there
// down to 0. Worked out the same wherever reliefs are drawn or measured (the Vistazo, measure.ts).

/** One map image's relief and where it is, in a stack (the lowest first, as the images lie). */
export type Stacked = { id: string; relief: Relief; anchor: Anchor };

/** Each Relief object's own number (a relief replaced by another is another, whatever its version). */
const ids = new WeakMap<Relief, number>();
let lastId = 0;
const idOf = (relief: Relief) => {
  let id = ids.get(relief);
  if (id === undefined) {
    ids.set(relief, (id = ++lastId));
  }
  return id;
};

/** Each relief's ground set to the terrain of those under it (the lowest's left as it is). */
export function stackReliefs(stack: Stacked[], dpi: number) {
  stack.forEach(({ relief, anchor }, i) => {
    const below = stack.slice(0, i);
    const key = i === 0 ? "" : JSON.stringify([anchor, dpi, below.map((b) => [b.id, idOf(b.relief), b.relief.version, b.anchor])]);
    relief.setUnder(i === 0 ? null : (cx, cy) => {
      const p = cellToScene(anchor, dpi, cx, cy);
      return terrainIn(below, dpi, p.x, p.y) ?? 0;
    }, key);
  });
}

/** Whether a relief has a point of the scene (px) as its own: on its image, and not where it's see-through. */
export function owns(entry: Stacked, dpi: number, x: number, y: number): [number, number] | null {
  const [cx, cy] = sceneToCell(entry.anchor, dpi, x, y);
  const { relief } = entry;
  if (cx < 0 || cy < 0 || cx > relief.data.w || cy > relief.data.h) {
    return null;
  }
  return relief.seeThrough && !relief.covered(cx, cy) ? null : [cx, cy];
}

/** The terrain at a scene point (px) of a stack's reliefs: the highest that has it as its own. */
export function terrainIn(stack: Stacked[], dpi: number, x: number, y: number): number | undefined {
  for (let j = stack.length - 1; j >= 0; j--) {
    const at = owns(stack[j], dpi, x, y);
    if (at) {
      return stack[j].relief.evaluate(at[0], at[1]);
    }
  }
  return undefined;
}
