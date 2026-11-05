// Walls as a building's plan: a long, narrow mark is a straight wall, a band
// with a width. Each is fitted to the wall the picture draws (its side, how
// far across, how wide, where it ends), then the walls are joined: an end
// near another wall runs on to that wall's far face. The surfaces round them
// are filled after (fill.ts), with the walls fixed.

import type { Pt } from "../types";
import type { Prepared } from "./snap";

export type Wall = {
  /** The mark it comes from. */
  mark: number;
  /** Its middle line: a point on it, its direction (unit), its normal. */
  o: Pt;
  u: Pt;
  v: Pt;
  /** Where along u it runs (from `o`), and how far across v its sides are (from `o`). */
  s0: number;
  s1: number;
  t0: number;
  t1: number;
};

export type WallOptions = {
  /** Widest a mark may be (cells) to be a wall. */
  maxWidth?: number;
  /** How far (cells) a wall's sides may be from its mark's. */
  reach?: number;
  /** How far (cells) a wall's end may be from another wall to be joined to it. */
  join?: number;
  /** How far (cells) past its mark's ends a wall may run on, while the picture's wall does. */
  stretch?: number;
};

const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];

/** A mark's long axis and its extent along and across it, if it's long and narrow. */
function axisOf(ring: Pt[], maxWidth: number): { o: Pt; u: Pt; v: Pt; s0: number; s1: number; t0: number; t1: number } | null {
  // Principal axis of the outline's points (dense along it, so long sides weigh by length).
  const pts: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.1));
    for (let j = 0; j < k; j++) pts.push([ax + ((bx - ax) * j) / k, ay + ((by - ay) * j) / k]);
  }
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  let a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // Walls on maps run with the grid: an axis within 4° of it is taken as the grid's.
  const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(a - q) < (4 * Math.PI) / 180) a = q;
  const u: Pt = [Math.cos(a), Math.sin(a)], v: Pt = [-u[1], u[0]];
  let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
  for (const [x, y] of pts) {
    const s = (x - mx) * u[0] + (y - my) * u[1], t = (x - mx) * v[0] + (y - my) * v[1];
    s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
  }
  const width = t1 - t0, length = s1 - s0;
  if (width > maxWidth || length < 1.5 || length < 2.5 * width) return null;
  return { o: [mx, my], u, v, s0, s1, t0, t1 };
}

