import * as THREE from "three";
import type { MultiPolygon } from "polygon-clipping";
import { bisect } from "./bisect";
import { colorAt, type MapColors } from "./mapColors";
import { STONE, VIEW_CELL, type WallStyle } from "./types";
import { WALL_STYLE } from "./wallBuffers";
import { pieceHeight, type Piece } from "../scene";

// The terrain's pieces' tops as numbers (see VistazoView.buildPiece, which makes their meshes): plain
// arrays, so they can be worked out away from the page too (see terrainWorker).

/** A surface's corners (view units) and triangles. */
export type Surface = { position: Float32Array; index: Uint16Array | Uint32Array | null };

/** A box of the scene (scene px) the map's picture lies over, its texture coordinates worked out from. */
export type UvBox = { x0: number; y0: number; w: number; h: number };

/** An outline as a flat surface, in view units (`u` per scene px): its triangles as three.js cuts them. */
export function flatSurface(shape: MultiPolygon, u: number): Surface {
  const shapes = shape.map((polygon) => {
    const outer = new THREE.Shape(polygon[0].map(([x, y]) => new THREE.Vector2(x * u, y * u)));
    outer.holes = polygon.slice(1).map((ring) => new THREE.Path(ring.map(([x, y]) => new THREE.Vector2(x * u, y * u))));
    return outer;
  });
  const geometry = new THREE.ShapeGeometry(shapes);
  const surface: Surface = { position: (geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array, index: (geometry.index?.array as Uint16Array | Uint32Array | undefined) ?? null };
  geometry.dispose();
  return surface;
}

/**
 * Surfaces that aren't flat, their outlines' triangles cut small, to half a cell (the painted ground's
 * own step), however big they are: cut once for an outline (the same one again, only its heights
 * changed, a brush let go, takes the same triangles), and let go when no build has used it for a while.
 */
export class FineSurfaces {
  private kept = new Map<string, { position: Float32Array; index: Uint32Array; used: number }>();
  private builds = 0;

  /** A build begins: the outlines not used by the last two let go. */
  begin() {
    this.builds++;
    for (const [key, kept] of this.kept) {
      if (kept.used < this.builds - 2) {
        this.kept.delete(key);
      }
    }
  }

  /**
   * The cut surface of an outline (its corners at height 0, to be set; a copy, the triangles shared);
   * `coarse`: to a cell, not half (a drag's); `peaks` (scene px): points it must have a corner at, the
   * triangle each is in split there.
   */
  get(shape: MultiPolygon, u: number, coarse = false, peaks?: [number, number][]): Surface {
    const key = `${u}|${coarse}|${JSON.stringify(shape)}|${peaks ? JSON.stringify(peaks) : ""}`;
    let kept = this.kept.get(key);
    if (!kept) {
      const target = coarse ? VIEW_CELL : VIEW_CELL / 2;
      const flat = flatSurface(shape, u);
      let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < flat.position.length; i += 3) {
        [minX, minY, maxX, maxY] = [Math.min(minX, flat.position[i]), Math.min(minY, flat.position[i + 1]), Math.max(maxX, flat.position[i]), Math.max(maxY, flat.position[i + 1])];
      }
      const span = Math.hypot(maxX - minX, maxY - minY);
      // Each pass cuts every triangle in two across its longest side (two passes halve them all): as many
      // as it takes to get them down to the target.
      const passes = Math.max(1, Math.min(28, 2 * Math.ceil(Math.log2(Math.max(1, span / target))) + 2));
      const corners0 = flat.index ? Array.from(flat.index, (i) => i) : null;
      const plain = new Float32Array((corners0 ? corners0.length : flat.position.length / 3) * 3);
      for (let i = 0; i < plain.length / 3; i++) {
        const at = (corners0 ? corners0[i] : i) * 3;
        plain[i * 3] = flat.position[at];
        plain[i * 3 + 1] = flat.position[at + 1];
        plain[i * 3 + 2] = flat.position[at + 2];
      }
      const from = bisect(plain, target, passes);
      // Each corner once (the cut repeats it for every triangle round it, about six): its height is
      // then worked out once, not for each of them.
      const seen = new Map<number, number>();
      const corners: number[] = [];
      const index = new Uint32Array(from.length / 3);
      for (let i = 0; i < index.length; i++) {
        const x = from[i * 3];
        const y = from[i * 3 + 1];
        // To a thousandth of a view unit, as one number (both well under 2^26 thousandths).
        const at = Math.round(x * 1e3) * 2 ** 27 + Math.round(y * 1e3);
        let n = seen.get(at);
        if (n === undefined) {
          n = corners.length / 3;
          seen.set(at, n);
          corners.push(x, y, 0);
        }
        index[i] = n;
      }
      let tris = index;
      for (const [px, py] of peaks ?? []) {
        tris = splitAt(corners, tris, px * u, py * u);
      }
      kept = { position: Float32Array.from(corners), index: tris, used: 0 };
      this.kept.set(key, kept);
    }
    kept.used = this.builds;
    return { position: kept.position.slice(), index: kept.index };
  }
}

