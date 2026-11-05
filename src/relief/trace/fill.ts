// "Rellenar superficies": every rough mark is a seed of a surface, and the
// seeds share the map out between them. Each spreads over the picture, paying
// little across even ground and a lot across the lines the picture draws (a
// wall's face, a cliff's edge); each pixel goes to the seed that reaches it
// cheapest. So a room's seed takes its whole floor, the furniture on it
// included, and stops at its walls, where the wall's own seed takes over.
//
// A seed is only the core of its mark (the mark shrunk; a narrow one, its
// middle line), so a mark that spills past a wall loses what spilled.

import type { Pt } from "../types";
import type { Prepared } from "./snap";
import { simplifyClosed } from "./snap";

export type FillOptions = {
  /** Cells a wide mark is shrunk by to make its seed. */
  core?: number;
  /** How much a picture's line costs to cross, against plain ground. */
  lines?: number;
  /** How much a colour unlike the seed's costs to spread into, against plain ground. */
  color?: number;
  /** A mark narrower than this (cells, half its width) is a stroke: a wall. */
  narrow?: number;
  /** How far (cells) a stroke may spread past its mark. */
  reach?: number;
  /** How far (cells) to each side a line's two sides are compared. */
  side?: number;
  /** Radius (cells) of the majority smoothing of the result. */
  settle?: number;
  /** Cells an outline may stray from the result when simplified. */
  tolerance?: number;
  /** Marks whose surface is already known (fitted walls): taken as they are, the others fill round them. */
  fixed?: (Pt[] | null)[];
};

export type FillResult = {
  /** Per pixel: the index of the mark it went to (−1: none). */
  labels: Int32Array;
  /** Per mark: its outline, in cells (null: it got nothing). */
  rings: (Pt[] | null)[];
};

/** Which pixels each ring covers (pixel centres), as one list of masks. */
function rasterize(img: Prepared, ring: Pt[]): Uint8Array {
  const { w, h, px } = img;
  const mask = new Uint8Array(w * h);
  const ys = ring.map((p) => p[1] * px);
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
      const pay = ay * px, pby = by * px;
      if ((pay > cy) !== (pby > cy)) xs.push((ax + ((cy - pay) / (pby - pay)) * (bx - ax)) * px);
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = a; x <= b; x++) mask[y * w + x] = 1;
    }
  }
  return mask;
}

/** Distance (pixels) from each pixel of a mask to its outside (chamfer 3-4). */
function inward(mask: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  const INF = 1e9;
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  for (let i = 0; i < w * h; i++) d[i] /= 3;
  return d;
}

/** A min-heap of pixel indices by cost. */
class Heap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;
  constructor(cap: number) {
    this.keys = new Float64Array(cap);
    this.vals = new Int32Array(cap);
  }
  push(k: number, v: number) {
    if (this.size === this.keys.length) {
      const nk = new Float64Array(this.size * 2), nv = new Int32Array(this.size * 2);
      nk.set(this.keys); nv.set(this.vals);
      this.keys = nk; this.vals = nv;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= k) break;
      this.keys[i] = this.keys[p]; this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = k; this.vals[i] = v;
  }
  /** Pops the smallest: its value; its key in `this.top`. */
  top = 0;
  pop(): number {
    const v = this.vals[0];
    this.top = this.keys[0];
    const k = this.keys[--this.size], last = this.vals[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= k) break;
      this.keys[i] = this.keys[c]; this.vals[i] = this.vals[c];
      i = c;
    }
    this.keys[i] = k; this.vals[i] = last;
    return v;
  }
}

