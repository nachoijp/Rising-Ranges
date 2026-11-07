import { VIEW_CELL, STONE, type Wall, type WallStyle } from "./types";
import { colorAt, softColorAt, type MapColors } from "./mapColors";
import { skinAcross, skinPoint, within } from "./helpers";

// The walls' faces as numbers (see VistazoView.buildWalls, which makes their meshes): plain arrays, so
// they can be worked out away from the page too (see terrainWorker).

/** The style a zone's walls take when it asks for none. */
export const WALL_STYLE: WallStyle = "blend";

/** What the walls' faces are worked out with: view units per scene px (`u`) and per height unit (`k`); the options' shade and level lines; the map texture's box (scene px; none without one); the map's colours. */
export type WallContext = {
  u: number;
  k: number;
  shade: number;
  levels: boolean;
  box: { x0: number; y0: number; w: number; h: number } | null;
  colors: MapColors | null;
  /** Where the map's read for a scene point (see VistazoScene.mapAt); none: where it is. */
  remap?: (x: number, y: number) => [number, number];
};

/** One mesh's walls (inside or at the map's edge, of one style): their faces' corners, colours and texture coordinates, and their level lines. */
export type WallBuffers = {
  edge: boolean;
  style: WallStyle | "skin";
  fromMap: boolean;
  positions: Float32Array;
  colors: Float32Array;
  uvs: Float32Array;
  levels: Float32Array;
};

