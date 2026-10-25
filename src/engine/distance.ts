import { DistanceMetric } from "./types";

/** 3D distance between two points offset by (dx, dy, dz), per the configured metric. */
export function distance3D(
  dx: number,
  dy: number,
  dz: number,
  metric: DistanceMetric
): number {
  switch (metric) {
    case "spherical":
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    case "cubic":
      return Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
    case "cylindrical":
      return Math.max(Math.sqrt(dx * dx + dy * dy), Math.abs(dz));
    case "octagonal":
      // Alternating diagonals (5-10-5): on the ground the longer leg and half the shorter (whole
      // squares, as counted at the table), then the same between that and the height.
      return alternate(alternate(Math.abs(dx), Math.abs(dy)), Math.abs(dz));
  }
}

/**
 * Two legs (in squares) by the 5-10-5 rule: the longer, plus one square for every second diagonal
 * (half the shorter, rounded down): 1 diagonal is 1 square, 2 are 3, 3 are 4, 4 are 6. A hair of
 * slack so that 3.9999999 squares (floating point) still count as 4.
 */
function alternate(a: number, b: number): number {
  return Math.max(a, b) + Math.floor(Math.min(a, b) / 2 + 1e-6);
}

// Every Banda radius is implicitly calibrated against a "standard" 1×1
// token on both ends (e.g. Melee = 1 grid unit = two adjacent standard
// tokens' combined half-radii) — half a grid unit, in the same internal
// grid-cell units centerDistance/band.radius/getTokenRadius already use.
const STANDARD_TOKEN_RADIUS = 0.5;

/**
 * How much of a token's radius exceeds the standard baseline every Banda
 * radius already assumes. Zero for a token at or below standard size —
 * only real excess bulk (a Large/Huge token, on either the Origen or the
 * target's end) should be able to stretch or shrink a Lectura's effective
 * distance; a standard-sized token contributes nothing, at any tolerance.
 */
export function excessRadius(radius: number): number {
  return Math.max(0, radius - STANDARD_TOKEN_RADIUS);
}

export const DEFAULT_TOLERANCE = 50;

/**
 * How high a token's body sits, for measuring: its height marks its feet,
 * so a bigger token's middle is higher up. Only the part above a standard
 * token's counts (the same baseline as excessRadius), so tokens of standard
 * size or smaller standing on the same level are level with each other.
 */
export function bodyCenterHeight(height: number, radius: number): number {
  return height + excessRadius(radius);
}

/**
 * The gap between two tokens' bodies, in grid units: the ground gap and the
 * height gap are each taken apart (center distance minus both tokens'
 * excess bulk, never below 0), then combined per the metric. Measuring each
 * axis apart means tokens side by side on the ground always read as
 * touching, whatever their sizes; with "cubic" it's exactly the distance
 * between two cubes. `dz` is the difference of their bodyCenterHeight.
 */
export function bodyDistance(
  dx: number,
  dy: number,
  dz: number,
  excessRadiusSum: number,
  metric: DistanceMetric
): { distance: number; horizontal: number; vertical: number } {
  const horizontal = Math.max(0, distance3D(dx, dy, 0, metric) - excessRadiusSum);
  const vertical = Math.max(0, Math.abs(dz) - excessRadiusSum);
  return { distance: distance3D(horizontal, 0, vertical, metric), horizontal, vertical };
}

/**
 * The distance a Banda is matched against: the body distance minus the
 * Tolerancia margin `tolerance` (0-1 grid cells), which only ever makes
 * tokens count as closer. The number shown to people is the body distance
 * itself — Tolerancia is a matching margin, not part of how far apart they
 * really are.
 */
export function matchedDistance(distance: number, tolerance: number): number {
  return distance - tolerance;
}