/** The marks' surfaces. Where cores overlap, the smaller mark's seed wins. */
export function fillSurfaces(img: Prepared, rings: Pt[][], opts: FillOptions = {}): FillResult {
  const { w, h, px, grad } = img;
  const n = w * h;
  const core = (opts.core ?? 0.75) * px;
  const labels = new Int32Array(n).fill(-1);
  const area = new Float64Array(rings.length);
  // A narrow mark (a stroke: a wall) only settles onto the line it's drawn
  // along: it may reach `reach` cells past its mark, no further.
  const NARROW = (opts.narrow ?? 0.6) * px, REACH = (opts.reach ?? 0.3) * px;
  const allowed = new Map<number, Uint8Array>();
  // Seeds: each mark's core; a narrow mark's (its widest inner distance under
  // 1.4 × core) is its middle: what's at least 70% of that widest distance.
  const fixed = opts.fixed ?? [];
  rings.forEach((ring, m) => {
    if (ring.length < 3 || fixed[m]) return;
    const mask = rasterize(img, ring);
    const d = inward(mask, w, h);
    let max = 0;
    for (let i = 0; i < n; i++) if (d[i] > max) max = d[i];
    const cut = Math.min(core, max * 0.7);
    let size = 0;
    for (let i = 0; i < n; i++) size += mask[i];
    area[m] = size;
    // Where cores overlap, the smaller mark wins: a mark inside another is a thing on it (a statue in a court).
    for (let i = 0; i < n; i++) if (mask[i] && d[i] >= cut && (labels[i] < 0 || size < area[labels[i]])) labels[i] = m;
    if (max < NARROW) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = mask[i] ? 0 : 1;
      const far = inward(out, w, h); // distance from the mark, outside it
      const ok = new Uint8Array(n);
      for (let i = 0; i < n; i++) ok[i] = far[i] <= REACH ? 1 : 0;
      allowed.set(m, ok);
    }
  });
  // Known surfaces: all theirs, from the start, and no more.
  fixed.forEach((ring, m) => {
    if (!ring) return;
    const mask = rasterize(img, ring);
    for (let i = 0; i < n; i++) if (mask[i]) labels[i] = m;
    allowed.set(m, mask);
  });
  // Each seed's colours (a few of its pixels, spread out): spreading into colours unlike them costs.
  const K = 12;
  const lab = img.lab;
  const models = rings.map(() => [] as number[]);
  const counts = new Int32Array(rings.length);
  for (let i = 0; i < n; i++) if (labels[i] >= 0) counts[labels[i]]++;
  const seen = new Int32Array(rings.length);
  for (let i = 0; i < n; i++) {
    const m = labels[i];
    if (m < 0) continue;
    const every = Math.max(1, Math.floor(counts[m] / K));
    if (seen[m]++ % every === 0 && models[m].length < K * 3) models[m].push(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]);
  }
  const COLOR = opts.color ?? 6;
  const unlike = (j: number, m: number) => {
    const md = models[m];
    let best = Infinity;
    for (let k = 0; k < md.length; k += 3) {
      const dl = lab[j * 3] - md[k], da = lab[j * 3 + 1] - md[k + 1], db = lab[j * 3 + 2] - md[k + 2];
      const dd = dl * dl + da * da + db * db;
      if (dd < best) best = dd;
    }
    return COLOR * Math.min(1, best / (25 * 25));
  };
  // A line's cost. A line is a border only if what's on its two sides differs
  // (`twoSided`): a rug's trim, the joints between tiles, an ornament have the
  // same on both sides, and don't stop a surface. The fine gradient only says
  // where, along such a border, the line itself is.
  const sides = twoSided(img, Math.max(2, Math.round((opts.side ?? 0.25) * px)));
  const p90 = (a: Float32Array) => Float32Array.from(a).sort()[Math.floor(n * 0.9)] || 1;
  const s90 = p90(sides), g90 = p90(grad);
  const LINES = opts.lines ?? 30;
  const step = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = sides[i] / s90;
    step[i] = 1 + LINES * t * t * (0.3 + 0.7 * Math.min(1, grad[i] / g90));
  }
  // Every seed spreads at once (Dijkstra from all of them).
  const cost = new Float64Array(n).fill(Infinity);
  const heap = new Heap(n);
  for (let i = 0; i < n; i++) if (labels[i] >= 0) { cost[i] = 0; heap.push(0, i); }
  const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
  const DL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
  while (heap.size) {
    const i = heap.pop();
    const c = heap.top;
    if (c > cost[i]) continue;
    const x = i % w, y = (i - x) / w;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k], ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (cost[j] <= c) continue;
      const fence = allowed.get(labels[i]);
      if (fence && !fence[j]) continue;
      const nc = c + DL[k] * (0.5 * (step[i] + step[j]) + unlike(j, labels[i]));
      if (nc < cost[j]) {
        cost[j] = nc;
        labels[j] = labels[i];
        heap.push(nc, j);
      }
    }
  }
  const settled = majority(labels, w, h, Math.max(1, Math.round((opts.settle ?? 0.2) * px)));
  // Known surfaces keep their own outlines; the smoothing doesn't move them.
  for (let i = 0; i < n; i++) if (labels[i] >= 0 && fixed[labels[i]]) settled[i] = labels[i];
  return { labels: settled, rings: rings.map((_, m) => fixed[m] ?? outline(settled, w, h, m, px, opts.tolerance ?? 0.2)) };
}

