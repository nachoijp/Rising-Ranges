// Heights from the picture's clues, region by region.
//
// What a region is (its "material", from its colour and grain): water lies
// lowest; foliage (trees, hedges) stands on the ground as objects; the rest is
// ground whose height is to be found.
//
// Clues at each border between two ground regions: a painted map shades what's
// lower next to what's higher (a cast shadow, darkness at the foot of a step).
// So, across the border, the side that darkens towards it is the lower one.
// Ink outlines darken both sides alike and cancel out. Cast shadows all fall
// one way: that way's found from the whole map first (the sum of every
// darkening, by the direction it falls in), and borders facing it count more;
// how wide the shadow is says how much higher (K levels a cell of shadow).
//
// The heights: the ones that best keep every clue ("this one ~1 over that
// one", "these two level"), solved over all regions at once (least squares,
// by Gauss–Seidel), water held low, then rounded to half levels and moved so
// the most ground is at 0.

import type { Img, Region } from "./regions";

export type Material = "ground" | "water" | "foliage";

export type Look = { material: Material; why: string };

/**
 * What a region is, from its mean colour and grain. Water: well bluer than the map's usual (`midB`,
 * its regions' middle blue-yellow), so a night map's blue cast doesn't make it all water.
 */
export function lookOf(r: Region, texHigh: number, midB: number): Look {
  if (r.B < midB - 14 && r.L < 85 && r.A < 15) return { material: "water", why: "bluer than the map" };
  // At night, still water is the darkest and smoothest there is.
  if (r.L < 16 && r.tex < 2) return { material: "water", why: "dark and still" };
  if (r.A < -9 && r.B > 0 && r.tex > texHigh && r.L < 62) return { material: "foliage", why: "green, coarse" };
  return { material: "ground", why: r.A < -6 ? "green, fine" : "" };
}

/** A clue between two regions: h[b] − h[a] ≈ d, this sure (weight). */
export type Clue = { a: number; b: number; d: number; w: number; kind: "shade" | "level" | "stair" };

export type ShadeResult = { dir: [number, number]; strength: number; clues: Clue[] };

/** How far into a region its near and far samples are (cells). */
const NEAR = [0, 0.12];
const FAR = [0.35, 0.6];

/**
 * The clues at the borders between the `solve` regions (others ignored), and
 * the way cast shadows fall.
 */
