// Whether the terrain hides one point from another: along the line between
// them, the ground anywhere above it. As the Vistazo's own lines between
// tokens tell (VistazoView.inSight): from eye to eye, a little over each one,
// not counting what's right round either (their own bump of ground).

/** How far over a token (grid units) its eye is. */
export const EYE = 0.8;

/**
 * Clear from `a` to `b` (scene px; `z` grid units up): `heightAt` (grid
 * units, at a scene point) never over the line. `dpi`: scene px a cell.
 */
export function inSight(heightAt: (x: number, y: number) => number, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, dpi: number): boolean {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const step = dpi / 8;
  const clear = dpi * 0.4;
  for (let d = clear; d < length - clear; d += step) {
    const t = d / length;
    const z = a.z + (b.z - a.z) * t;
    if (z < heightAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) - 0.02) {
      return false;
    }
  }
  return true;
}
