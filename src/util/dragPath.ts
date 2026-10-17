import type { Vector2 } from "@owlbear-rodeo/sdk";

// A token dragged by an extension is saved by writing its new position,
// and Owlbear stops a move at the dynamic fog's walls (its own, or Smoke &
// Spectre's) along the straight line from where it was: dragged around a
// corner, it'd be stopped at the wall it never crossed. So the move is
// saved along the way it was really dragged, a few steps that each keep
// clear of the walls the drag went around (its turns, by Ramer–Douglas–Peucker).

/** A dragged token's way: where it's been, as it went (raw, not snapped). */
export class DragPath {
  private points: Vector2[] = [];

  constructor(start?: Vector2) {
    if (start) {
      this.points.push(start);
    }
  }

  /** Where it is now, if it's moved far enough from the last point kept (`spacing`, scene px). */
  add(point: Vector2, spacing: number) {
    const last = this.points[this.points.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= spacing) {
      this.points.push(point);
    }
  }

  /** The steps to save it in, ending at `end`: its turns sharper than `tolerance` (scene px) off a straight line. */
  steps(end: Vector2, tolerance: number): Vector2[] {
    const all = [...this.points, end];
    if (all.length <= 2) {
      return [end];
    }
    return simplify(all, tolerance).slice(1);
  }
}

function simplify(points: Vector2[], tolerance: number): Vector2[] {
  if (points.length <= 2) {
    return points;
  }
  const a = points[0];
  const b = points[points.length - 1];
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  let farthest = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const away =
      length > 0
        ? Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / length
        : Math.hypot(p.x - a.x, p.y - a.y);
    if (away > farthest) {
      farthest = away;
      index = i;
    }
  }
  if (farthest <= tolerance) {
    return [a, b];
  }
  return [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)];
}
