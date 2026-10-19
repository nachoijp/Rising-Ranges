import { inShape, pieceHeight, type VistazoScene } from "../scene";
import { FACING, LIGHT, type Wall } from "./types";

/**
 * The walls round every piece: each edge where the ground beside it is
 * lower (or there's none, the map's edge), from this piece's top down to
 * that, `base` (grid units) where there's nothing beside it.
 */
export function computeWalls(scene: VistazoScene, base: number): Wall[] {
  const probe = scene.dpi * 0.03;
  const l = Math.hypot(...LIGHT);
  // A ramp or a cloth about: its heights change along an edge.
  const sloped = scene.pieces.some((piece) => piece.slope || piece.surface);
  const walls: Wall[] = [];
  for (const piece of scene.pieces) {
    for (const polygon of piece.shape) {
      for (const ring of polygon) {
        for (let i = 0; i < ring.length - 1; i++) {
          const [ax, ay] = ring[i];
          const [bx, by] = ring[i + 1];
          const dx = bx - ax;
          const dy = by - ay;
          const len = Math.hypot(dx, dy);
          if (len < probe) {
            continue;
          }
          let nx = dy / len;
          let ny = -dx / len;
          const mx = (ax + bx) / 2;
          const my = (ay + by) / 2;
          if (inShape(mx + nx * probe, my + ny * probe, piece.shape)) {
            nx = -nx;
            ny = -ny;
          }
          // A standing block's front is the picture itself: an unfolded one's, its base edge only (its
          // slanting sides, wider than the picture, keep their walls); a box's, whatever faces its way.
          if (piece.unfold ? onBase(piece.unfold.base, mx, my, nx, ny, piece.unfold.out, probe * 3) : piece.stand && nx * FACING[piece.stand][0] + ny * FACING[piece.stand][1] > 0.5) {
            continue;
          }
          const lower = scene.pieceAt(mx + nx * probe, my + ny * probe);
          // With ramps about, every edge is cut in short steps: a ramp may meet it anywhere along
          // it (not only at its middle), and the heights on either side change there.
          // (A side already that short, a cloth's: see scene.ts, one step, at its own ends.)
          const steps = sloped ? Math.max(1, Math.ceil(len / (scene.dpi * 0.25) - 1e-6)) : 1;
          for (let j = 0; j < steps; j++) {
            const [px, py] = [ax + (dx * j) / steps, ay + (dy * j) / steps];
            const [qx, qy] = [ax + (dx * (j + 1)) / steps, ay + (dy * (j + 1)) / steps];
            const outP = scene.heightAt(px + nx * probe, py + ny * probe);
            const outQ = scene.heightAt(qx + nx * probe, qy + ny * probe);
            const edge = outP === undefined && outQ === undefined;
            const t0 = pieceHeight(piece, px, py);
            const t1 = pieceHeight(piece, qx, qy);
            // The higher side draws the wall: where this one's lower at an end, it narrows to nothing there.
            // Beside a ramp, down to the lowest ground along the step (its ends and middle): where a ramp
            // ends partway along, a straight line between the ends would leave a wedge open, and what
            // reaches below the ground is hidden under it.
            let low0 = outP ?? base;
            let low1 = outQ ?? base;
            if (steps > 1) {
              const outM = scene.heightAt((px + qx) / 2 + nx * probe, (py + qy) / 2 + ny * probe) ?? base;
              low0 = low1 = Math.min(low0, low1, outM);
            }
            const b0 = Math.min(t0, low0);
            const b1 = Math.min(t1, low1);
            // Not a hair of wall (a cloth meets the ground beside it at about its height).
            if (t0 - b0 < 0.02 && t1 - b1 < 0.02) {
              continue;
            }
            walls.push({
              style: piece.walls ?? lower?.walls,
              skin: piece.skin ?? (piece.walls ? undefined : lower?.skin),
              ax: px, ay: py, bx: qx, by: qy, t0, t1, b0, b1, edge,
              mx: (px + qx) / 2 - nx * probe * 3, my: (py + qy) / 2 - ny * probe * 3, nx, ny,
              lit: Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1]) / l),
            });
          }
        }
      }
    }
  }
  return walls;
}

/** Whether an edge (its middle, its outward normal) is on an unfolded zone's base edge: facing its way, on its line. */
function onBase(base: [[number, number], [number, number]], mx: number, my: number, nx: number, ny: number, out: [number, number], near: number): boolean {
  if (nx * out[0] + ny * out[1] < 0.98) {
    return false;
  }
  const [[ax, ay], [bx, by]] = base;
  const length = Math.hypot(bx - ax, by - ay) || 1;
  // Its distance from the base's line.
  return Math.abs(((mx - ax) * (by - ay) - (my - ay) * (bx - ax)) / length) < near;
}
