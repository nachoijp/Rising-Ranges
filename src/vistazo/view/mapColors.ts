import { STONE } from "./types";

// The map's colours, read from small pictures of it (see VistazoView.loadColors): plain numbers, so the
// terrain can be worked out away from the page too (see terrainWorker). Where the map isn't, stone.

/** A picture's pixels (RGBA, row by row). */
export type Pixels = { data: Uint8ClampedArray; w: number; h: number };

/** The map over the scene's box (scene px): a small picture of it, and that drawn at four pixels a cell and blurred. */
export type MapColors = { x0: number; y0: number; w: number; h: number; small: Pixels; soft: Pixels };

/** The map's colour at a scene point: the small picture's nearest pixel. */
export function colorAt(c: MapColors, x: number, y: number): [number, number, number] {
  const { data, w: sw, h: sh } = c.small;
  const i = Math.max(0, Math.min(sw - 1, Math.round(((x - c.x0) / c.w) * sw)));
  const j = Math.max(0, Math.min(sh - 1, Math.round(((y - c.y0) / c.h) * sh)));
  const at = (j * sw + i) * 4;
  return data[at + 3] === 0 ? STONE : [data[at], data[at + 1], data[at + 2]];
}

/** The map's colour at a scene point, blurred: read between the soft picture's pixels, each by how much of the map it holds. */
export function softColorAt(c: MapColors, x: number, y: number): [number, number, number] {
  const { data, w: cw, h: ch } = c.soft;
  const fx = Math.max(0, Math.min(cw - 1, ((x - c.x0) / c.w) * cw - 0.5));
  const fy = Math.max(0, Math.min(ch - 1, ((y - c.y0) / c.h) * ch - 0.5));
  const [ix, iy] = [Math.floor(fx), Math.floor(fy)];
  const [jx, jy] = [Math.min(cw - 1, ix + 1), Math.min(ch - 1, iy + 1)];
  const [tx, ty] = [fx - ix, fy - iy];
  const out = [0, 0, 0];
  let weight = 0;
  for (const [cx, cy, k] of [[ix, iy, (1 - tx) * (1 - ty)], [jx, iy, tx * (1 - ty)], [ix, jy, (1 - tx) * ty], [jx, jy, tx * ty]]) {
    const at = (cy * cw + cx) * 4;
    const a = (data[at + 3] / 255) * k;
    out[0] += data[at] * a;
    out[1] += data[at + 1] * a;
    out[2] += data[at + 2] * a;
    weight += a;
  }
  return weight > 1e-6 ? [out[0] / weight, out[1] / weight, out[2] / weight] : STONE;
}

/** The soft picture (see MapColors) from the small one: four pixels a cell (`dpi`: a cell's size), blurred. On the page (a canvas). */
export function softPixels(small: HTMLCanvasElement, w: number, h: number, dpi: number): Pixels {
  const per = 4 / dpi;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.ceil(w * per));
  canvas.height = Math.max(2, Math.ceil(h * per));
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.filter = "blur(1.5px)";
  context.drawImage(small, 0, 0, canvas.width, canvas.height);
  return { data: context.getImageData(0, 0, canvas.width, canvas.height).data, w: canvas.width, h: canvas.height };
}
