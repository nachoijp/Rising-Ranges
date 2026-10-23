import { inShape, pieceHeight, type VistazoScene } from "../scene";
import { LIGHT, type Wall } from "./types";

/** A box of the scene (px). */
export type Region = { x0: number; y0: number; x1: number; y1: number };

/**
 * The walls round every piece: each edge where the ground beside it is
 * lower (or there's none, the map's edge), from this piece's top down to
 * that, `base` (grid units) where there's nothing beside it.
 *
 * With `region`, only the edges that reach into it (the heights changed
 * there: a brush); `done` gets each such edge (see Wall.seg), walls or not.
 */
export function computeWalls(scene: VistazoScene, base: number, region?: Region, done?: Set<string>): Wall[] {
  const probe = scene.dpi * 0.03;
  const l = Math.hypot(...LIGHT);
  // A surface that isn't flat about: its heights change along an edge.
  const sloped = scene.pieces.some((piece) => piece.surface);
  const walls: Wall[] = [];
  const reach = probe * 2;
  for (const [pi, piece] of scene.pieces.entries()) {
    for (const [gi, polygon] of piece.shape.entries()) {
      for (const [ri, ring] of polygon.entries()) {
        for (let i = 0; i < ring.length - 1; i++) {
          const [ax, ay] = ring[i];
          const [bx, by] = ring[i + 1];
          if (
            region &&
            (Math.max(ax, bx) < region.x0 - reach || Math.min(ax, bx) > region.x1 + reach || Math.max(ay, by) < region.y0 - reach || Math.min(ay, by) > region.y1 + reach)
          ) {
            continue;
          }
          const seg = `${pi}:${gi}:${ri}:${i}`;
          done?.add(seg);
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
          // (A standing shape's picture stands just in front of its walls: they all stay.)
          const lower = scene.pieceAt(mx + nx * probe, my + ny * probe);
          // With slopes about, every edge is cut in short steps: a slope may meet it anywhere along
          // it (not only at its middle), and the heights on either side change there.
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
            // Not a hair of wall (a soft edge meets the ground beside it at about its height).
            if (t0 - b0 < 0.02 && t1 - b1 < 0.02) {
              continue;
            }
            walls.push({
              style: piece.walls ?? lower?.walls,
              skin: piece.skin ?? (piece.walls ? undefined : lower?.skin),
              ax: px, ay: py, bx: qx, by: qy, t0, t1, b0, b1, edge,
              mx: (px + qx) / 2 - nx * probe * 3, my: (py + qy) / 2 - ny * probe * 3, nx, ny,
              lit: Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1]) / l),
              seg,
            });
          }
        }
      }
    }
  }
  return walls;
}
