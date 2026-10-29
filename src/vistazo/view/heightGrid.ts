// The terrain's heights on a grid (see VistazoView.computeGrid): what hides tokens and the lines' sight,
// read quickly. Plain numbers, so it can be worked out away from the page too (see terrainWorker).

/** The most points the grid has: coarser on a very big map (what it's for doesn't need more). */
const MAX_GRID_POINTS = 200_000;

export type HeightGrid = { x0: number; y0: number; step: number; w: number; h: number; cells: Float32Array };

/** The heights (grid units; NaN off the map) every fifth of a cell over the scene's box, or coarser (see MAX_GRID_POINTS). */
export function heightGrid(bounds: { x0: number; y0: number; x1: number; y1: number }, dpi: number, heightAt: (x: number, y: number) => number | undefined): HeightGrid {
  const { x0, y0, x1, y1 } = bounds;
  const step = Math.max(dpi / 5, Math.sqrt(((x1 - x0) * (y1 - y0)) / MAX_GRID_POINTS));
  const w = Math.ceil((x1 - x0) / step) + 1;
  const h = Math.ceil((y1 - y0) / step) + 1;
  const cells = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      cells[j * w + i] = heightAt(x0 + i * step, y0 + j * step) ?? NaN;
    }
  }
  return { x0, y0, step, w, h, cells };
}
