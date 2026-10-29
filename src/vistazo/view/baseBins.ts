import { VIEW_CELL } from "./types";

// The tokens' (and props') bases painted on the terrain (see VistazoView.paintBases, BASE_GLSL), as one
// float texture the shader reads: as many as there are, each pixel testing only those near it. The
// terrain's box is cut into bins; each bin lists the bases that reach into it.

/** A texture row's texels. */
export const BASE_TEX_WIDTH = 256;
/** The most bins along a side (bigger bins on a bigger terrain). */
const MOST_BINS = 64;
/** How far past its radius a base is listed in the bins round it (view units): its edge's smoothing, seen from afar. */
const MARGIN = VIEW_CELL * 0.5;

/** A base: where it is (view units), its radius (negative: no ring), the ground it stands on. */
export type PaintedBase = { x: number; y: number; r: number; z: number };

/**
 * The bases and their bins, as RGBA texels in rows of BASE_TEX_WIDTH: the bases first (x, y, r, z),
 * then each bin (where its list starts, how many), then the lists (a base's texel, in r). `bins`: the
 * bins' corner, size and how many across and down (view units), over `box` (x0, y0, x1, y1).
 */
export function binBases(bases: PaintedBase[], box: { x0: number; y0: number; x1: number; y1: number }): { data: Float32Array; rows: number; bins: [number, number, number, number]; down: number } {
  const span = Math.max(box.x1 - box.x0, box.y1 - box.y0, 1e-6);
  const size = Math.max(VIEW_CELL * 2, span / MOST_BINS);
  const cols = Math.max(1, Math.ceil((box.x1 - box.x0) / size));
  const down = Math.max(1, Math.ceil((box.y1 - box.y0) / size));
  const lists: number[][] = Array.from({ length: cols * down }, () => []);
  bases.forEach((base, i) => {
    const reach = Math.abs(base.r) + MARGIN;
    const c0 = Math.max(0, Math.floor((base.x - reach - box.x0) / size));
    const c1 = Math.min(cols - 1, Math.floor((base.x + reach - box.x0) / size));
    const r0 = Math.max(0, Math.floor((base.y - reach - box.y0) / size));
    const r1 = Math.min(down - 1, Math.floor((base.y + reach - box.y0) / size));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        lists[r * cols + c].push(i);
      }
    }
  });
  const entries = lists.reduce((sum, list) => sum + list.length, 0);
  const texels = bases.length + lists.length + entries;
  const rows = Math.max(1, Math.ceil(texels / BASE_TEX_WIDTH));
  const data = new Float32Array(rows * BASE_TEX_WIDTH * 4);
  bases.forEach((base, i) => data.set([base.x, base.y, base.r, base.z], i * 4));
  let at = bases.length + lists.length;
  lists.forEach((list, b) => {
    data.set([at, list.length], (bases.length + b) * 4);
    for (const i of list) {
      data[at * 4] = i;
      at++;
    }
  });
  return { data, rows, bins: [box.x0, box.y0, size, cols], down };
}