/**
 * How different the picture is a little to either side of each pixel (`r`
 * pixels away), across the direction where it differs most: Lab distance.
 */
function twoSided(img: Prepared, r: number): Float32Array {
  const { w, h, lab } = img;
  const out = new Float32Array(w * h);
  const d = Math.round(r / Math.SQRT2);
  const dirs = [[r, 0], [0, r], [d, d], [d, -d]];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let best = 0;
      for (const [dx, dy] of dirs) {
        const ax = Math.min(w - 1, Math.max(0, x + dx)), ay = Math.min(h - 1, Math.max(0, y + dy));
        const bx = Math.min(w - 1, Math.max(0, x - dx)), by = Math.min(h - 1, Math.max(0, y - dy));
        const a = (ay * w + ax) * 3, b = (by * w + bx) * 3;
        const dl = lab[a] - lab[b], da = lab[a + 1] - lab[b + 1], db = lab[a + 2] - lab[b + 2];
        const v = dl * dl + da * da + db * db;
        if (v > best) best = v;
      }
      out[y * w + x] = Math.sqrt(best);
    }
  return out;
}

/** Each pixel takes the label most of its neighbours (within `r`) have: no teeth, no specks. */
function majority(labels: Int32Array, w: number, h: number, r: number): Int32Array {
  const out = new Int32Array(labels.length);
  const ids: number[] = [], counts: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      ids.length = counts.length = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || dx * dx + dy * dy > r * r) continue;
          const m = labels[yy * w + xx];
          const k = ids.indexOf(m);
          if (k < 0) { ids.push(m); counts.push(1); } else counts[k]++;
        }
      }
      let best = labels[y * w + x], bc = 0;
      for (let k = 0; k < ids.length; k++) if (counts[k] > bc) { bc = counts[k]; best = ids[k]; }
      out[y * w + x] = best;
    }
  return out;
}

/**
 * The outline (cells) of label m's largest piece, along the pixels' edges,
 * simplified. Holes are left out.
 */
