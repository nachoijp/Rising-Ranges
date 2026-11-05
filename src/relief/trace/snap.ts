// "Ajustar al dibujo": moves a rough outline onto the edges the map's picture
// shows. No guessing what the map means: the outline says which side is the
// shape, and each point of it may only move a little across it (`reach`).
//
// Per point of the outline, along its normal: the colours well inside the
// rough outline and well outside it (both past `reach`, so they're surely on
// their side when the outline is at most that far off) say how much each spot
// looks like in or out; a jump in colour (the gradient) says where an edge is.
// Every point picks how far to move with a dynamic programme along the
// outline, so neighbours move alike (a smooth outline, no spikes).
// All in cells of the map (x right, y down); the picture comes as RGBA.

import type { Pt } from "../types";

/** A map's picture: RGBA, `px` pixels per cell. */
export type Raster = { w: number; h: number; px: number; data: Uint8ClampedArray };

/** A picture made ready: CIE Lab colours and their gradient's size, per pixel. */
export type Prepared = { w: number; h: number; px: number; lab: Float32Array; grad: Float32Array };

export type SnapOptions = {
  /** How far (cells) a point may move. */
  reach?: number;
  /** Cells between the points looked at along the outline. */
  step?: number;
  /** The outline's corners that stay where they are (indices into the ring). */
  fixed?: ReadonlySet<number>;
  /** Cells an outline may stray from its points when simplified after. */
  tolerance?: number;
};

const srgb = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const SRGB = Float32Array.from({ length: 256 }, (_, i) => srgb(i));
const labF = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** Lab colours, lightly blurred (the map's grain isn't an edge), and the gradient's size. */
export function prepare(img: Raster): Prepared {
  const { w, h, data } = img;
  const n = w * h;
  const raw = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = SRGB[data[i * 4]], g = SRGB[data[i * 4 + 1]], b = SRGB[data[i * 4 + 2]];
    const x = labF((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
    const y = labF(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const z = labF((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    raw[i * 3] = 116 * y - 16;
    raw[i * 3 + 1] = 500 * (x - y);
    raw[i * 3 + 2] = 200 * (y - z);
  }
  // A 3×3 binomial blur, twice (about a 5 px Gaussian).
  let lab = raw;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(n * 3);
    for (let yy = 0; yy < h; yy++)
      for (let xx = 0; xx < w; xx++)
        for (let c = 0; c < 3; c++) {
          let sum = 0, wsum = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const y2 = yy + dy;
            if (y2 < 0 || y2 >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const x2 = xx + dx;
              if (x2 < 0 || x2 >= w) continue;
              const k = (dx ? 1 : 2) * (dy ? 1 : 2);
              sum += lab[(y2 * w + x2) * 3 + c] * k;
              wsum += k;
            }
          }
          out[(yy * w + xx) * 3 + c] = sum / wsum;
        }
    lab = out;
  }
  const grad = new Float32Array(n);
  for (let yy = 1; yy < h - 1; yy++)
    for (let xx = 1; xx < w - 1; xx++) {
      let s = 0;
      for (let c = 0; c < 3; c++) {
        const at = (dx: number, dy: number) => lab[((yy + dy) * w + xx + dx) * 3 + c];
        const gx = at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1);
        const gy = at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1);
        s += gx * gx + gy * gy;
      }
      grad[yy * w + xx] = Math.sqrt(s);
    }
  return { w, h, px: img.px, lab, grad };
}

