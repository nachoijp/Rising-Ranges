import { G, apply, cellKey, covers, inverse, nearestOnLoops, type Layer, type Relief } from "../relief";
import type { Detail } from "../types";

// The terrain brush: what's on top where it goes — the ground, or a terrain
// shape's own painted relief (never a standing shape's top). A point just past
// a shape's outline paints its relief too, so it's whole up to its edge.
// Smoothing pulls each point toward the terrain round it, every layer counted
// (a wall between a shape and what's beside it slopes away). With "only the
// ground", just the ground, under the shapes too; smoothed, it's still pulled
// toward the shapes beside it, their edges holding it to their height there.

export type BrushKind = "raise" | "lower" | "flatten" | "smooth";
export const BRUSHES: readonly BrushKind[] = ["raise", "lower", "flatten", "smooth"];

export type BrushOptions = { kind: BrushKind; radius: number; strength: number; level: number; groundOnly: boolean };

/** What the brush finds where no shape is. */
const GROUND = "ground" as const;
type Owner = Layer | typeof GROUND | null;

type Dab = {
  /** The ground's points, or a shape's relief. */
  grid: Float32Array | Map<number, number>;
  k: number;
  x: number;
  y: number;
  /** Whether it's what's seen there (not just under the edge of something else). */
  own: boolean;
  layer: Layer | typeof GROUND;
  /** Deep under a shape (only the ground): smoothed with the ground round it alone. */
  deep?: boolean;
  /** Smoothing beside or under a shape's edge (only the ground): its height there. */
  pin?: number;
};

