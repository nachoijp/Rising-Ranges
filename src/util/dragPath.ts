import type { Vector2 } from "@owlbear-rodeo/sdk";

// A token dragged by an extension is saved by writing its new position,
// and Owlbear stops a move at the dynamic fog's walls (its own, or Smoke &
// Spectre's) along the straight line from where it was: dragged around a
// corner, it'd be stopped at the wall it never crossed. So the move is
// saved along the way it was really dragged, in as few straight steps as
// keep clear of the walls (each as far along the way as a straight line
// from the last one goes without crossing one): Owlbear takes only a few
// writes at a time, and a long drag's every turn would be far too many.

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

  /**
   * The steps to save it in, ending at `end`: from where it began, each as far along the way as a
   * straight line from the last goes `clear` (no wall crossed); where even the next point of the way
   * isn't (it was dragged through a wall), that point (Owlbear stops it at the wall, as its own drag).
   */
  steps(end: Vector2, clear: (from: Vector2, to: Vector2) => boolean): Vector2[] {
    const all = [...this.points, end];
    if (all.length <= 2) {
      return [end];
    }
    const steps: Vector2[] = [];
    let at = 0;
    while (at < all.length - 1) {
      let next = at + 1;
      if (clear(all[at], all[next])) {
        while (next + 1 < all.length && clear(all[at], all[next + 1])) {
          next++;
        }
      }
      steps.push(all[next]);
      at = next;
    }
    return steps;
  }
}
