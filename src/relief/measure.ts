import type { Image, Item } from "@owlbear-rodeo/sdk";
import type { TerrainZone } from "../terrain/terrain";
import { anchorOf, reliefSize, sceneToCell, type Anchor } from "./anchor";
import type { Relief } from "./relief";
import { stackCut } from "./doorCut";
import { owns, type Stacked } from "./stack";

// What's measured from the reliefs, wherever it's measured (the background
// page, the Distances panel, the token height picker): each map image that
// has one as a zone, at the relief's heights (on a slab, its top): all of it,
// or over another image's relief, only its own shapes (see stack.ts).

/** A map image: what a relief belongs to (edited even hidden; measured, see mapAnchors, only shown). */
export const isMapImage = (item: Item): item is Image => item.type === "IMAGE" && item.layer === "MAP";

/** The scene's visible map images, where they are (as the Vistazo takes them), the lowest first (as they lie). */
export function mapAnchors(items: Item[]): Map<string, Anchor> {
  const anchors = new Map<string, Anchor>();
  const maps = items.filter((item): item is Image => isMapImage(item) && item.visible).sort((a, b) => a.zIndex - b.zIndex);
  for (const item of maps) {
    anchors.set(item.id, anchorOf(item));
  }
  return anchors;
}

/**
 * The reliefs as terrain zones (see terrainAt), for a scene of `dpi` px a cell: the one on top first
 * (`anchors` the lowest first, see mapAnchors), each over those under it (see stack.ts) and, where it's
 * see-through, theirs.
 */
export function reliefZones(reliefs: Map<string, Relief>, anchors: Map<string, Anchor>, dpi: number): TerrainZone[] {
  const stack: Stacked[] = [...anchors].flatMap(([id, anchor]) => {
    const relief = reliefs.get(id);
    return relief ? [{ id, relief, anchor }] : [];
  });
  // Measured with every door a way through (see doorCut.ts).
  return [...stackCut(stack, dpi)].reverse().map((entry): TerrainZone => {
    const { relief, anchor } = entry;
    const [w, h] = reliefSize(anchor);
    const at = (point: { x: number; y: number }) => sceneToCell(anchor, dpi, point.x, point.y);
    // Its own slabs: not a doorway's lintel (the cut's, after them: see doorCut.ts), stood on by nobody.
    const own = relief.source.data.shapes.length;
    return {
      id: `relief:${entry.id}`,
      height: 0,
      area: 0,
      contains: (point) => {
        const [x, y] = at(point);
        return x >= 0 && y >= 0 && x <= w && y <= h && (owns(entry, dpi, point.x, point.y) !== null || !!relief.slabAt(x, y, own));
      },
      surface: (point) => {
        const [x, y] = at(point);
        return relief.slabAt(x, y, own)?.top ?? relief.evaluate(x, y);
      },
    };
  });
}
