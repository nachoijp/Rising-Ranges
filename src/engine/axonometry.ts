import type { GridType } from "@owlbear-rodeo/sdk";
import type { BandShape } from "./types";

// Owlbear's isometric and dimetric grids draw the floor squashed: each cell
// is a rhombus `axonometry` × dpi wide and dpi tall (√3 isometric, 2
// dimetric; measured live). Everything here takes `axonometry` = 0 for a
// flat grid (square or hex), where the screen already is the floor.

/** A grid's rhombus width/height ratio, or 0 when it isn't axonometric. */
export function axonometryOf(type: GridType): number {
  switch (type) {
    case "ISOMETRIC":
      return Math.sqrt(3);
    case "DIMETRIC":
      return 2;
    default:
      return 0;
  }
}

/**
 * A screen offset as a floor offset, in the same units: along the grid's
 * two axes on an axonometric grid (so "cubic" squares are the grid's own
 * cells), unchanged on a flat one.
 */
export function toFloor(dx: number, dy: number, axonometry: number): { x: number; y: number } {
  if (!axonometry) {
    return { x: dx, y: dy };
  }
  return { x: dy + dx / axonometry, y: dy - dx / axonometry };
}

/**
 * How big a floor shape of the given radius (px) looks on screen: a circle
 * as an ellipse, a square (the grid's own cell shape) as a rhombus —
 * `halfWidth`/`halfHeight` are from its center to its sides (ellipse) or
 * corners (rhombus).
 */
export function floorExtent(
  radius: number,
  shape: BandShape,
  axonometry: number
): { halfWidth: number; halfHeight: number } {
  if (!axonometry) {
    return { halfWidth: radius, halfHeight: radius };
  }
  if (shape === "square") {
    return { halfWidth: radius * axonometry, halfHeight: radius };
  }
  return { halfWidth: (radius * axonometry) / Math.SQRT2, halfHeight: radius / Math.SQRT2 };
}