/** Lab colour and gradient at a point in cells (bilinear; clamped to the picture). */
function sample(p: Prepared, x: number, y: number, out: Float32Array): number {
  const fx = Math.min(p.w - 1.001, Math.max(0, x * p.px - 0.5));
  const fy = Math.min(p.h - 1.001, Math.max(0, y * p.px - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const i00 = y0 * p.w + x0, i10 = i00 + 1, i01 = i00 + p.w, i11 = i01 + 1;
  const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
  for (let c = 0; c < 3; c++) out[c] = p.lab[i00 * 3 + c] * w00 + p.lab[i10 * 3 + c] * w10 + p.lab[i01 * 3 + c] * w01 + p.lab[i11 * 3 + c] * w11;
  return p.grad[i00] * w00 + p.grad[i10] * w10 + p.grad[i01] * w01 + p.grad[i11] * w11;
}

type Sample = { x: number; y: number; nx: number; ny: number; vertex: number };

/** Points every `step` cells along a closed ring, its corners among them, with outward normals. */
export function resample(ring: Pt[], step: number): Sample[] {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    area += x0 * y1 - x1 * y0;
  }
  const out: Sample[] = [];
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const k = Math.max(1, Math.round(len / step));
    for (let j = 0; j < k; j++) out.push({ x: x0 + ((x1 - x0) * j) / k, y: y0 + ((y1 - y0) * j) / k, nx: 0, ny: 0, vertex: j === 0 ? i : -1 });
  }
  // Normals from the neighbours (corners get the mean of their two sides).
  const sign = area > 0 ? 1 : -1;
  for (let i = 0; i < out.length; i++) {
    const a = out[(i - 1 + out.length) % out.length], b = out[(i + 1) % out.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    out[i].nx = (sign * dy) / len;
    out[i].ny = (-sign * dx) / len;
  }
  return out;
}

const T_STEP = 0.05; // cells between the spots looked at along a normal
const SIGMA = 8; // Lab distance over which likeness to a model falls by e
const OTHER = Math.exp(-14 / SIGMA); // a colour this far from the inside is as likely "something else"

/**
 * The outline moved onto the picture's edges. Two passes: the whole reach,
 * then a short one round where the first left it (finer).
 */
export function snapRing(img: Prepared, ring: Pt[], opts: SnapOptions = {}): Pt[] {
  const reach = opts.reach ?? 1.5;
  const step = opts.step ?? 0.25;
  const fixed = opts.fixed ?? new Set<number>();
  if (ring.length < 3) return ring;
  let samples = resample(ring, step);
  let moved = pass(img, samples, reach, fixed);
  // The second pass keeps the corners known from the first (as fixed points, by position).
  samples = samples.map((s, i) => ({ ...s, x: moved[i][0], y: moved[i][1] }));
  samples = renormal(samples);
  moved = pass(img, samples, reach * 0.35, fixed);
  // A free sharp corner's own normal is the mean of its sides', so it's
  // dragged diagonally and leaves a hook: its sides' points carry the outline
  // there. Gentle bends (a circle's many corners) stay.
  const kept: Pt[] = [];
  const keep = new Set<number>();
  samples.forEach((s, i) => {
    const sharp = s.vertex >= 0 && turn(ring, s.vertex) > SHARP;
    if (s.vertex >= 0 && fixed.has(s.vertex)) keep.add(kept.length);
    if (!sharp || fixed.has(s.vertex)) kept.push(moved[i]);
  });
  if (kept.length < 3) return ring;
  return simplifyClosed(unloop(kept, keep), opts.tolerance ?? 0.08, keep);
}

const SHARP = (35 * Math.PI) / 180;

/** How much the outline turns at corner i (radians, 0 = straight on). */
function turn(ring: Pt[], i: number): number {
  const n = ring.length;
  const [ax, ay] = ring[(i - 1 + n) % n], [bx, by] = ring[i], [cx, cy] = ring[(i + 1) % n];
  const a = Math.atan2(by - ay, bx - ax), b = Math.atan2(cy - by, cx - bx);
  const d = Math.abs(b - a) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

function renormal(s: Sample[]): Sample[] {
  let area = 0;
  for (let i = 0; i < s.length; i++) {
    const a = s[i], b = s[(i + 1) % s.length];
    area += a.x * b.y - b.x * a.y;
  }
  const sign = area > 0 ? 1 : -1;
  return s.map((p, i) => {
    const a = s[(i - 1 + s.length) % s.length], b = s[(i + 1) % s.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { ...p, nx: (sign * dy) / len, ny: (-sign * dx) / len };
  });
}

/** One pass: each sample's offset along its normal, in [-reach, reach]. */
function pass(img: Prepared, samples: Sample[], reach: number, fixed: ReadonlySet<number>): Pt[] {
  const n = samples.length;
  const D = Math.max(3, Math.round(reach / T_STEP)); // offsets −D..D
  const span = 2 * D + 1;
  const far = Math.max(reach, 0.6); // the models' spots: past `reach`, `far` deeper
  const col = new Float32Array(3);
  // Colours of each sample's inner and outer spots (the models).
  const MODEL = 6;
  const inner: Float32Array[] = [], outer: Float32Array[] = [];
  for (const s of samples) {
    const a = new Float32Array(MODEL * 3), b = new Float32Array(MODEL * 3);
    // Inside, never past the middle of the shape across (a narrow one's other side).
    const across = depthAcross(samples, s);
    const i0 = Math.min(reach + 0.1, across * 0.3), i1 = Math.min(reach + 0.1 + far, across * 0.5);
    for (let k = 0; k < MODEL; k++) {
      const ti = i0 + ((i1 - i0) * k) / (MODEL - 1);
      sample(img, s.x - s.nx * ti, s.y - s.ny * ti, col);
      a.set(col, k * 3);
      const t = reach + 0.1 + (far * k) / (MODEL - 1);
      sample(img, s.x + s.nx * t, s.y + s.ny * t, col);
      b.set(col, k * 3);
    }
    inner.push(a);
    outer.push(b);
  }
  // Per sample, the cost of each offset.
  const WIN = 5; // neighbours on each side whose models count too
  const cost = new Float32Array(n * span);
  const s01 = new Float32Array(span), g = new Float32Array(span);
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    let gmax = 1e-6;
    for (let k = 0; k < span; k++) {
      const t = (k - D) * T_STEP;
      g[k] = sample(img, s.x + s.nx * t, s.y + s.ny * t, col);
      gmax = Math.max(gmax, g[k]);
      // How much this spot looks like the inside (1) or not (0). A colour like
      // neither model (a cliff's rock face between a plateau and the beach)
      // counts as outside: the shape is where its own colours are.
      const din = nearest(col, inner, i, WIN, n), dout = nearest(col, outer, i, WIN, n);
      const pin = Math.exp(-din / SIGMA), pout = Math.exp(-dout / SIGMA) + OTHER;
      s01[k] = pin / (pin + pout);
    }
    // Region cost of cutting at k: outside-like spots before it, inside-like after it.
    let before = 0;
    let after = 0;
    for (let k = 0; k < span; k++) after += s01[k];
    for (let k = 0; k < span; k++) {
      const t = (k - D) / D;
      const region = (before + after) * T_STEP;
      cost[i * span + k] = region - 0.35 * (g[k] / gmax) + 0.05 * t * t;
      before += 1 - s01[k];
      after -= s01[k];
    }
    if (s.vertex >= 0 && fixed.has(s.vertex)) for (let k = 0; k < span; k++) if (k !== D) cost[i * span + k] = 1e9;
  }
  // Dynamic programme along the outline; neighbours pay for moving apart. The
  // outline is closed: it's walked twice over and the middle stretch kept, so
  // no point is an open end.
  const SMOOTH = 0.6; // cost per cell of difference between neighbours' offsets, per cell of outline
  const H = Math.floor(n / 2);
  const N = 2 * n;
  const at = (i: number) => (i + H) % n; // walk from halfway round, twice
  const back = new Int16Array(N * span);
  let prev = cost.slice(at(0) * span, at(0) * span + span);
  for (let w = 1; w < N; w++) {
    const i = at(w), p = at(w - 1);
    const gap = Math.max(0.05, Math.hypot(samples[i].x - samples[p].x, samples[i].y - samples[p].y));
    const pen = (SMOOTH * T_STEP) / gap;
    const cur = new Float32Array(span);
    for (let k = 0; k < span; k++) {
      let best = Infinity, arg = 0;
      for (let j = Math.max(0, k - 12); j <= Math.min(span - 1, k + 12); j++) {
        const v = prev[j] + pen * Math.abs(j - k) * Math.abs(j - k) * 0.5 + pen * Math.abs(j - k);
        if (v < best) { best = v; arg = j; }
      }
      cur[k] = best + cost[i * span + k];
      back[w * span + k] = arg;
    }
    prev = cur;
  }
  let k = 0;
  for (let j = 1; j < span; j++) if (prev[j] < prev[k]) k = j;
  // Back along the walk; the stretch from n/2 to 3n/2 holds every point once, both ends far from the walk's.
  const pick = new Int16Array(n);
  for (let w = N - 1; w >= 0; w--) {
    if (w >= H && w < H + n) pick[at(w)] = k;
    if (w > 0) k = back[w * span + k];
  }
  return samples.map((s, i): Pt => {
    const t = (pick[i] - D) * T_STEP;
    return [s.x + s.nx * t, s.y + s.ny * t];
  });
}

/**
 * Cuts the small loops a moved outline makes where it crosses itself (at a
 * corner, one side's points pass the other side's line). `keep` (indices) is
 * remapped in place onto the result; a loop holding a kept point stays.
 */
function unloop(pts: Pt[], keep: Set<number>): Pt[] {
  const WIN = 40; // loops longer than this many points are left alone
  let cur = pts.map((p, i) => ({ p, i }));
  for (let guard = 0; guard < 50; guard++) {
    const n = cur.length;
    let cut: { a: number; b: number; x: Pt } | null = null;
    for (let a = 0; a < n && !cut; a++) {
      const p1 = cur[a].p, p2 = cur[(a + 1) % n].p;
      for (let o = 2; o <= Math.min(WIN, Math.floor(n / 4)) && !cut; o++) {
        const b = (a + o) % n;
        const x = crossing(p1, p2, cur[b].p, cur[(b + 1) % n].p);
        if (!x) continue;
        // The loop is the points a+1..b; leave it if it holds a kept one.
        let held = false;
        for (let k = 1; k <= o; k++) if (keep.has(cur[(a + k) % n].i)) held = true;
        if (!held) cut = { a, b, x };
      }
    }
    if (!cut) break;
    const next: { p: Pt; i: number }[] = [];
    for (let k = 0; k < n; k++) {
      const off = (k - cut.a + n) % n;
      if (off >= 1 && off <= (cut.b - cut.a + n) % n) {
        if (off === 1) next.push({ p: cut.x, i: -1 });
        continue;
      }
      next.push(cur[k]);
    }
    cur = next;
  }
  const remap = new Set<number>();
  cur.forEach((c, k) => keep.has(c.i) && remap.add(k));
  keep.clear();
  remap.forEach((k) => keep.add(k));
  return cur.map((c) => c.p);
}

function crossing([ax, ay]: Pt, [bx, by]: Pt, [cx, cy]: Pt, [dx, dy]: Pt): Pt | null {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return t > 0 && t < 1 && u > 0 && u < 1 ? [ax + t * rx, ay + t * ry] : null;
}

/** How far inward from `s` (along its normal) the outline is met again (cells). */
function depthAcross(samples: Sample[], s: Sample): number {
  const dx = -s.nx, dy = -s.ny;
  let best = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i], b = samples[(i + 1) % samples.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - s.x) * ey - (a.y - s.y) * ex) / den;
    const u = ((a.x - s.x) * dy - (a.y - s.y) * dx) / den;
    if (t > 0.05 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}

/** Mean of the 3 smallest squared Lab distances from `c` to the models of samples i−win..i+win. */
function nearest(c: Float32Array, models: Float32Array[], i: number, win: number, n: number): number {
  let a = Infinity, b = Infinity, d3 = Infinity;
  for (let o = -win; o <= win; o++) {
    const m = models[(i + o + n) % n];
    for (let k = 0; k < m.length; k += 3) {
      const dl = c[0] - m[k], da = c[1] - m[k + 1], db = c[2] - m[k + 2];
      const d = dl * dl + da * da + db * db;
      if (d < a) { d3 = b; b = a; a = d; } else if (d < b) { d3 = b; b = d; } else if (d < d3) d3 = d;
    }
  }
  return Math.sqrt((a + b + d3) / 3);
}

/** Douglas–Peucker on a closed outline; `keep`: indices that stay. */
export function simplifyClosed(pts: Pt[], tol: number, keep: ReadonlySet<number> = new Set()): Pt[] {
  const n = pts.length;
  if (n <= 4) return pts;
  // Split at the point farthest from the first one (and the kept ones).
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > fd) { fd = d; far = i; }
  }
  const mark = new Uint8Array(n);
  mark[0] = mark[far] = 1;
  keep.forEach((i) => (mark[i] = 1));
  const anchors = [...Array(n).keys()].filter((i) => mark[i]);
  for (let a = 0; a < anchors.length; a++) dp(pts, anchors[a], anchors[(a + 1) % anchors.length], tol, mark, n);
  return pts.filter((_, i) => mark[i]);
}

