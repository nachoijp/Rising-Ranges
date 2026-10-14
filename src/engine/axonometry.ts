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
 * Whether tokens can be drawn at their height on this grid (see isoLift.ts):
 * the axonometric ones, and hex — flat to Owlbear, but used with art drawn
 * in perspective, where height goes straight up the screen.
 */
export function liftsOn(type: GridType): boolean {
  return axonometryOf(type) > 0 || type === "HEX_VERTICAL" || type === "HEX_HORIZONTAL";
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
  // Shaped like a cell (see hex.ts): its sides `radius` away, its corners further — sideways on hexHorizontal, up and down on hexVertical.
  if (shape === "hexHorizontal") {
    return { halfWidth: radius / Math.cos(Math.PI / 6), halfHeight: radius };
  }
  if (shape === "hexVertical") {
    return { halfWidth: radius, halfHeight: radius / Math.cos(Math.PI / 6) };
  }
  if (!axonometry) {
    return { halfWidth: radius, halfHeight: radius };
  }
  if (shape === "square") {
    return { halfWidth: radius * axonometry, halfHeight: radius };
  }
  return { halfWidth: (radius * axonometry) / Math.SQRT2, halfHeight: radius / Math.SQRT2 };
}
