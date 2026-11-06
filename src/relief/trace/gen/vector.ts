// Pixels to outlines and back: a mask's pieces as outlines with holes (along
// the pixels' edges, simplified), and outlines painted into a mask. All in
// cells of the map; `px` pixels a cell.

import type { Pt } from "../../types";

export type Loop = { ring: Pt[]; holes: Pt[][] };

/** A box of pixels: [x0, y0, x1, y1), the whole picture if none. */
export type PixBox = [number, number, number, number];

const area = (ring: Pt[]) => {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
};

export const ringArea = (ring: Pt[]) => Math.abs(area(ring));

function inRing(x: number, y: number, ring: Pt[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Douglas–Peucker on a closed ring. */
export function simplifyRing(pts: Pt[], tol: number): Pt[] {
  const n = pts.length;
  if (n <= 4) return pts;
  // Split at the point farthest from the first.
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const dp = (a: number, b: number) => {
    // a..b along the ring (b may wrap).
    const len = (b - a + n) % n;
    if (len < 2) return;
    const A = pts[a], B = pts[b];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const L = Math.hypot(dx, dy) || 1e-9;
    let worst = -1, at = -1;
    for (let k = 1; k < len; k++) {
      const i = (a + k) % n;
      const d = Math.abs((pts[i][0] - A[0]) * dy - (pts[i][1] - A[1]) * dx) / L;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol) {
      keep[at] = 1;
      dp(a, at);
      dp(at, b);
    }
  };
  dp(0, far);
  dp(far, 0);
  const out = pts.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : pts;
}

/**
 * The outlines of the mask's pixels inside `box`: each piece's outer outline
 * with its holes, simplified to `tol` cells; pieces and holes smaller than
 * `minArea` cells² left out.
 */
export function loopsOf(mask: Uint8Array, W: number, H: number, px: number, tol: number, minArea: number, box: PixBox = [0, 0, W, H]): Loop[] {
  const [bx0, by0, bx1, by1] = box;
  const on = (x: number, y: number) => x >= bx0 && y >= by0 && x < bx1 && y < by1 && mask[y * W + x] === 1;
  const CW = W + 1;
  // Edges with the inside on their right: from corner → to corner.
  const next = new Map<number, number[]>();
  const addEdge = (ax: number, ay: number, bx: number, by: number) => {
    const k = ay * CW + ax;
    const list = next.get(k);
    if (list) list.push(by * CW + bx);
    else next.set(k, [by * CW + bx]);
  };
  for (let y = by0; y < by1; y++)
    for (let x = bx0; x < bx1; x++) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!on(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!on(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!on(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  const loops: Pt[][] = [];
  for (const [start, list] of next) {
    while (list.length) {
      const pts: Pt[] = [];
      let from = start;
      let to = list.pop()!;
      let guard = 0;
      for (;;) {
        const fx = from % CW, fy = (from - fx) / CW;
        pts.push([fx / px, fy / px]);
        if (to === start || guard++ > 4 * W * H) break;
        const tx = to % CW, ty = (to - tx) / CW;
        const dx = tx - fx, dy = ty - fy;
        const outs = next.get(to);
        if (!outs || !outs.length) break;
        let pick = 0;
        if (outs.length > 1) {
          // Two ways on (pieces touching at a corner): the right turn, keeping them apart.
          const rx = -dy, ry = dx;
          const i = outs.findIndex((o) => {
            const ox = o % CW, oy = (o - ox) / CW;
            return ox - tx === rx && oy - ty === ry;
          });
          pick = i >= 0 ? i : 0;
        }
        from = to;
        to = outs.splice(pick, 1)[0];
      }
      if (pts.length >= 4) loops.push(pts);
    }
  }
  const outer: Loop[] = [];
  const holes: Pt[][] = [];
  for (const raw of loops) {
    const a = area(raw);
    if (Math.abs(a) < minArea) continue;
    const ring = simplifyRing(raw, tol);
    if (a > 0) outer.push({ ring, holes: [] });
    else holes.push(ring);
  }
  outer.sort((p, q) => ringArea(p.ring) - ringArea(q.ring));
  for (const h of holes) {
    // The smallest outline round it.
    const [x, y] = h[0];
    const around = outer.find((o) => inRing(x + 1e-4, y + 1e-4, o.ring) || inRing(x - 1e-4, y - 1e-4, o.ring));
    if (around) around.holes.push(h);
  }
  return outer;
}

/** Outlines (each its outer ring, then holes) painted into a mask with `value`. */
export function paintRings(mask: Uint8Array | Int32Array, W: number, H: number, px: number, rings: Pt[][], value: number) {
  if (!rings.length || rings[0].length < 3) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of rings[0]) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const X0 = Math.max(0, Math.floor(x0 * px)), Y0 = Math.max(0, Math.floor(y0 * px));
  const X1 = Math.min(W, Math.ceil(x1 * px)), Y1 = Math.min(H, Math.ceil(y1 * px));
  for (let y = Y0; y < Y1; y++) {
    const cy = (y + 0.5) / px;
    // Crossings of this row with every ring: even-odd fill.
    const xs: number[] = [];
    for (const ring of rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (yi > cy !== yj > cy) xs.push(((xj - xi) * (cy - yi)) / (yj - yi) + xi);
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(X0, Math.ceil(xs[k] * px - 0.5)), b = Math.min(X1 - 1, Math.floor(xs[k + 1] * px - 0.5));
      for (let x = a; x <= b; x++) mask[y * W + x] = value;
    }
  }
}
