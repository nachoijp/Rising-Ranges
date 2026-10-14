import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import type { TerrainShape } from "./terrain";

// The terrain drawn as cut paper (see terrainView.ts): what of each zone
// shows, by the measuring rule — where zones overlap the smallest wins
// (terrain.ts) — so what's drawn is what's measured.
//
// Each layer is drawn from the lowest up: first its shadow (its own shape,
// darker, moved away from the light), then its fill. A layer higher than
// what's under it so casts its shadow outward on lower ground; one with a
// lower zone inside it (a pit) is a shape with a hole, and its shadow falls
// into the hole along the edge facing the light, as the pit's rim would.
// A pit in the bare ground has no such layer around it: the ground isn't
// drawn, so its rim's shadow is drawn on its own (`rim`): the pits minus
// every zone moved away from the light — nothing, where a pit's
// surroundings are another zone, whose own shadow does it.

export type TerrainLayer = {
  height: number;
  shape: MultiPolygon;
  /** The zone it's of (not the ground's rim): what it's drawn attached to, so it follows a drag. */
  zoneId?: string;
  /** Every pit, at the bare ground's level: only the ground's rim shadow inside them is drawn. */
  rim?: boolean;
  /** With `rim`: every zone, whose moved copy the rim shadow is cut from. */
  cover?: MultiPolygon;
};

/** A zone's own outlines as one shape: a path's outlines even-odd, so an inner one is a hole. */
function zoneShape(shape: TerrainShape): MultiPolygon {
  const polygons: Polygon[] = shape.rings.map((ring) => [ring]);
  return polygons.length === 1 ? [polygons[0]] : polygonClipping.xor(polygons[0], ...polygons.slice(1));
}

/** The layers to draw, lowest first. `shapes` are the zones, the one that wins first (terrainShapes). */
export function terrainLayers(shapes: TerrainShape[]): TerrainLayer[] {
  // One per zone, so each follows its own zone when it's dragged (zones at
  // one height don't shade each other: see the view's shadows).
  const layers: TerrainLayer[] = [];
  let covered: MultiPolygon = [];
  for (const shape of shapes) {
    const own = zoneShape(shape);
    // What of it isn't already a smaller zone's.
    const visible = covered.length > 0 ? polygonClipping.difference(own, covered) : own;
    covered = covered.length > 0 ? polygonClipping.union(covered, own) : own;
    if (visible.length === 0) {
      continue;
    }
    layers.push({ height: shape.height, shape: visible, zoneId: shape.id });
  }
  if (layers.some((layer) => layer.height < 0)) {
    const pits = layers.filter((layer) => layer.height < 0).map((layer) => layer.shape);
    const sunk = pits.length === 1 ? pits[0] : polygonClipping.union(pits[0], ...pits.slice(1));
    layers.push({ height: 0, shape: sunk, rim: true, cover: covered });
  }
  // The ground's rim right after the pits, before anything at its level or above.
  return layers.sort((a, b) => a.height - b.height || Number(b.rim ?? false) - Number(a.rim ?? false));
}
