import polygonClipping, { type Geom, type MultiPolygon } from "polygon-clipping";

// polygon-clipping, a little sturdier: with points nearly on top of each
// other (zones drawn edge to edge, a cut's output cut again) its rounding
// can leave a ring it can't close ("Unable to complete output ring"). Then
// it's asked again with every point snapped to a fine grid (a 256th of a
// px, then a 16th), which nearly always settles it; only if that fails too
// does the error get through, to whoever asked.

/** The grids tried after the shapes as they are, finest first (px). */
const SNAPS = [1 / 256, 1 / 16];

function snapped(geom: Geom, step: number): Geom {
  const round = (v: number) => Math.round(v / step) * step;
  const isPolygon = typeof geom[0]?.[0]?.[0] === "number";
  const polygons = (isPolygon ? [geom] : geom) as MultiPolygon;
  const out: MultiPolygon = polygons.map((polygon) => polygon.map((ring) => ring.map(([x, y]) => [round(x), round(y)] as [number, number])));
  return isPolygon ? out[0] : out;
}

function sturdy(op: (geom: Geom, ...geoms: Geom[]) => MultiPolygon) {
  return (geom: Geom, ...geoms: Geom[]): MultiPolygon => {
    try {
      return op(geom, ...geoms);
    } catch (error) {
      for (const step of SNAPS) {
        try {
          return op(snapped(geom, step), ...geoms.map((g) => snapped(g, step)));
        } catch {
          // The next, coarser grid.
        }
      }
      throw error;
    }
  };
}

const clip = {
  union: sturdy(polygonClipping.union),
  intersection: sturdy(polygonClipping.intersection),
  difference: sturdy(polygonClipping.difference),
  xor: sturdy(polygonClipping.xor),
};

export default clip;
