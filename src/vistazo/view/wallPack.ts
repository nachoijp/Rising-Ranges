import type { TerrainSkin } from "../../terrain/terrain";
import type { Wall, WallStyle } from "./types";

// The walls as plain arrays, to hand them from the terrain's worker to the page without copying
// thousands of objects (see terrainWorker): unpacked there only when they're asked for (dragging a
// shape whole, a brush: see VistazoView.walls), not on every build.

/** How many numbers a wall takes: its ends, tops and bottoms, edge, middle, normal, light, shape, way along. */
const NUMBERS = 16;

export type PackedWalls = {
  numbers: Float64Array;
  /** Its piece's edge (piece, polygon, ring, side: see Wall.seg). */
  segs: Int32Array;
  /** Its style and skin, as an index into these (-1: none). */
  looks: Int16Array;
  styles: WallStyle[];
  skins: TerrainSkin[];
};

export function packWalls(walls: Wall[]): PackedWalls {
  const numbers = new Float64Array(walls.length * NUMBERS);
  const segs = new Int32Array(walls.length * 4);
  const looks = new Int16Array(walls.length * 2);
  const styles: WallStyle[] = [];
  const skins: TerrainSkin[] = [];
  walls.forEach((w, i) => {
    numbers.set([w.ax, w.ay, w.bx, w.by, w.t0, w.t1, w.b0, w.b1, w.edge ? 1 : 0, w.mx, w.my, w.nx, w.ny, w.lit, w.si ?? NaN, w.along ?? NaN], i * NUMBERS);
    segs.set(w.seg.split(":").map(Number), i * 4);
    const style = w.style === undefined ? -1 : styles.indexOf(w.style) >= 0 ? styles.indexOf(w.style) : styles.push(w.style) - 1;
    const skin = w.skin === undefined ? -1 : skins.indexOf(w.skin) >= 0 ? skins.indexOf(w.skin) : skins.push(w.skin) - 1;
    looks.set([style, skin], i * 2);
  });
  return { numbers, segs, looks, styles, skins };
}

export function unpackWalls(p: PackedWalls): Wall[] {
  const walls: Wall[] = [];
  for (let i = 0; i < p.looks.length / 2; i++) {
    const n = p.numbers.subarray(i * NUMBERS, (i + 1) * NUMBERS);
    const [style, skin] = [p.looks[i * 2], p.looks[i * 2 + 1]];
    const wall: Wall = {
      ax: n[0], ay: n[1], bx: n[2], by: n[3], t0: n[4], t1: n[5], b0: n[6], b1: n[7], edge: n[8] === 1,
      mx: n[9], my: n[10], nx: n[11], ny: n[12], lit: n[13],
      seg: Array.from(p.segs.subarray(i * 4, i * 4 + 4)).join(":"),
      style: style < 0 ? undefined : p.styles[style],
      skin: skin < 0 ? undefined : p.skins[skin],
    };
    if (!Number.isNaN(n[14])) {
      wall.si = n[14];
    }
    if (!Number.isNaN(n[15])) {
      wall.along = n[15];
    }
    walls.push(wall);
  }
  return walls;
}
