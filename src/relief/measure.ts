import type { Image, Item } from "@owlbear-rodeo/sdk";
import type { TerrainZone } from "../terrain/terrain";
import { anchorOf, reliefSize, sceneToCell, type Anchor } from "./anchor";
import type { Relief } from "./relief";

// What's measured from the reliefs, wherever it's measured (the background
// page, the Distances panel, the token height picker): each map image that
// has one as a zone, all of it, at the relief's heights (on a slab, its top).

/** A map image: what a relief belongs to (edited even hidden; measured, see mapAnchors, only shown). */
export const isMapImage = (item: Item): item is Image => item.type === "IMAGE" && item.layer === "MAP";

/** The scene's visible map images, where they are (as the Vistazo takes them). */
export function mapAnchors(items: Item[]): Map<string, Anchor> {
  const anchors = new Map<string, Anchor>();
  for (const item of items) {
    if (isMapImage(item) && item.visible) {
      anchors.set(item.id, anchorOf(item as Image));
    }
  }
  return anchors;
}

/** The reliefs as terrain zones (see terrainAt), for a scene of `dpi` px a cell. */
export function reliefZones(reliefs: Map<string, Relief>, anchors: Map<string, Anchor>, dpi: number): TerrainZone[] {
  const zones: TerrainZone[] = [];
  for (const [id, relief] of reliefs) {
    const anchor = anchors.get(id);
    if (!anchor) {
      continue;
    }
    const [w, h] = reliefSize(anchor);
    const at = (point: { x: number; y: number }) => sceneToCell(anchor, dpi, point.x, point.y);
    zones.push({
      id: `relief:${id}`,
      height: 0,
      area: 0,
      contains: (point) => {
        const [x, y] = at(point);
        return x >= 0 && y >= 0 && x <= w && y <= h;
      },
      surface: (point) => {
        const [x, y] = at(point);
        return relief.slabAt(x, y)?.top ?? relief.evaluate(x, y);
      },
    });
  }
  return zones;
}