export function shadeClues(img: Img, labels: Int32Array, regions: Region[], solve: boolean[], K = 4): ShadeResult {
  const { W, H, px, L } = img;
  const R = regions.length;
  const near0 = Math.round(NEAR[0] * px), near1 = Math.max(near0 + 1, Math.round(NEAR[1] * px));
  const far0 = Math.round(FAR[0] * px), far1 = Math.round(FAR[1] * px);
  /** Into region r from pixel i, along (dx, dy): how much darker it is at the border than further in; null if r doesn't go that far. */
  const darkAt = (i: number, dx: number, dy: number, r: number): { dark: number; near: number; far: number } | null => {
    const x = i % W, y = (i - x) / W;
    let near = 0, far = 0;
    for (let k = near0; k <= near1; k++) {
      const xx = x + dx * k, yy = y + dy * k;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H || labels[yy * W + xx] !== r) return null;
      near += L[yy * W + xx];
    }
    for (let k = far0; k <= far1; k++) {
      const xx = x + dx * k, yy = y + dy * k;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H || labels[yy * W + xx] !== r) return null;
      far += L[yy * W + xx];
    }
    near /= near1 - near0 + 1;
    far /= far1 - far0 + 1;
    return { dark: Math.max(-1, Math.min(1, (far - near) / Math.max(far, 8))), near, far };
  };
  const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  // 1. Which way shadows fall: every darkening, by the way into its region.
  let sx = 0, sy = 0, total = 0;
  for (let i = 0; i < W * H; i++) {
    const r = labels[i];
    if (r < 0 || !solve[r]) continue;
    const x = i % W, y = (i - x) / W;
    for (const [dx, dy] of DIRS) {
      const xo = x - dx, yo = y - dy;
      if (xo < 0 || yo < 0 || xo >= W || yo >= H) continue;
      const s = labels[yo * W + xo];
      if (s < 0 || s === r || !solve[s]) continue;
      const d = darkAt(i, dx, dy, r);
      if (!d) continue;
      if (d.dark > 0.08) {
        sx += dx * d.dark;
        sy += dy * d.dark;
      }
      total += Math.abs(d.dark);
    }
  }
  const len = Math.hypot(sx, sy);
  const strength = total > 0 ? len / total : 0;
  const dir: [number, number] = len > 0 ? [sx / len, sy / len] : [0, 0];
  const useDir = strength > 0.15;
  // 2. Per border, each side: how much it darkens towards the other (borders facing the shadows counting more), and how wide.
  type Side = { dark: number; w: number; n: number; strong: number; width: number; widthN: number };
  const sides = new Map<number, Side>();
  const sideOf = (r: number, s: number) => {
    const k = r * R + s;
    let e = sides.get(k);
    if (!e) sides.set(k, (e = { dark: 0, w: 0, n: 0, strong: 0, width: 0, widthN: 0 }));
    return e;
  };
  for (let i = 0; i < W * H; i++) {
    const r = labels[i];
    if (r < 0 || !solve[r]) continue;
    const x = i % W, y = (i - x) / W;
    for (const [dx, dy] of DIRS) {
      const xo = x - dx, yo = y - dy;
      if (xo < 0 || yo < 0 || xo >= W || yo >= H) continue;
      const s = labels[yo * W + xo];
      if (s < 0 || s === r || !solve[s]) continue;
      const d = darkAt(i, dx, dy, r);
      if (!d) continue;
      // With no way shadows fall (shading all round), every side counts alike.
      const facing = useDir ? Math.max(0, dx * dir[0] + dy * dir[1]) : 1;
      const wgt = useDir ? 0.5 + facing : 1;
      const e = sideOf(r, s);
      e.dark += d.dark * wgt;
      e.w += wgt;
      e.n++;
      if (d.dark > 0.15) e.strong++;
      if (facing > 0.5 && d.dark > 0.1) {
        // The shadow's width: till the lightness is most of the way back.
        const back = d.far - 0.2 * (d.far - d.near);
        let k = 1;
        for (; k < 2 * px; k++) {
          const xx = x + dx * k, yy = y + dy * k;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H || labels[yy * W + xx] !== r) break;
          if (L[yy * W + xx] >= back) break;
        }
        e.width += (k / px) * facing;
        e.widthN++;
      }
    }
  }
  // 3. The clues.
  const clues: Clue[] = [];
  const done = new Set<number>();
  for (const [k] of sides) {
    const r = Math.floor(k / R), s = k % R;
    const u = Math.min(r, s), v = Math.max(r, s);
    if (done.has(u * R + v)) continue;
    done.add(u * R + v);
    const a = sides.get(u * R + v), b = sides.get(v * R + u);
    const n = (a?.n ?? 0) + (b?.n ?? 0);
    const lenCells = n / 2 / px;
    if (lenCells < 0.25) continue;
    const da = a && a.w ? a.dark / a.w : 0, db = b && b.w ? b.dark / b.w : 0;
    // Positive: u darker at the border, so v higher.
    const ev = da - db;
    const lower = ev > 0 ? a : b;
    const width = lower && lower.widthN >= 3 ? lower.width / lower.widthN : 0;
    const d = Math.max(0, Math.min(3, K * width));
    const reach = Math.min(lenCells, 8);
    // Only a clear step: one side darkened along most of the border, the other hardly.
    const upper = ev > 0 ? b : a;
    const steady = !!lower && !!upper && lower.strong / lower.n >= 0.5 && upper.strong / upper.n <= 0.25;
    const big = regions[u].n >= 2 * px * px && regions[v].n >= 2 * px * px;
    if (Math.abs(ev) > 0.15 && steady && big && lenCells >= 1.5 && d >= 0.5) {
      const sure = Math.min(1, Math.abs(ev) / 0.2);
      clues.push(ev > 0 ? { a: u, b: v, d, w: reach * sure, kind: "shade" } : { a: v, b: u, d, w: reach * sure, kind: "shade" });
    } else {
      clues.push({ a: u, b: v, d: 0, w: reach, kind: "level" });
    }
  }
  return { dir, strength, clues };
}

/**
 * Heights that best keep the clues: `fixed` ones (water) held, the rest
 * pulled lightly to 0 (so a region nothing says anything of stays there).
 */
export function solveHeights(R: number, clues: Clue[], fixed: Map<number, number>, area: number[], iterations = 400): Float64Array {
  const h = new Float64Array(R);
  for (const [r, v] of fixed) h[r] = v;
  const by: { o: number; d: number; w: number }[][] = Array.from({ length: R }, () => []);
  for (const c of clues) {
    by[c.a].push({ o: c.b, d: -c.d, w: c.w });
    by[c.b].push({ o: c.a, d: c.d, w: c.w });
  }
  for (let it = 0; it < iterations; it++) {
    let moved = 0;
    for (let r = 0; r < R; r++) {
      if (fixed.has(r)) continue;
      const pull = 0.02 * Math.sqrt(area[r] + 1);
      let sw = pull, s = 0;
      for (const { o, d, w } of by[r]) {
        s += w * (h[o] + d);
        sw += w;
      }
      const v = s / sw;
      moved = Math.max(moved, Math.abs(v - h[r]));
      h[r] = v;
    }
    if (moved < 1e-4) break;
  }
  return h;
}

/** Rounded to `step`, and moved so the most ground (by area, `ground` regions) is at 0. */
export function settle(h: Float64Array, area: number[], ground: boolean[], step = 0.5): Float64Array {
  const q = h.map((v) => Math.round(v / step) * step);
  const tally = new Map<number, number>();
  q.forEach((v, r) => {
    if (ground[r]) tally.set(v, (tally.get(v) ?? 0) + area[r]);
  });
  let mode = 0, most = -1;
  for (const [v, a] of tally) {
    if (a > most) {
      most = a;
      mode = v;
    }
  }
  return q.map((v, r) => (ground[r] ? v - mode : v));
}