/** One dab of the brush at `p` (cells). */
export function paintBrush(relief: Relief, p: { x: number; y: number }, o: BrushOptions) {
  const { kind, radius: R } = o;
  const reach = kind === "flatten" ? R + 1 : R;
  const ground = relief.data.ground;
  const fall = (x: number, y: number) => {
    const t = Math.hypot(x - p.x, y - p.y) / R;
    return t >= 1 ? 0 : 1 - t * t;
  };
  const weight = (x: number, y: number) => {
    if (kind === "flatten") {
      // Full inside the brush, fading over a cell past it.
      const e = Math.hypot(x - p.x, y - p.y);
      return e <= R ? 1 : Math.max(0, 1 - (e - R));
    }
    return fall(x, y);
  };
  // The terrain as it's seen (but standing shapes' tops): what smoothing evens out, even when only the ground changes.
  const terrain = (x: number, y: number) => relief.evaluate(x, y, Infinity, (layer) => !!layer.stand);
  /** The layer on top at a point (null: a standing shape's; GROUND: none). */
  const ownerAt = (x: number, y: number): Owner => {
    for (let i = relief.layers.length - 1; i >= 0; i--) {
      const layer = relief.layers[i];
      if (covers(layer, x, y)) {
        return layer.stand ? null : layer;
      }
    }
    return GROUND;
  };
  const near = new Map<string, Set<Owner>>();
  /** The layers on top at a point and round it (a cell away). */
  const ownersNear = (x: number, y: number) => {
    const key = `${x.toFixed(4)},${y.toFixed(4)}`;
    let set = near.get(key);
    if (!set) {
      set = new Set();
      for (const dy of [-G, 0, G]) {
        for (const dx of [-G, 0, G]) {
          set.add(ownerAt(x + dx, y + dy));
        }
      }
      near.set(key, set);
    }
    return set;
  };
  /** Beside shapes: the nearest one's height at its edge, the nearest point of it. */
  const pinBeside = (owners: Set<Owner>, x: number, y: number) => {
    let best: number | undefined;
    let d = Infinity;
    for (const layer of owners) {
      if (layer === GROUND || !layer) {
        continue;
      }
      const edge = nearestOnLoops(layer.loops, x, y);
      if (edge.d < d) {
        d = edge.d;
        best = relief.surface(layer, edge.x, edge.y);
      }
    }
    return best;
  };
  // Every point of every grid the brush reaches.
  const points: Dab[] = [];
  const i0 = Math.max(0, Math.floor((p.x - reach) / G));
  const j0 = Math.max(0, Math.floor((p.y - reach) / G));
  const i1 = Math.min(relief.gw - 1, Math.ceil((p.x + reach) / G));
  const j1 = Math.min(relief.gh - 1, Math.ceil((p.y + reach) / G));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const [x, y] = [i * G, j * G];
      if (weight(x, y) <= 0) {
        continue;
      }
      const k = j * relief.gw + i;
      const top = ownerAt(x, y);
      if (o.groundOnly) {
        const owners = ownersNear(x, y);
        const seen = top === GROUND;
        const dab: Dab = { grid: ground, k, x, y, own: seen, deep: !seen && !owners.has(GROUND), layer: GROUND };
        // Smoothing, a shape's edge holds: the ground at it (under it, or just beside it) goes to its height there.
        if (kind === "smooth" && !dab.deep) {
          dab.pin = seen ? pinBeside(owners, x, y) : top ? relief.surface(top, x, y) : undefined;
        }
        points.push(dab);
        continue;
      }
      if (top === GROUND || ownersNear(x, y).has(GROUND)) {
        points.push({ grid: ground, k, x, y, own: top === GROUND, layer: GROUND });
      }
    }
  }
  if (!o.groundOnly) {
    for (const layer of relief.layers) {
      const { x0, y0, x1, y1 } = layer.box;
      if (layer.stand || x1 + G < p.x - reach || x0 - G > p.x + reach || y1 + G < p.y - reach || y0 - G > p.y + reach) {
        continue;
      }
      const shape = relief.data.shapes[layer.si];
      const detail: Detail = shape.detail ?? { m: [1, 0, 0, 1, 0, 0], v: new Map() };
      // Its own points (in its frame) under the brush.
      const inv = inverse(detail.m);
      const corners = [
        [p.x - reach, p.y - reach],
        [p.x + reach, p.y - reach],
        [p.x + reach, p.y + reach],
        [p.x - reach, p.y + reach],
      ].map(([x, y]) => apply(inv, x, y));
      const us = corners.map((c) => c[0] / G);
      const vs = corners.map((c) => c[1] / G);
      let any = false;
      for (let v = Math.floor(Math.min(...vs)); v <= Math.ceil(Math.max(...vs)); v++) {
        for (let u = Math.floor(Math.min(...us)); u <= Math.ceil(Math.max(...us)); u++) {
          const [x, y] = apply(detail.m, u * G, v * G);
          if (weight(x, y) <= 0) {
            continue;
          }
          const top = ownerAt(x, y);
          if (top === layer || ownersNear(x, y).has(layer)) {
            points.push({ grid: detail.v, k: cellKey(u, v), x, y, own: top === layer, layer });
            any = true;
          }
        }
      }
      if (any && !shape.detail) {
        shape.detail = detail;
        layer.detail = detail;
      }
    }
  }
  /** A point's height as its own grid has it (the ground's, or the shape's surface with its relief). */
  const ownHeight = (q: Dab) => (q.layer === GROUND ? ground[q.k] : relief.surface(q.layer, q.x, q.y));
  // All measured first, then all changed: each point from the terrain as it was.
  const changes = points.map((q) => {
    // On top, its change is what's seen; under the edge of another, its own height's.
    // (Only the ground, levelled: the ground's own height, under shapes too.)
    const now = q.own && !(o.groundOnly && kind === "flatten") ? terrain(q.x, q.y) : ownHeight(q);
    if (kind === "raise" || kind === "lower") {
      return (kind === "raise" ? 1 : -1) * o.strength * 0.15 * fall(q.x, q.y);
    }
    if (kind === "flatten") {
      return (o.level - now) * weight(q.x, q.y);
    }
    if (q.pin !== undefined) {
      return (q.pin - ground[q.k]) * 0.5 * fall(q.x, q.y);
    }
    const round = q.deep ? (x: number, y: number) => relief.relief(x, y) : terrain;
    let total = 0;
    for (const dy of [-G, 0, G]) {
      for (const dx of [-G, 0, G]) {
        total += round(q.x + dx, q.y + dy);
      }
    }
    return (total / 9 - now) * 0.5 * fall(q.x, q.y);
  });
  points.forEach((q, n) => {
    if (q.grid === ground) {
      ground[q.k] += changes[n];
    } else {
      const grid = q.grid as Map<number, number>;
      const v = (grid.get(q.k) ?? 0) + changes[n];
      if (Math.abs(v) < 1e-4) {
        grid.delete(q.k);
      } else {
        grid.set(q.k, v);
      }
    }
  });
}
