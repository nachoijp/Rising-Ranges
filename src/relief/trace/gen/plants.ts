// Trees and hedges from the picture. Leaves look alike on every map: green,
// coarse (light and dark specks side by side), darker than a lawn. Each pixel
// is scored for that, the score smoothed over a quarter cell and cut at half:
// the canopy. Its pieces are then filled with round crowns, biggest first (the
// distance to the canopy's edge says how big a crown fits where; a forest is
// many crowns). A piece too thin for a crown is a hedge. A trunk the plan
// knows (a small closed loop of it) makes sure there's a crown there.

import type { Pt } from "../../types";
import type { Img } from "./regions";
import { loopsOf, type Loop } from "./vector";

export type Tree = { x: number; y: number; r: number };
export type Plants = { canopy: Uint8Array; trees: Tree[]; hedges: Loop[] };

/** A crown at least this wide across (cells); a hedge at most this thick. */
const CROWN = 1;

/** `indoor`: pixels in a room (a carpet's green there isn't leaves unless it's lumpy). */
export function findPlants(img: Img, skip: Uint8Array, trunks: Pt[] = [], indoor?: Uint8Array): Plants {
  const { W, H, px, L, A, B, lump } = img;
  const n = W * H;
  // The lawn: the map's light greens (the upper fifth of its greens' lightness). Leaves are darker
  // than it and lumpy at half a cell (clusters), or quite dark (a crown's shaded heart).
  const greens: number[] = [];
  for (let i = 0; i < n; i += 7) if (!skip[i] && A[i] < -7 && B[i] > -2) greens.push(L[i]);
  greens.sort((a, b) => a - b);
  const lawn = greens.length ? greens[Math.floor(greens.length * 0.8)] : 75;
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (skip[i] || !(A[i] < -7 && B[i] > -2)) continue;
    const lumpy = L[i] < lawn - 14 && lump[i] > 2.5;
    score[i] = lumpy || (!indoor?.[i] && L[i] < Math.min(40, lawn - 25)) ? 1 : 0;
  }
  // Smoothed (box sums over a quarter cell), cut at half.
  const r = Math.max(1, Math.round(px / 4));
  const sum = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += score[y * W + x];
      sum[(y + 1) * (W + 1) + x + 1] = sum[y * (W + 1) + x + 1] + row;
    }
  }
  const canopy = new Uint8Array(n);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (skip[y * W + x]) continue;
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      const s = sum[y1 * (W + 1) + x1] - sum[y0 * (W + 1) + x1] - sum[y1 * (W + 1) + x0] + sum[y0 * (W + 1) + x0];
      if (s / ((x1 - x0) * (y1 - y0)) >= 0.5) canopy[y * W + x] = 1;
    }
  // Distance to the canopy's edge (chamfer 3-4, in pixels).
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) dist[i] = canopy[i] ? 1e9 : 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!dist[i]) continue;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 1);
      if (y > 0) d = Math.min(d, dist[i - W] + 1);
      if (x > 0 && y > 0) d = Math.min(d, dist[i - W - 1] + 1.414);
      if (x < W - 1 && y > 0) d = Math.min(d, dist[i - W + 1] + 1.414);
      if (x === 0 || y === 0 || x === W - 1) d = Math.min(d, 1);
      dist[i] = d;
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!dist[i]) continue;
      let d = dist[i];
      if (x < W - 1) d = Math.min(d, dist[i + 1] + 1);
      if (y < H - 1) d = Math.min(d, dist[i + W] + 1);
      if (x < W - 1 && y < H - 1) d = Math.min(d, dist[i + W + 1] + 1.414);
      if (x > 0 && y < H - 1) d = Math.min(d, dist[i + W - 1] + 1.414);
      if (y === H - 1) d = Math.min(d, 1);
      dist[i] = d;
    }
  // Crowns, biggest first: each takes its circle of the canopy.
  const free = Float32Array.from(dist);
  const order = Array.from({ length: n }, (_, i) => i).filter((i) => dist[i] >= (CROWN / 2) * px);
  order.sort((a, b) => dist[b] - dist[a]);
  const trees: Tree[] = [];
  const take = (cx: number, cy: number, rr: number) => {
    const R = Math.ceil(rr * px);
    const X = Math.round(cx * px), Y = Math.round(cy * px);
    for (let y = Math.max(0, Y - R); y < Math.min(H, Y + R + 1); y++)
      for (let x = Math.max(0, X - R); x < Math.min(W, X + R + 1); x++) if ((x - X) ** 2 + (y - Y) ** 2 <= R * R) free[y * W + x] = 0;
  };
  // The plan's trunks first.
  for (const [tx, ty] of trunks) {
    const i = Math.floor(ty * px) * W + Math.floor(tx * px);
    if (i < 0 || i >= n || !canopy[i]) continue;
    // Its crown: as far as the canopy goes round it (the widest circle round the trunk inside it, at least a crown's).
    let rr = CROWN / 2;
    for (let k = 1; k < 4 * px; k++) {
      let inside = 0, all = 0;
      for (let a = 0; a < 16; a++) {
        const x = Math.round(tx * px + Math.cos((a * Math.PI) / 8) * k), y = Math.round(ty * px + Math.sin((a * Math.PI) / 8) * k);
        all++;
        if (x >= 0 && y >= 0 && x < W && y < H && canopy[y * W + x]) inside++;
      }
      if (inside / all < 0.6) break;
      rr = k / px;
    }
    trees.push({ x: tx, y: ty, r: rr });
    take(tx, ty, rr);
  }
  for (const i of order) {
    if (free[i] === 0) continue;
    const x = ((i % W) + 0.5) / px, y = (Math.floor(i / W) + 0.5) / px;
    // As big as the canopy lets it, crowns round it overlapping a little.
    let rr = dist[i] / px + 0.1;
    for (const t of trees) rr = Math.min(rr, Math.hypot(t.x - x, t.y - y) - 0.6 * t.r);
    if (rr < CROWN / 2) continue;
    trees.push({ x, y, r: rr });
    take(x, y, rr);
  }
  // Hedges: what's left of the canopy in pieces no crown took any of, if they're long enough.
  const rest = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (canopy[i] && free[i] > 0) rest[i] = 1;
  const hedges = loopsOf(rest, W, H, px, 0.12, 1.2).filter((l) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of l.ring) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return Math.max(x1 - x0, y1 - y0) >= 2;
  });
  return { canopy, trees, hedges };
}

/** A crown's outline. */
export const crownRing = (t: Tree): Pt[] => {
  const k = Math.max(12, Math.min(28, Math.round(t.r * 12)));
  return Array.from({ length: k }, (_, i): Pt => [t.x + t.r * Math.cos((2 * Math.PI * i) / k), t.y + t.r * Math.sin((2 * Math.PI * i) / k)]);
};