/** The walls' faces, a set for each style, inside and at the map's edge (which can be hidden); a wall with a picture from the map's rectangle in its own ("skin"). */
export function wallBuffers(list: Wall[], c: WallContext): WallBuffers[] {
  const { u, k } = c;
  // The fold's strip: how far into the map it reaches, in view units.
  const band = VIEW_CELL * 0.75;
  const styleOf = (wall: Wall): WallStyle | "skin" => (wall.skin && c.box ? "skin" : (wall.style ?? WALL_STYLE));
  const read = (x: number, y: number): [number, number] => (c.remap ? c.remap(x, y) : [x, y]);
  const uvAt = (x: number, y: number): [number, number] => {
    const t = c.box!;
    const [sx, sy] = read(x / u, y / u);
    return [(sx - t.x0) / t.w, 1 - (sy - t.y0) / t.h];
  };
  const styles = new Set(list.map(styleOf));
  const out: WallBuffers[] = [];
  for (const [edge, style] of [false, true].flatMap((e) => [...styles].map((st) => [e, st] as const))) {
    const walls = list.filter((wall) => wall.edge === edge && styleOf(wall) === style);
    if (walls.length === 0) {
      continue;
    }
    const fromMap = (style === "stretch" || style === "fold" || style === "skin") && c.box !== null;
    const blend = style === "blend";
    const positions: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const levels: number[] = [];
    for (const wall of walls) {
      const s = 1 - c.shade * (1 - (0.45 + 0.55 * wall.lit));
      // Taken from the map, its colour is in the texture: the vertices only shade it.
      const rgb = fromMap ? [255, 255, 255] : c.colors ? colorAt(c.colors, ...read(wall.mx, wall.my)) : STONE;
      const top = rgb.map((v) => (v / 255) * s * 0.92);
      const bottom = top.map((v) => v * 0.62);
      const [ax, ay, bx, by] = [wall.ax * u, wall.ay * u, wall.bx * u, wall.by * u];
      const [zt0, zt1, zb0, zb1] = [wall.t0 * k, wall.t1 * k, wall.b0 * k, wall.b1 * k];
      const zt = zt0;
      const zb = zb0;
      const length = Math.hypot(bx - ax, by - ay);
      // A slanting side (beside a ramp): one quad with its own heights at each end.
      const slanted = Math.abs(zt0 - zt1) > 1e-3 || Math.abs(zb0 - zb1) > 1e-3;
      // Where its picture is: into the raised piece from the edge (the wall's normal points out,
      // to the lower side); a sunken zone's walls (a pit, a ravine: not above the ground) are drawn
      // on the map inside the hollow, on that lower side.
      const sunken = Math.max(wall.t0, wall.t1) <= 1e-6;
      const [ix, iy] = sunken ? [wall.nx, wall.ny] : [-wall.nx, -wall.ny];
      // One slice of the face, from depth t0 to t1 below the top, with its texture coordinates.
      const slice = (t0: number, t1: number, uvTop: number[], uvBottom: number[]) => {
        const z0 = zt - t0;
        const z1 = zt - t1;
        const c0 = top.map((v, i) => v + (bottom[i] - v) * (t0 / (zt - zb || 1)));
        const c1 = top.map((v, i) => v + (bottom[i] - v) * (t1 / (zt - zb || 1)));
        positions.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z0, bx, by, z1, ax, ay, z1);
        colors.push(...c0, ...c0, ...c1, ...c0, ...c1, ...c1);
        // uvTop / uvBottom: [aU, aV, bU, bV] at the slice's top and bottom.
        uvs.push(uvTop[0], uvTop[1], uvTop[2], uvTop[3], uvBottom[2], uvBottom[3], uvTop[0], uvTop[1], uvBottom[2], uvBottom[3], uvBottom[0], uvBottom[1]);
      };
      const mapUv = (x: number, y: number) => uvAt(x, y);
      const height = zt - zb;
      if (blend) {
        // Blended from the map: its colours along it (every half cell), the higher side's (a little
        // into it) at the top, running into the lower side's at the foot; its grain in its material.
        const reach = 0.3 * (VIEW_CELL / u);
        const tone = (x: number, y: number, shade: number) => (c.colors ? softColorAt(c.colors, ...read(x, y)) : rgb).map((v) => (v / 255) * s * shade);
        const point = (f: number) => {
          const [x, y] = [wall.ax + (wall.bx - wall.ax) * f, wall.ay + (wall.by - wall.ay) * f];
          return {
            x: x * u,
            y: y * u,
            zt: zt0 + (zt1 - zt0) * f,
            zb: zb0 + (zb1 - zb0) * f,
            top: tone(x - wall.nx * reach, y - wall.ny * reach, 0.92),
            bottom: tone(x + wall.nx * reach, y + wall.ny * reach, 0.62),
          };
        };
        const n = Math.max(1, Math.ceil(length / (VIEW_CELL * 0.5)));
        let a = point(0);
        for (let j = 1; j <= n; j++) {
          const b = point(j / n);
          positions.push(a.x, a.y, a.zt, b.x, b.y, b.zt, b.x, b.y, b.zb, a.x, a.y, a.zt, b.x, b.y, b.zb, a.x, a.y, a.zb);
          colors.push(...a.top, ...b.top, ...b.bottom, ...a.top, ...b.bottom, ...a.bottom);
          uvs.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
          a = b;
        }
      } else if (style === "skin" && wall.skin) {
        // The rectangle's picture: across it by where round the zone each end is, up it by height.
        const across = (x: number, y: number) => skinAcross(wall.skin!, x / u, y / u);
        const [sa, sb] = [across(ax, ay), across(bx, by)];
        const lowest = Math.min(zb0, zb1);
        const span = Math.max(zt0, zt1) - lowest || 1;
        const at = (s: number, z: number) => {
          const [x, y] = skinPoint(wall.skin!, s, (z - lowest) / span);
          return uvAt(x * u, y * u);
        };
        positions.push(ax, ay, zt0, bx, by, zt1, bx, by, zb1, ax, ay, zt0, bx, by, zb1, ax, ay, zb0);
        colors.push(...top, ...top, ...bottom, ...top, ...bottom, ...bottom);
        const [a0, b0, b1, a1] = [at(sa, zt0), at(sb, zt1), at(sb, zb1), at(sa, zb0)];
        uvs.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
      } else if (slanted) {
        positions.push(ax, ay, zt0, bx, by, zt1, bx, by, zb1, ax, ay, zt0, bx, by, zb1, ax, ay, zb0);
        colors.push(...top, ...top, ...bottom, ...top, ...bottom, ...bottom);
        let uvTop: number[];
        let uvBottom: number[];
        if (style === "fold" && fromMap) {
          const deep = Math.min(band, Math.max(zt0 - zb0, zt1 - zb1));
          uvTop = [...mapUv(ax + ix * 0.5, ay + iy * 0.5), ...mapUv(bx + ix * 0.5, by + iy * 0.5)];
          uvBottom = [...mapUv(ax + ix * deep, ay + iy * deep), ...mapUv(bx + ix * deep, by + iy * deep)];
        } else if (style === "stretch" && fromMap) {
          uvTop = [...mapUv(ax + ix * 1.5, ay + iy * 1.5), ...mapUv(bx + ix * 1.5, by + iy * 1.5)];
          uvBottom = uvTop;
        } else {
          const tile = VIEW_CELL * 2;
          // Along the wall's own direction (not x + y): steps of one straight edge then run on without a jump.
          const s0 = (wall.along !== undefined ? wall.along * u : (ax * (bx - ax) + ay * (by - ay)) / (length || 1)) / tile;
          uvTop = [s0, zt0 / tile, s0 + length / tile, zt1 / tile];
          uvBottom = [s0, zb0 / tile, s0 + length / tile, zb1 / tile];
        }
        uvs.push(uvTop[0], uvTop[1], uvTop[2], uvTop[3], uvBottom[2], uvBottom[3], uvTop[0], uvTop[1], uvBottom[2], uvBottom[3], uvBottom[0], uvBottom[1]);
      } else if (style === "fold" && fromMap) {
        // Strips of the map just inside the edge, folded down, every other one mirrored.
        const inside = (d: number) => [...mapUv(ax + ix * d, ay + iy * d), ...mapUv(bx + ix * d, by + iy * d)];
        for (let t = 0, j = 0; t < height; t += band, j++) {
          const t1 = Math.min(height, t + band);
          const d0 = j % 2 === 0 ? 0 : band;
          const d1 = j % 2 === 0 ? t1 - t : band - (t1 - t);
          slice(t, t1, inside(d0 + 0.5), inside(d1 + 0.5));
        }
      } else if (style === "stretch" && fromMap) {
        // The map's pixels at the top edge (a hair inside), stretched down.
        const edgeUv = [...mapUv(ax + ix * 1.5, ay + iy * 1.5), ...mapUv(bx + ix * 1.5, by + iy * 1.5)];
        slice(0, height, edgeUv, edgeUv);
      } else {
        // A pattern 2 cells a tile, along the wall and down from the ground level (so courses line up).
        const tile = VIEW_CELL * 2;
        // Along the wall's own direction, as above.
        const s0 = (wall.along !== undefined ? wall.along * u : (ax * (bx - ax) + ay * (by - ay)) / (length || 1)) / tile;
        const v = (z: number) => z / tile;
        slice(0, height, [s0, v(zt), s0 + length / tile, v(zt)], [s0, v(zb), s0 + length / tile, v(zb)]);
      }
      // Level lines at every whole cell of height, counted from the ground.
      if (c.levels) {
        const lowest = Math.min(wall.b0, wall.b1);
        const highest = Math.max(wall.t0, wall.t1);
        for (let n = Math.ceil(lowest + 1e-6); n < highest - 1e-6; n++) {
          // Where along the wall that height is on its face (bottom ≤ n ≤ top), 0 to 1.
          const span = within(wall.b0, wall.b1, wall.t0, wall.t1, n);
          if (span) {
            const [s0, s1] = span;
            levels.push(ax + (bx - ax) * s0, ay + (by - ay) * s0, n * k, ax + (bx - ax) * s1, ay + (by - ay) * s1, n * k);
          }
        }
      }
    }
    out.push({ edge, style, fromMap, positions: new Float32Array(positions), colors: new Float32Array(colors), uvs: new Float32Array(uvs), levels: new Float32Array(levels) });
  }
  return out;
}
