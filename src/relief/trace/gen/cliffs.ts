// Cliffs: a painted map shows a cliff's face as a band of rock (brownish,
// darker than the ground, grainy) between the ground on top and the ground at
// its foot. How wide the band is says about how high the cliff is (a level a
// cell). Which side is on top: the one further from the water, walking over
// the ground (a coast's beach is by the sea, its cliff tops away from it).
// Without water nothing says which side is on top, and no clue is given.

import type { Clue, Look } from "./heights";
import type { Region } from "./regions";

export type Band = { regions: number[]; area: number; width: number; rise: number };

/** Rock: brownish or dark grey-brown (not green, not blue), not light, with some grain. */
export const isRock = (r: Region) => r.tex > 1.5 && ((r.A > 2 && r.B > 8 && r.L < 50) || (r.A > -4 && r.B > 2 && r.B < 20 && r.L < 40));

export function cliffClues(regions: Region[], looks: Look[], rock: boolean[], borders: Map<number, number>[], px: number, outdoors: boolean[]): { clues: Clue[]; bands: Band[] } {
  const R = regions.length;
  // Bands: rock regions that touch, together.
  const band = new Int32Array(R).fill(-1);
  const bands: Band[] = [];
  for (let s = 0; s < R; s++) {
    if (!rock[s] || band[s] >= 0) continue;
    const list = [s];
    band[s] = bands.length;
    for (let k = 0; k < list.length; k++)
      for (const t of borders[list[k]]?.keys() ?? []) {
        if (rock[t] && band[t] < 0) {
          band[t] = bands.length;
          list.push(t);
        }
      }
    let area = 0, edge = 0;
    for (const r of list) {
      area += regions[r].n / (px * px);
      for (const [t, len] of borders[r] ?? []) if (band[t] !== bands.length) edge += len / px;
    }
    const width = edge > 0 ? (2 * area) / edge : 0;
    bands.push({ regions: list, area, width, rise: Math.max(1, Math.min(6, Math.round(width))) });
  }
  // How far each region is from water, walking over what isn't rock (cells, middle to middle).
  const far = new Float64Array(R).fill(Infinity);
  const queue: number[] = [];
  looks.forEach((l, r) => {
    if (l.material === "water") {
      far[r] = 0;
      queue.push(r);
    }
  });
  // A plain Dijkstra (few hundred regions): the nearest unsettled one each time.
  const settled = new Uint8Array(R);
  for (;;) {
    let r = -1;
    for (const q of queue) if (!settled[q] && (r < 0 || far[q] < far[r])) r = q;
    if (r < 0) break;
    settled[r] = 1;
    for (const t of borders[r]?.keys() ?? []) {
      if (rock[t] || settled[t]) continue;
      const d = far[r] + Math.hypot(regions[r].x - regions[t].x, regions[r].y - regions[t].y) / px;
      if (d < far[t]) {
        if (far[t] === Infinity) queue.push(t);
        far[t] = d;
      }
    }
  }
  const clues: Clue[] = [];
  bands.forEach((b) => {
    if (b.area < 2 || b.width < 0.6) return;
    const nbrs = new Map<number, number>();
    for (const r of b.regions)
      for (const [t, len] of borders[r] ?? []) {
        if (rock[t] || looks[t].material !== "ground" || !outdoors[t]) continue;
        nbrs.set(t, (nbrs.get(t) ?? 0) + len / px);
      }
    const list = [...nbrs].filter(([t, len]) => len >= 0.8 && Number.isFinite(far[t]));
    if (list.length < 2) return;
    list.sort((p, q) => far[p[0]] - far[q[0]]);
    const [low] = list[0];
    for (const [t, len] of list.slice(1)) {
      if (far[t] - far[low] < Math.max(3, 2 * b.width)) continue;
      clues.push({ a: low, b: t, d: b.rise, w: 3 * Math.min(len, 8), kind: "shade" });
    }
  });
  return { clues, bands };
}
