import type { MultiPolygon } from "polygon-clipping";
import { bridgeTop, inShape, type Bridge, type VistazoScene } from "../scene";

// What's under a bridge, as numbers (see VistazoView.buildUnderBridges, which draws it): the box its
// fill covers, and its underside's heights over it. Plain arrays, so they can be worked out away from
// the page too (see terrainWorker).

/** The longest side of a bridge's fill (see bridgeFill), texels. */
export const FILL_SIZE = 192;
/** How far past a bridge's outline its fill reaches (cells): over its drawn edge, which the outline seldom follows exactly. */
export const FILL_GROW = 0.15;
/** A bridge's underside's texels for each cell (at most its fill's): a small one (a statue's arm) takes a few, not FILL_SIZE². */
const UNDER_PER_CELL = 8;

/** The texels a bridge's fill takes (scene px): over its outline's box, `grow` and four texels wider, its longest side FILL_SIZE. */
export function fillFrame(shape: MultiPolygon, grow: number): { x0: number; y0: number; step: number; cols: number; rows: number } {
  const points = shape.flat(2);
  const [sx0, sx1] = [Math.min(...points.map((p) => p[0])) - grow, Math.max(...points.map((p) => p[0])) + grow];
  const [sy0, sy1] = [Math.min(...points.map((p) => p[1])) - grow, Math.max(...points.map((p) => p[1])) + grow];
  const step = Math.max(1e-6, sx1 - sx0, sy1 - sy0) / (FILL_SIZE - 8);
  const [x0, y0] = [sx0 - step * 4, sy0 - step * 4];
  const [cols, rows] = [Math.ceil((sx1 - sx0) / step) + 8, Math.ceil((sy1 - sy0) / step) + 8];
  return { x0, y0, step, cols, rows };
}

/** Whether a scene point is within `reach` of an outline's sides (holes' too). */
export function nearOutline(multi: MultiPolygon, x: number, y: number, reach: number): boolean {
  for (const ring of multi.flat()) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const [ax, ay] = ring[i];
      const [ex, ey] = [ring[i + 1][0] - ax, ring[i + 1][1] - ay];
      const len2 = ex * ex + ey * ey;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / len2)) : 0;
      if ((ax + ex * t - x) ** 2 + (ay + ey * t - y) ** 2 < reach * reach) {
        return true;
      }
    }
  }
  return false;
}

/**
 * A bridge's underside over its fill's box (see fillFrame), RGBA texels: its height (view units, `k`
 * per height unit; r), and where a shape keeping its look is (g: 1 inside, 0.5 just round it, for its
 * walls). One texel if it's flat with none of those under it; else UNDER_PER_CELL a cell (its fill's at most).
 */
export function undersideBuffers(scene: VistazoScene, bridge: Bridge, k: number): { cols: number; rows: number; heights: Float32Array } {
  const frame = fillFrame(bridge.shape, scene.dpi * FILL_GROW);
  const area = { x: frame.x0, y: frame.y0, z: frame.cols * frame.step, w: frame.rows * frame.step };
  const thick = bridge.top - bridge.bottom;
  const reach = scene.dpi * 0.12;
  // Each with its box (and reach round it): a texel outside it isn't tested against its outline.
  const keeping = (scene.unfilled ?? []).flatMap((multi) => {
    const ps = multi.flat(2);
    const [x0, x1] = [Math.min(...ps.map(([x]) => x)) - reach, Math.max(...ps.map(([x]) => x)) + reach];
    const [y0, y1] = [Math.min(...ps.map(([, y]) => y)) - reach, Math.max(...ps.map(([, y]) => y)) + reach];
    return x1 >= area.x && x0 <= area.x + area.z && y1 >= area.y && y0 <= area.y + area.w ? [{ multi, x0, x1, y0, y1 }] : [];
  });
  // Over the same box as its fill (read texel by texel: nearest), as many as its size asks.
  const [cols, rows] =
    bridge.surface || keeping.length > 0
      ? [Math.min(frame.cols, Math.max(2, Math.ceil((area.z / scene.dpi) * UNDER_PER_CELL))), Math.min(frame.rows, Math.max(2, Math.ceil((area.w / scene.dpi) * UNDER_PER_CELL)))]
      : [1, 1];
  const heights = new Float32Array(cols * rows * 4);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [x, y] = [area.x + ((c + 0.5) / cols) * area.z, area.y + ((r + 0.5) / rows) * area.w];
      heights[(r * cols + c) * 4] = (bridgeTop(bridge, x, y) - thick) * k;
      // Inside: all of it (its top); just round it: only its walls (the ground there gets the fill).
      const near = keeping.filter((e) => x >= e.x0 && x <= e.x1 && y >= e.y0 && y <= e.y1);
      heights[(r * cols + c) * 4 + 1] = near.some((e) => inShape(x, y, e.multi)) ? 1 : near.some((e) => nearOutline(e.multi, x, y, reach)) ? 0.5 : 0;
    }
  }
  return { cols, rows, heights };
}