/** Lab colour at a point in cells (bilinear). */
function labAt(p: Prepared, x: number, y: number, out: Float32Array) {
  const fx = Math.min(p.w - 1.001, Math.max(0, x * p.px - 0.5));
  const fy = Math.min(p.h - 1.001, Math.max(0, y * p.px - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const i = y0 * p.w + x0;
  for (let c = 0; c < 3; c++)
    out[c] = (p.lab[i * 3 + c] * (1 - tx) + p.lab[(i + 1) * 3 + c] * tx) * (1 - ty) + (p.lab[(i + p.w) * 3 + c] * (1 - tx) + p.lab[(i + p.w + 1) * 3 + c] * tx) * ty;
}

const DS = 0.1; // cells between profiles along a wall
const DT = 0.025; // cells between spots across it
const SIDE = 0.1; // how far to either side of a spot its two sides are compared

/** The walls among the marks, fitted to the picture and joined. */
export function fitWalls(img: Prepared, rings: Pt[][], opts: WallOptions = {}): Wall[] {
  const maxWidth = opts.maxWidth ?? 1.2, reach = opts.reach ?? 0.6, join = opts.join ?? 1.5, stretch = opts.stretch ?? 3;
  const walls: Wall[] = [];
  const col = new Float32Array(3), a = new Float32Array(3), b = new Float32Array(3);
  rings.forEach((ring, mark) => {
    if (ring.length < 3) return;
    const ax = axisOf(ring, maxWidth);
    if (!ax) return;
    const { o, u, v } = ax;
    // Profiles across the wall, from `stretch` cells before its mark's ends to as many after.
    const S0 = ax.s0 - stretch, S1 = ax.s1 + stretch;
    const T0 = ax.t0 - reach, T1 = ax.t1 + reach;
    const ns = Math.max(2, Math.round((S1 - S0) / DS)), nt = Math.max(4, Math.round((T1 - T0) / DT));
    // C[s][t]: how much the two sides of the spot differ (a wall's face: a lot).
    const C = new Float32Array((ns + 1) * (nt + 1));
    for (let si = 0; si <= ns; si++) {
      const s = S0 + ((S1 - S0) * si) / ns;
      for (let ti = 0; ti <= nt; ti++) {
        const t = T0 + ((T1 - T0) * ti) / nt;
        const x = o[0] + u[0] * s + v[0] * t, y = o[1] + u[1] * s + v[1] * t;
        labAt(img, x - v[0] * SIDE, y - v[1] * SIDE, a);
        labAt(img, x + v[0] * SIDE, y + v[1] * SIDE, b);
        C[si * (nt + 1) + ti] = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      }
    }
    void col;
    // Within the mark's own stretch, each t's median contrast: a face runs the whole length.
    const inMark = (si: number) => {
      const s = S0 + ((S1 - S0) * si) / ns;
      return s >= ax.s0 && s <= ax.s1;
    };
    const M = new Float32Array(nt + 1);
    const column: number[] = [];
    for (let ti = 0; ti <= nt; ti++) {
      column.length = 0;
      for (let si = 0; si <= ns; si++) if (inMark(si)) column.push(C[si * (nt + 1) + ti]);
      column.sort((p, q) => p - q);
      M[ti] = column[Math.floor(column.length / 2)] ?? 0;
    }
    // The two faces: the pair of t's (0.15–1.2 cells apart) with the most
    // contrast together. A wall's trim makes a line of its own inside it: of
    // pairs nearly as strong (70%), the widest is the wall (trim included).
    const minW = Math.round(0.15 / DT), maxW = Math.round(maxWidth / DT);
    const scoreOf = (i: number, j: number) => Math.min(M[i], M[j]) * 2 + (M[i] + M[j]) * 0.25;
    let best = -1;
    for (let i = 0; i <= nt; i++) for (let j = i + minW; j <= Math.min(nt, i + maxW); j++) best = Math.max(best, scoreOf(i, j));
    let f0 = 0, f1 = nt, widest = -1;
    for (let i = 0; i <= nt; i++)
      for (let j = i + minW; j <= Math.min(nt, i + maxW); j++)
        if (scoreOf(i, j) >= 0.7 * best && j - i > widest) { widest = j - i; f0 = i; f1 = j; }
    const t0 = T0 + f0 * DT, t1 = T0 + f1 * DT;
    // Its ends: where both faces stop showing (from its middle outwards).
    const faces = (si: number) => Math.min(C[si * (nt + 1) + f0], C[si * (nt + 1) + f1]);
    const strong = Math.min(M[f0], M[f1]) * 0.45;
    const mid = Math.round(((ax.s0 + ax.s1) / 2 - S0) / DS);
    const GAP = Math.round(0.3 / DS); // a door or an ornament this long doesn't end it
    const run = (dir: number) => {
      let last = mid, miss = 0;
      for (let si = mid; si >= 0 && si <= ns; si += dir) {
        if (faces(si) >= strong) { last = si; miss = 0; } else if (++miss > GAP) break;
      }
      return S0 + last * DS;
    };
    let s0 = run(-1), s1 = run(1);
    // Never short of its mark's ends by more than a cell.
    s0 = Math.min(s0, ax.s0 + 1);
    s1 = Math.max(s1, ax.s1 - 1);
    walls.push({ mark, o, u, v, s0, s1, t0, t1 });
  });
  joinWalls(walls, join);
  return walls;
}

/** A wall's end near another (crossing) wall runs on to that wall's far face. */
function joinWalls(walls: Wall[], join: number) {
  for (const w of walls)
    for (const end of [0, 1] as const) {
      const s = end ? w.s1 : w.s0;
      const mid = (w.t0 + w.t1) / 2;
      const p: Pt = [w.o[0] + w.u[0] * s + w.v[0] * mid, w.o[1] + w.u[1] * s + w.v[1] * mid];
      let bestS = s, bestD = Infinity;
      for (const x of walls) {
        if (x === w || Math.abs(dot(w.u, x.u)) > 0.5) continue; // only walls across it
        // Where this wall's middle line meets x's two faces.
        const rel: Pt = [p[0] - x.o[0], p[1] - x.o[1]];
        const along = dot(rel, x.u);
        if (along < x.s0 - join || along > x.s1 + join) continue;
        const across = dot(rel, x.v); // p's distance across x
        const dvu = dot(w.u, x.v); // how fast going along w crosses x
        if (Math.abs(dvu) < 1e-6) continue;
        const gap = across < x.t0 ? x.t0 - across : across > x.t1 ? across - x.t1 : 0;
        if (gap > join) continue;
        // Run to x's far face (seen from w's inside), so the walls overlap at the joint.
        const outward = end ? 1 : -1; // direction along w.u this end points
        const faceFar = dvu * outward > 0 ? x.t1 : x.t0;
        const ds = (faceFar - across) / dvu;
        const ns = s + ds;
        if (Math.abs(ds) < bestD) { bestD = Math.abs(ds); bestS = ns; }
      }
      if (bestD < Infinity) { if (end) w.s1 = bestS; else w.s0 = bestS; }
    }
}

/** A wall's outline (four corners, cells). */
export function wallRing(w: Wall): Pt[] {
  const at = (s: number, t: number): Pt => [w.o[0] + w.u[0] * s + w.v[0] * t, w.o[1] + w.u[1] * s + w.v[1] * t];
  return [at(w.s0, w.t0), at(w.s1, w.t0), at(w.s1, w.t1), at(w.s0, w.t1)];
}