function dp(pts: Pt[], i0: number, i1: number, tol: number, mark: Uint8Array, n: number) {
  const len = (i1 - i0 + n) % n || n;
  if (len < 2) return;
  const [ax, ay] = pts[i0], [bx, by] = pts[i1];
  const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
  let best = -1, arg = -1;
  for (let o = 1; o < len; o++) {
    const i = (i0 + o) % n;
    const [px, py] = pts[i];
    const d = L < 1e-9 ? Math.hypot(px - ax, py - ay) : Math.abs((px - ax) * dy - (py - ay) * dx) / L;
    if (d > best) { best = d; arg = i; }
  }
  if (best > tol) {
    mark[arg] = 1;
    dp(pts, i0, arg, tol, mark, n);
    dp(pts, arg, i1, tol, mark, n);
  }
}

/** Mean distance (cells) between two closed outlines, both ways. */
export function outlineDistance(a: Pt[], b: Pt[]): { mean: number; max: number } {
  const one = (p: Pt[], q: Pt[]) => {
    const s = resample(p, 0.1);
    let sum = 0, max = 0;
    for (const { x, y } of s) {
      let d = Infinity;
      for (let i = 0; i < q.length; i++) d = Math.min(d, segDist(x, y, q[i], q[(i + 1) % q.length]));
      sum += d;
      max = Math.max(max, d);
    }
    return { sum, max, n: s.length };
  };
  const u = one(a, b), v = one(b, a);
  return { mean: (u.sum + v.sum) / (u.n + v.n), max: Math.max(u.max, v.max) };
}

function segDist(x: number, y: number, [ax, ay]: Pt, [bx, by]: Pt) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}
