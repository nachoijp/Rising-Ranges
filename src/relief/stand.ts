import type { Box } from "./geom";
import type { Pt, StandEdge } from "./types";

// Standing shapes (the Vistazo's "De pie"): what the map draws from the front
// (a statue, a wall) turned up on one of its edges. Of four corners (a wall
// drawn in perspective, or slanting), it stands on one of its own sides and is
// unfolded up to the side across; otherwise on its box's edge.

export type Face = "bottom" | "top" | "left" | "right";

/** Which way each box edge faces (cells, y down). */
export const FACES: Record<Face, Pt> = { bottom: [0, 1], top: [0, -1], right: [1, 0], left: [-1, 0] };

/** Where a standing shape stands: `base` on the ground, the way its front faces (`out`); of four corners, `top` the side across; of a box, its `edge`. */
export type StandSide = { base: [Pt, Pt]; out: Pt; top?: [Pt, Pt]; edge?: Face };

/**
 * An outline's real corners: no point repeated, nor one nearly on the line
 * between its neighbours (a click along a side), so four clicked corners count as four.
 */
export function corners(ring: Pt[]): Pt[] {
  let points = ring.filter((p, i) => {
    const q = ring[(i + 1) % ring.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6;
  });
  // The straightest point dropped while any turns under ~8°.
  for (;;) {
    if (points.length <= 3) {
      return points;
    }
    let straightest = -1;
    let least = Infinity;
    points.forEach((p, i) => {
      const a = points[(i - 1 + points.length) % points.length];
      const b = points[(i + 1) % points.length];
      const [ux, uy, vx, vy] = [p[0] - a[0], p[1] - a[1], b[0] - p[0], b[1] - p[1]];
      const turn = Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
      if (turn < least) {
        least = turn;
        straightest = i;
      }
    });
    if (least > 0.15) {
      return points;
    }
    points = points.filter((_, i) => i !== straightest);
  }
}

/** The box edge a standing shape turns up on: the one asked for, or the one facing the map's middle (`w` × `h`). */
export function standEdge(stand: StandEdge, box: Box, w: number, h: number): Face {
  if (stand !== "auto") {
    return stand;
  }
  const dx = w / 2 - (box.x0 + box.x1) / 2;
  const dy = h / 2 - (box.y0 + box.y1) / 2;
  return Math.abs(dy) >= Math.abs(dx) ? (dy >= 0 ? "bottom" : "top") : dx >= 0 ? "right" : "left";
}

/**
 * Where a standing shape stands. Of four corners, one of its own sides (the
 * one asked for faces that way most; on auto, the one nearest the map's
 * middle) with `top` the side across, each end on its own side; otherwise
 * its box's edge.
 */
export function standSide(stand: StandEdge, ring: Pt[], box: Box, w: number, h: number): StandSide {
  const quad = corners(ring);
  if (quad.length === 4) {
    const [cx, cy] = [quad.reduce((t, q) => t + q[0], 0) / 4, quad.reduce((t, q) => t + q[1], 0) / 4];
    const sides = quad.map((a, i) => {
      const b = quad[(i + 1) % 4];
      const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      let out: Pt = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
      // Pointing away from the middle of the four points.
      if (out[0] * (mx - cx) + out[1] * (my - cy) < 0) {
        out = [-out[0], -out[1]];
      }
      return { i, mx, my, out };
    });
    const [wx, wy] = [w / 2, h / 2];
    const face = stand === "auto" ? null : FACES[stand];
    const pick = sides.reduce((best, e) =>
      face
        ? e.out[0] * face[0] + e.out[1] * face[1] > best.out[0] * face[0] + best.out[1] * face[1]
          ? e
          : best
        : Math.hypot(e.mx - wx, e.my - wy) < Math.hypot(best.mx - wx, best.my - wy)
          ? e
          : best
    );
    const at = (k: number) => quad[(pick.i + k) % 4];
    return { base: [at(0), at(1)], top: [at(3), at(2)], out: pick.out };
  }
  const { x0, y0, x1, y1 } = box;
  const edge = standEdge(stand, box, w, h);
  const bases: Record<Face, [Pt, Pt]> = {
    bottom: [[x0, y1], [x1, y1]],
    top: [[x0, y0], [x1, y0]],
    left: [[x0, y0], [x0, y1]],
    right: [[x1, y0], [x1, y1]],
  };
  return { base: bases[edge], out: FACES[edge], edge };
}

/** How tall a standing shape's picture is: across its box, or from its base to the side across. */
export function standDepth(side: StandSide, box: Box): number {
  if (side.top) {
    const [[ax, ay], [bx, by]] = side.base;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const away = ([x, y]: Pt) => Math.abs((x - ax) * (by - ay) - (y - ay) * (bx - ax)) / len;
    return (away(side.top[0]) + away(side.top[1])) / 2;
  }
  return side.edge === "top" || side.edge === "bottom" ? box.y1 - box.y0 : box.x1 - box.x0;
}