/** Triangles (indexes into `corners`, x y z each) with the one a point (view units) is in split into three there: a corner of its own (appended). As they were if none has it. */
function splitAt(corners: number[], tris: Uint32Array, x: number, y: number): Uint32Array {
  const at = (i: number): [number, number] => [corners[i * 3], corners[i * 3 + 1]];
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    const [[ax, ay], [bx, by], [cx, cy]] = [at(a), at(b), at(c)];
    const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(d) < 1e-12) {
      continue;
    }
    const w1 = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / d;
    const w2 = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / d;
    const w3 = 1 - w1 - w2;
    if (w1 < -1e-9 || w2 < -1e-9 || w3 < -1e-9) {
      continue;
    }
    // Right on a corner already: nothing to add.
    if (Math.max(w1, w2, w3) > 1 - 1e-6) {
      return tris;
    }
    const p = corners.length / 3;
    corners.push(x, y, 0);
    const out = new Uint32Array(tris.length + 6);
    out.set(tris.subarray(0, t), 0);
    out.set([a, b, p, b, c, p, c, a, p], t);
    out.set(tris.subarray(t + 3), t + 9);
    return out;
  }
  return tris;
}

/** Texture coordinates for view-unit points `xy` (x, y, z triples), from where the map's picture lies (`box`, scene px). */
export function uvsOver(xy: ArrayLike<number>, count: number, u: number, box: UvBox): Float32Array {
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    uv[i * 2] = (xy[i * 3] / u - box.x0) / box.w;
    uv[i * 2 + 1] = 1 - (xy[i * 3 + 1] / u - box.y0) / box.h;
  }
  return uv;
}

/**
 * A piece's top, as numbers: lying on the ground (`top`: its corners, at its height there where it
 * isn't flat, `z` its own height otherwise; the map's picture over it); or standing (`stand`: a block,
 * its top a pattern tinted with the map's colour there, its card the relief's picture of it in front).
 */
export type PieceBuffers =
  | { kind: "top"; surface: Surface; uv: Float32Array; z: number; fine: boolean }
  | { kind: "stand"; surface: Surface; roofUv: Float32Array; roofColor: [number, number, number]; roof: WallStyle; z: number; card: { position: Float32Array; uv: Float32Array; map: Float32Array } | null };

/** What a piece's top is worked out with (see pieceBuffers): view units per scene px and per height unit, the map's picture's box (uvs: the scene's without one; `texture`: none without one), its colours, the fine surfaces' cache; `coarse`: cut to a cell (a drag's). */
export type PieceContext = { u: number; k: number; uvBox: UvBox; texture: UvBox | null; colors: MapColors | null; fine: FineSurfaces; coarse?: boolean };

export function pieceBuffers(piece: Piece, c: PieceContext): PieceBuffers {
  const { u, k } = c;
  const z = piece.height * k;
  const fine = !!piece.surface && !(piece.coarse && !piece.fine?.());
  const surface = fine ? c.fine.get(piece.shape, u, c.coarse, piece.peaks) : flatSurface(piece.shape, u);
  const position = surface.position;
  const count = position.length / 3;
  if (!piece.stand) {
    const uv = uvsOver(position, count, u, c.uvBox);
    if (piece.surface) {
      // A ramp: each corner at its own height (a plane: the triangles stay flat).
      for (let i = 0; i < count; i++) {
        position[i * 3 + 2] = pieceHeight(piece, position[i * 3] / u, position[i * 3 + 1] / u) * k;
      }
    }
    return { kind: "top", surface, uv, z: piece.surface ? 0 : z, fine };
  }
  // Standing: a block (its top plain stone, its sides walls) with the relief's picture of it in front (its card).
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const polygon of piece.shape) {
    for (const [x, y] of polygon[0]) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const rgb = c.colors ? colorAt(c.colors, (x0 + x1) / 2, (y0 + y1) / 2) : STONE;
  // Its top: the walls' pattern (stone, earth or wood; stone when they take theirs from the map),
  // tinted with the map's colour there, laid out flat a tile every two cells.
  const style = piece.walls ?? WALL_STYLE;
  const roof: WallStyle = style === "earth" || style === "wood" || style === "rubble" ? style : "stone";
  const tile = VIEW_CELL * 2;
  const roofUv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    roofUv[i * 2] = position[i * 3] / tile;
    roofUv[i * 2 + 1] = position[i * 3 + 1] / tile;
  }
  let card: { position: Float32Array; uv: Float32Array; map: Float32Array } | null = null;
  if (piece.card) {
    // A relief's own picture (see relief/vistazo.ts): its corners where it has them, its picture from the map.
    const positions = new Float32Array(piece.card.length * 3);
    const uvs = new Float32Array(piece.card.length * 2);
    const t = c.texture;
    piece.card.forEach(([x, y, h, mx, my], i) => {
      positions.set([x * u, y * u, h * k], i * 3);
      uvs.set(t ? [(mx * u / u - t.x0) / t.w, 1 - (my * u / u - t.y0) / t.h] : [0, 0], i * 2);
    });
    // Where on the map each corner's picture is (view units), for it to follow a drag (see moveShapes).
    card = { position: positions, uv: uvs, map: Float32Array.from(piece.card.flatMap(([, , , mx, my]) => [mx * u, my * u, 0])) };
  }
  return { kind: "stand", surface, roofUv, roofColor: rgb.map((v) => v * 0.85) as [number, number, number], roof, z, card };
}
