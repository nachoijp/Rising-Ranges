import type { MultiPolygon } from "polygon-clipping";
import clip from "../../terrain/clip";
import { bridgeHighest, bridgeTop, inShape, type Bridge, type VistazoScene } from "../scene";

// What's under a bridge, as numbers (see VistazoView.buildUnderBridges, which draws it): the box its
// fill covers, and its underside's heights over it. Plain arrays, so they can be worked out away from
// the page too (see terrainWorker).

/** The longest side of a bridge's fill (see bridgeFill), texels. */
export const FILL_SIZE = 192;
/** How far past a bridge's outline its fill reaches (cells): over its drawn edge, which the outline seldom follows exactly. */
export const FILL_GROW = 0.15;
/** A bridge's underside's texels for each cell (at most its fill's): a small one (a statue's arm) takes a few, not FILL_SIZE². */
const UNDER_PER_CELL = 8;

/** The texels a bridge's fill takes (scene px): over its outline's box, `grow` and four texels wider, its longest side FILL_SIZE. */
export function fillFrame(shape: MultiPolygon, grow: number): { x0: number; y0: number; step: number; cols: number; rows: number } {
  const points = shape.flat(2);
  const [sx0, sx1] = [Math.min(...points.map((p) => p[0])) - grow, Math.max(...points.map((p) => p[0])) + grow];
  const [sy0, sy1] = [Math.min(...points.map((p) => p[1])) - grow, Math.max(...points.map((p) => p[1])) + grow];
  const step = Math.max(1e-6, sx1 - sx0, sy1 - sy0) / (FILL_SIZE - 8);
  const [x0, y0] = [sx0 - step * 4, sy0 - step * 4];
  const [cols, rows] = [Math.ceil((sx1 - sx0) / step) + 8, Math.ceil((sy1 - sy0) / step) + 8];
  return { x0, y0, step, cols, rows };
}

/** Whether a scene point is within `reach` of an outline's sides (holes' too). */
export function nearOutline(multi: MultiPolygon, x: number, y: number, reach: number): boolean {
  for (const ring of multi.flat()) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const [ax, ay] = ring[i];
      const [ex, ey] = [ring[i + 1][0] - ax, ring[i + 1][1] - ay];
      const len2 = ex * ex + ey * ey;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / len2)) : 0;
      if ((ax + ex * t - x) ** 2 + (ay + ey * t - y) ** 2 < reach * reach) {
        return true;
      }
    }
  }
  return false;
}

/** Slabs filled under as one (see fillGroups): their indexes in the scene's bridges, and their outlines' union (scene px). */
export type FillGroup = { members: number[]; shape: MultiPolygon };

/**
 * The slabs filled under (all but those that keep the map), in groups: those over one another or
 * touching, at the same heights (a statue's body, arms and what it holds), as one, their fill worked out once over their
 * outlines' union, so no two copies of the same ground fight over it. One mirroring (a bridge over a
 * river) on its own: its fill follows its own frame. In the scene's order.
 */
export function fillGroups(scene: VistazoScene): FillGroup[] {
  const filled = scene.bridges.map((bridge, i) => ({ bridge, i })).filter(({ bridge }) => bridge.under !== "keep");
  const boxOf = (shape: MultiPolygon) => {
    const ps = shape.flat(2);
    return { x0: Math.min(...ps.map(([x]) => x)), y0: Math.min(...ps.map(([, y]) => y)), x1: Math.max(...ps.map(([x]) => x)), y1: Math.max(...ps.map(([, y]) => y)) };
  };
  const boxes = filled.map(({ bridge }) => boxOf(bridge.shape));
  // Union-find over those that may join (not a mirroring one): by their boxes first, then their outlines.
  const parent = filled.map((_, k) => k);
  const root = (k: number): number => (parent[k] === k ? k : (parent[k] = root(parent[k])));
  const touch = scene.dpi * 0.02;
  for (let a = 0; a < filled.length; a++) {
    for (let b = a + 1; b < filled.length; b++) {
      if (filled[a].bridge.under === "mirror" || filled[b].bridge.under === "mirror") {
        continue;
      }
      const [p, q] = [boxes[a], boxes[b]];
      if (p.x1 + touch < q.x0 || q.x1 + touch < p.x0 || p.y1 + touch < q.y0 || q.y1 + touch < p.y0 || root(a) === root(b)) {
        continue;
      }
      // Only at the same heights too (a statue's pieces), not one on another (an eagle on a roof, a
      // statue on a balcony: the lower one's own fill stops at it, see undersideBuffers' below).
      const [sa, sb] = [filled[a].bridge, filled[b].bridge];
      if (bridgeHighest(sa) <= sb.bottom + 0.01 || bridgeHighest(sb) <= sa.bottom + 0.01) {
        continue;
      }
      let meet = false;
      try {
        meet = clip.intersection(filled[a].bridge.shape, filled[b].bridge.shape).length > 0;
      } catch {
        meet = false;
      }
      if (meet) {
        parent[root(b)] = root(a);
      }
    }
  }
  const groups = new Map<number, number[]>();
  filled.forEach((_, k) => groups.set(root(k), [...(groups.get(root(k)) ?? []), k]));
  return [...groups.values()].map((ks) => {
    const members = ks.map((k) => filled[k].i);
    const shapes = ks.map((k) => filled[k].bridge.shape);
    let shape = shapes[0];
    if (shapes.length > 1) {
      try {
        shape = clip.union(shapes[0], ...shapes.slice(1));
      } catch {
        // Their outlines as they are (overlapping), then.
        shape = shapes.flat();
      }
    }
    return { members, shape };
  });
}