function outline(labels: Int32Array, w: number, h: number, m: number, px: number, tolerance: number): Pt[] | null {
  // Largest 4-connected piece.
  const seen = new Uint8Array(w * h);
  let best: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (labels[s] !== m || seen[s]) continue;
    const piece: number[] = [];
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      piece.push(i);
      const x = i % w, y = (i - x) / w;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!seen[j] && labels[j] === m) { seen[j] = 1; stack.push(j); }
      }
    }
    if (piece.length > best.length) best = piece;
  }
  if (best.length < 4) return null;
  const inPiece = new Uint8Array(w * h);
  for (const i of best) inPiece[i] = 1;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && inPiece[y * w + x] === 1;
  // Trace the outer boundary (pixel corners), starting at the topmost-leftmost pixel's top-left corner, clockwise.
  let start = best[0];
  for (const i of best) if (i < start) start = i;
  const sx = start % w, sy = (start - sx) / w;
  const pts: Pt[] = [];
  // Directions: 0 right, 1 down, 2 left, 3 up (corner coordinates).
  let x = sx, y = sy, dir = 0;
  const VX = [1, 0, -1, 0], VY = [0, 1, 0, -1];
  // The pixel to the right-hand side of travel is outside, left-hand inside... walk keeping the piece on the right.
  const ahead = (cx: number, cy: number, d: number) => {
    // Pixels on either side of the edge leaving corner (cx, cy) in direction d.
    switch (d) {
      case 0: return [inside(cx, cy - 1), inside(cx, cy)]; // left: above, right: below
      case 1: return [inside(cx, cy), inside(cx - 1, cy)];
      case 2: return [inside(cx - 1, cy), inside(cx - 1, cy - 1)];
      default: return [inside(cx - 1, cy - 1), inside(cx, cy - 1)];
    }
  };
  const guard = 4 * best.length + 8;
  for (let k = 0; k < guard; k++) {
    pts.push([x / px, y / px]);
    x += VX[dir];
    y += VY[dir];
    if (x === sx && y === sy) break;
    // Prefer turning left (outside), then straight, then right, keeping inside on the right.
    for (const t of [3, 0, 1, 2]) {
      const d = (dir + t) % 4;
      const [l, r] = ahead(x, y, d);
      if (!l && r) { dir = d; break; }
    }
  }
  // Simplified: a corner closer than `tolerance` (cells) to the line between its
  // neighbours goes (a slanted edge's steps, a tooth with straight lines both sides).
  return straighten(simplifyClosed(pts, Math.max(tolerance, 1.2 / px)));
}

/**
 * Takes out wedges and bumps: a stretch whose straight lines on both sides
 * carry on from one another (same direction, on one line) is replaced by
 * that line, if it strays at most `depth` cells from it over at most `span`.
 */
export function straighten(pts: Pt[], depth = 1, span = 3): Pt[] {
  let cur = pts;
  for (let changed = true, guard = 0; changed && guard < 200; guard++) {
    changed = false;
    const n = cur.length;
    if (n < 6) break;
    for (let i = 0; i < n && !changed; i++) {
      const a0 = cur[(i - 1 + n) % n], a1 = cur[i];
      const la = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
      if (la < 0.3) continue;
      for (let k = 2; k <= Math.min(6, n - 3) && !changed; k++) {
        const b0 = cur[(i + k) % n], b1 = cur[(i + k + 1) % n];
        const lb = Math.hypot(b1[0] - b0[0], b1[1] - b0[1]);
        const chord = Math.hypot(b0[0] - a1[0], b0[1] - a1[1]);
        if (lb < 0.3 || chord > span) continue;
        // Same direction…
        const ua: Pt = [(a1[0] - a0[0]) / la, (a1[1] - a0[1]) / la], ub: Pt = [(b1[0] - b0[0]) / lb, (b1[1] - b0[1]) / lb];
        if (dotP(ua, ub) < Math.cos((12 * Math.PI) / 180)) continue;
        // …and on one line: b0 lies on a's line.
        if (Math.abs((b0[0] - a1[0]) * ua[1] - (b0[1] - a1[1]) * ua[0]) > 0.15) continue;
        // The stretch between strays at most `depth` from it.
        let far = 0;
        for (let j = 1; j < k; j++) {
          const p = cur[(i + j) % n];
          far = Math.max(far, Math.abs((p[0] - a1[0]) * ua[1] - (p[1] - a1[1]) * ua[0]));
        }
        if (far > depth || far < 0.05) continue;
        const drop = new Set<number>();
        for (let j = 1; j < k; j++) drop.add((i + j) % n);
        cur = cur.filter((_, q) => !drop.has(q));
        changed = true;
      }
    }
  }
  return cur;
}

const dotP = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
