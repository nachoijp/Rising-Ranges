import { VIEW_CELL, type Wall } from "./types";

// The soft shadows at the walls' feet as numbers (see VistazoView.buildWallShadows, which makes their
// mesh): plain arrays, so they can be worked out away from the page too (see terrainWorker).

/**
 * A soft shadow on the ground at the foot of each wall inside the map, fading out from it: its corners
 * (view units) and colours (black, by `relief`: the options' shading). None without walls or shading.
 * `heightAt`: the terrain's height at a scene point (grid units), where a shadow's far edge lands.
 */
export function wallShadowBuffers(
  list: Wall[],
  heightAt: (x: number, y: number) => number | undefined,
  c: { u: number; k: number; relief: number }
): { positions: Float32Array; colors: Float32Array } | null {
  const { u, k } = c;
  if (c.relief <= 0) {
    return null;
  }
  const inside = list.filter((wall) => !wall.edge);
  if (inside.length === 0) {
    return null;
  }
  const positions = new Float32Array(inside.length * 18);
  const colors = new Float32Array(inside.length * 24);
  const reach = VIEW_CELL * 0.45;
  const dark = 0.45 * c.relief;
  // Each end goes out along the walls' normals there, averaged with the next wall's: the shadows of
  // a wall's pieces meet at their ends (out along each piece's own normal, a curve's left wedges between).
  const key = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
  const normals = new Map<string, [number, number]>();
  for (const wall of inside) {
    for (const [x, y] of [[wall.ax, wall.ay], [wall.bx, wall.by]]) {
      const sum = normals.get(key(x, y)) ?? [0, 0];
      normals.set(key(x, y), [sum[0] + wall.nx, sum[1] + wall.ny]);
    }
  }
  const out = (x: number, y: number, wall: Wall): [number, number] => {
    const [sx, sy] = normals.get(key(x, y)) ?? [wall.nx, wall.ny];
    const length = Math.hypot(sx, sy);
    // Walls facing apart (a thin wall's two sides): its own way.
    return length < 0.5 ? [wall.nx, wall.ny] : [sx / length, sy / length];
  };
  // In an inner bend a strip's far edge is shorter than its wall, and gone at some reach: tighter than
  // the shadow's (a small shape's notch), the strips there cross over one another and show as thin dark
  // spikes. They reach only almost that far there; at each end the least of the strips meeting there
  // (the next one's far corner the same: no light gap between them).
  const ends = new Map<string, number>();
  for (const wall of inside) {
    const [na, nb] = [out(wall.ax, wall.ay, wall), out(wall.bx, wall.by, wall)];
    const [ex, ey] = [(wall.bx - wall.ax) * u, (wall.by - wall.ay) * u];
    const closing = (nb[0] - na[0]) * ex + (nb[1] - na[1]) * ey;
    const r = closing < 0 ? Math.min(reach, (-(ex * ex + ey * ey) / closing) * 0.9) : reach;
    for (const at of [key(wall.ax, wall.ay), key(wall.bx, wall.by)]) {
      ends.set(at, Math.min(ends.get(at) ?? reach, r));
    }
  }
  inside.forEach((wall, i) => {
    const [ax, ay, bx, by] = [wall.ax * u, wall.ay * u, wall.bx * u, wall.by * u];
    const [nax, nay] = out(wall.ax, wall.ay, wall);
    const [nbx, nby] = out(wall.bx, wall.by, wall);
    const [ra, rb] = [ends.get(key(wall.ax, wall.ay)) ?? reach, ends.get(key(wall.bx, wall.by)) ?? reach];
    const [cx, cy, dx, dy] = [ax + nax * ra, ay + nay * ra, bx + nbx * rb, by + nby * rb];
    const za = wall.b0 * k + 0.4;
    const zb = wall.b1 * k + 0.4;
    // Its far edge down on the ground there where that falls away (a slope: level with the
    // wall's foot it would hang in the air), but never up: by a corner its far edge lands on the next
    // wall's top, and climbing to it, it would cut through that wall.
    const zc = Math.min(wall.b0, heightAt(cx / u, cy / u) ?? wall.b0) * k + 0.4;
    const zd = Math.min(wall.b1, heightAt(dx / u, dy / u) ?? wall.b1) * k + 0.4;
    positions.set([ax, ay, za, bx, by, zb, dx, dy, zd, ax, ay, za, dx, dy, zd, cx, cy, zc], i * 18);
    const alphas = [dark, dark, 0, dark, 0, 0];
    alphas.forEach((a, j) => colors.set([0, 0, 0, a], i * 24 + j * 4));
  });
  return { positions, colors };
}