/**
 * A group of slabs' underside over its fill's box (see fillFrame), RGBA texels: its height (view units,
 * `k` per height unit; r: where several are over a point, the highest of their undersides; off them, the
 * nearest's), and where a shape keeping its look is (g: 1 inside, 0.5 just round it, for its walls), and
 * the top of the highest slab under it (b: its fill doesn't go below that). One texel if it's one flat
 * slab with none of those under it; else UNDER_PER_CELL a cell (its fill's at most).
 */
export function undersideBuffers(scene: VistazoScene, group: FillGroup, k: number): { cols: number; rows: number; heights: Float32Array } {
  const members = group.members.map((i) => scene.bridges[i]);
  const frame = fillFrame(group.shape, scene.dpi * FILL_GROW);
  const area = { x: frame.x0, y: frame.y0, z: frame.cols * frame.step, w: frame.rows * frame.step };
  const reach = scene.dpi * 0.12;
  // Each with its box (and reach round it): a texel outside it isn't tested against its outline.
  const keeping = (scene.unfilled ?? []).flatMap((multi) => {
    const ps = multi.flat(2);
    const [x0, x1] = [Math.min(...ps.map(([x]) => x)) - reach, Math.max(...ps.map(([x]) => x)) + reach];
    const [y0, y1] = [Math.min(...ps.map(([, y]) => y)) - reach, Math.max(...ps.map(([, y]) => y)) + reach];
    return x1 >= area.x && x0 <= area.x + area.z && y1 >= area.y && y0 <= area.y + area.w ? [{ multi, x0, x1, y0, y1 }] : [];
  });
  // The slabs under it (not its own; their tops below its lowest top: under it, or one it's sunk into)
  // over its box: its fill stops at them (the ground under them is theirs to fill: a statue on a balcony
  // doesn't paint under both).
  const lowest = Math.min(...members.map((m) => m.top));
  const below = scene.bridges.flatMap((other) => {
    if (members.includes(other) || other.top >= lowest - 0.01) {
      return [];
    }
    const ps = other.shape.flat(2);
    const [x0, x1] = [Math.min(...ps.map(([x]) => x)), Math.max(...ps.map(([x]) => x))];
    const [y0, y1] = [Math.min(...ps.map(([, y]) => y)), Math.max(...ps.map(([, y]) => y))];
    return x1 >= area.x && x0 <= area.x + area.z && y1 >= area.y && y0 <= area.y + area.w ? [{ other, x0, x1, y0, y1 }] : [];
  });
  const one = members.length === 1 ? members[0] : null;
  const [cols, rows] =
    !one || one.surface || keeping.length > 0 || below.length > 0
      ? [Math.min(frame.cols, Math.max(2, Math.ceil((area.z / scene.dpi) * UNDER_PER_CELL))), Math.min(frame.rows, Math.max(2, Math.ceil((area.w / scene.dpi) * UNDER_PER_CELL)))]
      : [1, 1];
  const underOf = (m: Bridge, x: number, y: number) => (bridgeTop(m, x, y) - (m.top - m.bottom)) * k;
  const heights = new Float32Array(cols * rows * 4);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [x, y] = [area.x + ((c + 0.5) / cols) * area.z, area.y + ((r + 0.5) / rows) * area.w];
      // Under several: the highest underside (between them, what's under the lower one is in it anyway);
      // under none (its fill's edge, past their outlines): the nearest's.
      let under = -Infinity;
      for (const m of members) {
        if (members.length === 1 || inShape(x, y, m.shape)) {
          under = Math.max(under, underOf(m, x, y));
        }
      }
      if (under === -Infinity) {
        let best = Infinity;
        for (const m of members) {
          for (const ring of m.shape.flat()) {
            for (const [px, py] of ring) {
              const d = (px - x) ** 2 + (py - y) ** 2;
              if (d < best) {
                best = d;
                under = underOf(m, x, y);
              }
            }
          }
        }
      }
      heights[(r * cols + c) * 4] = under;
      // Inside: all of it (its top); just round it: only its walls (the ground there gets the fill).
      const near = keeping.filter((e) => x >= e.x0 && x <= e.x1 && y >= e.y0 && y <= e.y1);
      heights[(r * cols + c) * 4 + 1] = near.some((e) => inShape(x, y, e.multi)) ? 1 : near.some((e) => nearOutline(e.multi, x, y, reach)) ? 0.5 : 0;
      // The top of the highest slab under it there (b): nothing below that is filled; none, far down.
      let floor = -1e6;
      for (const e of below) {
        if (x >= e.x0 && x <= e.x1 && y >= e.y0 && y <= e.y1 && inShape(x, y, e.other.shape)) {
          floor = Math.max(floor, bridgeTop(e.other, x, y) * k);
        }
      }
      heights[(r * cols + c) * 4 + 2] = floor;
    }
  }
  return { cols, rows, heights };
}
