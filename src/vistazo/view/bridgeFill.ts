import type { MultiPolygon } from "polygon-clipping";

// A bridge's fill (see VistazoView.buildUnderBridges) worked out from the map's pixels over its box:
// plain numbers in, plain numbers out, so it's worked out away from the page (see fillWorker).

/** A bridge's fill (see fillFromPixels): RGBA bytes, cols × rows, over a box (scene units: x, y, width, height). */
export type BridgeFill = { pixels: Uint8Array; cols: number; rows: number; box: [number, number, number, number] };

/**
 * What goes under a bridge in place of its drawing: over its box (`grow`
 * and a few texels wider; scene units), the map's colours; within `grow` of
 * its outline (and a texel and a half more, where its drawn edge is), those
 * round it run in and blended: averaged up a pyramid of halved grids till
 * every texel has some, then spread back down, each level filling what the
 * finer one lacked (pull-push). Its alpha: how much of the texel is within
 * `grow` of it (holes out), so it fades into the map over a texel.
 */
export function fillFromPixels(shape: MultiPolygon, bytes: Uint8ClampedArray, frame: { x0: number; y0: number; step: number; cols: number; rows: number }, grow: number): BridgeFill {
  const { x0, y0, step, cols, rows } = frame;
  // Its sides (round it and its holes) as ax, ay, and the way to b, four numbers each.
  const list: number[] = [];
  for (const ring of shape.flat()) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const [ex, ey] = [ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]];
      if (ex * ex + ey * ey > 1e-18) {
        list.push(ring[i][0], ring[i][1], ex, ey);
      }
    }
  }
  const sides = new Float64Array(list);
  // Each texel's middle inside or not (holes out): a row at a time, by where the sides cross it.
  const within = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const y = y0 + (r + 0.5) * step;
    const crossings: number[] = [];
    for (let k = 0; k < sides.length; k += 4) {
      const [ay, ey] = [sides[k + 1], sides[k + 3]];
      if (ay > y !== ay + ey > y) {
        crossings.push(sides[k] + ((y - ay) / ey) * sides[k + 2]);
      }
    }
    crossings.sort((a, b) => a - b);
    for (let c = 0, n = 0; c < cols; c++) {
      const x = x0 + (c + 0.5) * step;
      while (n < crossings.length && crossings[n] < x) {
        n++;
      }
      within[r * cols + c] = n % 2;
    }
  }
  // Only those near the outline need how near: the rest are well in or well out.
  const band = grow + step * 2.5;
  const near = new Uint8Array(cols * rows);
  for (let k = 0; k < sides.length; k += 4) {
    const [ax, ay, bx, by] = [sides[k], sides[k + 1], sides[k] + sides[k + 2], sides[k + 1] + sides[k + 3]];
    const [c0, c1] = [Math.max(0, Math.floor((Math.min(ax, bx) - band - x0) / step)), Math.min(cols - 1, Math.ceil((Math.max(ax, bx) + band - x0) / step))];
    const [r0, r1] = [Math.max(0, Math.floor((Math.min(ay, by) - band - y0) / step)), Math.min(rows - 1, Math.ceil((Math.max(ay, by) + band - y0) / step))];
    for (let r = r0; r <= r1; r++) {
      near.fill(1, r * cols + c0, r * cols + c1 + 1);
    }
  }
  /** How far texel i (its middle at x, y) is from the outline: less than 0 inside. */
  const reach = (i: number, x: number, y: number) => {
    if (!near[i]) {
      return within[i] ? -Infinity : Infinity;
    }
    let best = Infinity;
    for (let k = 0; k < sides.length; k += 4) {
      const [ax, ay, ex, ey] = [sides[k], sides[k + 1], sides[k + 2], sides[k + 3]];
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
      best = Math.min(best, (ax + ex * t - x) ** 2 + (ay + ey * t - y) ** 2);
    }
    return within[i] ? -Math.sqrt(best) : Math.sqrt(best);
  };
  // Level 0: each texel's colour (weighted) and how much it counts: the map's, away from the outline; none near it.
  const inside = new Float32Array(cols * rows);
  let level = { cols, rows, rgbw: new Float32Array(cols * rows * 4) };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const d = reach(i, x0 + (c + 0.5) * step, y0 + (r + 0.5) * step) - grow;
      inside[i] = Math.max(0, Math.min(1, 0.5 - d / step));
      const w = d > step * 1.5 && bytes[i * 4 + 3] >= 128 ? 1 : 0;
      // Written in place (no list a texel: tens of thousands of them a slab).
      const o = i * 4;
      level.rgbw[o] = bytes[o] * w;
      level.rgbw[o + 1] = bytes[o + 1] * w;
      level.rgbw[o + 2] = bytes[o + 2] * w;
      level.rgbw[o + 3] = w;
    }
  }
  // Pull: halved grids, each texel the weighted average of the (up to) four under it, counting at most fully.
  const levels = [level];
  while (level.cols > 1 || level.rows > 1) {
    const next = { cols: Math.ceil(level.cols / 2), rows: Math.ceil(level.rows / 2), rgbw: new Float32Array(Math.ceil(level.cols / 2) * Math.ceil(level.rows / 2) * 4) };
    for (let r = 0; r < level.rows; r++) {
      for (let c = 0; c < level.cols; c++) {
        const [from, to] = [(r * level.cols + c) * 4, ((r >> 1) * next.cols + (c >> 1)) * 4];
        for (let k = 0; k < 4; k++) {
          next.rgbw[to + k] += level.rgbw[from + k];
        }
      }
    }
    for (let i = 0; i < next.rgbw.length; i += 4) {
      const w = next.rgbw[i + 3];
      if (w > 1) {
        for (let k = 0; k < 4; k++) {
          next.rgbw[i + k] /= w;
        }
      }
    }
    levels.push(next);
    level = next;
  }
  // Push: what each level lacks taken from the coarser one, read between its texels (no blocks).
  for (let l = levels.length - 2; l >= 0; l--) {
    const [fine, coarse] = [levels[l], levels[l + 1]];
    const src = coarse.rgbw;
    // Colour as a share of what counted there (the coarsest have counted fully after their push).
    const v = (at: number, k: number) => (src[at + 3] > 0 ? src[at + k] / src[at + 3] : 0);
    for (let r = 0; r < fine.rows; r++) {
      // Read between the coarser grid's texels (its four round the point, weighted by how near).
      const cy = Math.max(0, Math.min(coarse.rows - 1, (r + 0.5) / 2 - 0.5));
      const iy = Math.floor(cy);
      const jy = Math.min(coarse.rows - 1, iy + 1);
      const fy = cy - iy;
      for (let c = 0; c < fine.cols; c++) {
        const i = (r * fine.cols + c) * 4;
        const w = fine.rgbw[i + 3];
        if (w >= 1) {
          continue;
        }
        const cx = Math.max(0, Math.min(coarse.cols - 1, (c + 0.5) / 2 - 0.5));
        const ix = Math.floor(cx);
        const jx = Math.min(coarse.cols - 1, ix + 1);
        const fx = cx - ix;
        const [a, b, d, e] = [(iy * coarse.cols + ix) * 4, (iy * coarse.cols + jx) * 4, (jy * coarse.cols + ix) * 4, (jy * coarse.cols + jx) * 4];
        for (let k = 0; k < 3; k++) {
          const value = (v(a, k) * (1 - fx) + v(b, k) * fx) * (1 - fy) + (v(d, k) * (1 - fx) + v(e, k) * fx) * fy;
          fine.rgbw[i + k] += (1 - w) * value;
        }
        fine.rgbw[i + 3] = 1;
      }
    }
  }
  const pixels = new Uint8Array(cols * rows * 4);
  for (let i = 0; i < cols * rows; i++) {
    for (let k = 0; k < 3; k++) {
      pixels[i * 4 + k] = Math.round(levels[0].rgbw[i * 4 + k]);
    }
    pixels[i * 4 + 3] = Math.round(inside[i] * 255);
  }
  return { pixels, cols, rows, box: [x0, y0, cols * step, rows * step] };
}

