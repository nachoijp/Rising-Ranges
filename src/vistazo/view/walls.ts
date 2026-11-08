import { pieceHeight, type VistazoScene } from "../scene";
import { LIGHT, type Wall } from "./types";

/** A box of the scene (px). */
export type Region = { x0: number; y0: number; x1: number; y1: number };

/**
 * The walls round every piece: each edge where the ground beside it is
 * lower (or there's none, the map's edge), from this piece's top down to
 * that, `base` (grid units) where there's nothing beside it.
 *
 * With `region`, only the edges that reach into it (the heights changed
 * there: a brush); `done` gets each such edge (see Wall.seg), walls or not. `coarse`: a sloped edge
 * cut in half cells, not quarters (a drag's).
 */
export function computeWalls(scene: VistazoScene, base: number, region?: Region, done?: Set<string>, coarse = false): Wall[] {
  const probe = scene.dpi * 0.03;
  const l = Math.hypot(...LIGHT);
  // A surface that isn't flat about: its heights change along an edge.
  const sloped = scene.pieces.some((piece) => piece.surface);
  const walls: Wall[] = [];
  const reach = probe * 2;
  for (const [pi, piece] of scene.pieces.entries()) {
    for (const [gi, polygon] of piece.shape.entries()) {
      for (const [ri, ring] of polygon.entries()) {
        // Which way is out of the piece, by the ring's turn: an outline's outside is its right going
        // one way round, a hole's the other (no asking the piece's shape at each edge).
        let turn = 0;
        for (let i = 0; i < ring.length - 1; i++) {
          turn += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        }
        const flip = turn > 0 !== (ri === 0);
        // How far round the outline each side starts (a pattern runs on round it).
        let run = 0;
        for (let i = 0; i < ring.length - 1; i++) {
          const [ax, ay] = ring[i];
          const [bx, by] = ring[i + 1];
          const start = run;
          run += Math.hypot(bx - ax, by - ay);
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
          const nx = (flip ? -dy : dy) / len;
          const ny = (flip ? dx : -dx) / len;
          const mx = (ax + bx) / 2;
          const my = (ay + by) / 2;
          // (A standing shape's picture stands just in front of its walls: they all stay.)
          const lower = scene.pieceAt(mx + nx * probe, my + ny * probe);
          // With slopes about, every edge is cut in short steps: a slope may meet it anywhere along
          // it (not only at its middle), and the heights on either side change there.
          const steps = sloped ? Math.max(1, Math.ceil(len / (scene.dpi * (coarse ? 0.5 : 0.25)) - 1e-6)) : 1;
          for (let j = 0; j < steps; j++) {
            const [px, py] = [ax + (dx * j) / steps, ay + (dy * j) / steps];
            const [qx, qy] = [ax + (dx * (j + 1)) / steps, ay + (dy * (j + 1)) / steps];
            const outP = scene.heightAt(px + nx * probe, py + ny * probe);
            const outQ = scene.heightAt(qx + nx * probe, qy + ny * probe);
            const edge = outP === undefined && outQ === undefined;
            const t0 = pieceHeight(piece, px, py);
            const t1 = pieceHeight(piece, qx, qy);
            // The higher side draws the wall: where this one's lower at an end, it narrows to nothing there.
            // Beside a ramp ending partway along the step (the ground dips at its middle, below a straight
            // line between its ends), down to the lowest of it: that line would leave a wedge open, and
            // what reaches below the ground is hidden under it. Otherwise, the ground as it is at each end:
            // a flat foot under a top that rises along the step (a soft edge's, beside ground that rises
            // with it) shows as a tooth on every step.
            let low0 = outP ?? base;
            let low1 = outQ ?? base;
            if (steps > 1) {
              const outM = scene.heightAt((px + qx) / 2 + nx * probe, (py + qy) / 2 + ny * probe) ?? base;
              if (outM < (low0 + low1) / 2 - 0.02) {
                low0 = low1 = Math.min(low0, low1, outM);
              }
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
              si: piece.si,
              along: start + (len * j) / steps,
            });
          }
        }
      }
    }
  }
  return walls;
}
