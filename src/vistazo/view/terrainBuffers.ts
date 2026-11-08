import type { VistazoScene } from "../scene";
import type { MapColors } from "./mapColors";
import { heightGrid, type HeightGrid } from "./heightGrid";
import { pieceBuffers, type FineSurfaces, type PieceBuffers, type UvBox } from "./surfaces";
import type { Wall } from "./types";
import { wallBuffers, type WallBuffers } from "./wallBuffers";
import { wallShadowBuffers } from "./wallShadows";
import { computeWalls } from "./walls";
import { fillGroups, undersideBuffers, type FillGroup } from "./undersides";
import { waterReachData, waterShape, type WaterReachData } from "./water";
import type { MultiPolygon } from "polygon-clipping";
import type { Piece } from "../scene";

// The terrain's meshes as numbers, all of them for a scene (see VistazoView.build, which makes the
// meshes): worked out on the page, or away from it (see terrainWorker) so that it isn't held up.

/** What the terrain is worked out with besides the scene: view units per scene px and per height unit, the options' shading and level lines, where the map's picture lies (its texture's box, none without one; the uvs' box, the scene's then), its colours. */
export type TerrainContext = {
  u: number;
  k: number;
  shade: number;
  levels: boolean;
  relief: number;
  texture: UvBox | null;
  uvBox: UvBox;
  colors: MapColors | null;
};

/** A scene's terrain worked out: its heights grid, walls, the walls' faces and the shadows at their feet, and each piece's top (as the scene's pieces, in order). */
export type TerrainBuffers = {
  grid: HeightGrid;
  walls: Wall[];
  wallSets: WallBuffers[];
  /** None: no walls, or no shading; not worked out (undefined): drawn lightly, a drag (see VistazoView.setLite). */
  shadows?: { positions: Float32Array; colors: Float32Array } | null;
  pieces: PieceBuffers[];
  /** Each group of slabs filled under as one (see fillGroups): its members, outline and underside (see undersideBuffers). */
  undersides: (FillGroup & { cols: number; rows: number; heights: Float32Array })[];
  /** Each water's surface: where it reaches, its outline, its level (as the scene's pieces with water, standing ones left out). */
  water: { reach: WaterReachData; shape: MultiPolygon; level: number }[];
};

/**
 * The terrain of a scene, the lowest level it reaches being `base`; `walls`: those already worked out
 * for it, kept; `lite`: without the walls' shadows (worked out on the page later, if they're wanted); `coarse`: its surfaces, walls and heights grid cut coarser (a drag's,
 * worked out several times a second: whole again once it's let go).
 */
export function computeTerrain(scene: VistazoScene, base: number, c: TerrainContext, fine: FineSurfaces, walls?: Wall[], lite = false, took?: Record<string, number>, coarse = false): TerrainBuffers {
  // Each stage's time, if asked (the worker's, for the page's stopwatch).
  const timed = <T>(stage: string, f: () => T): T => {
    if (!took) {
      return f();
    }
    const t0 = performance.now();
    const out = f();
    took[stage] = performance.now() - t0;
    return out;
  };
  const grid = timed("grid", () => heightGrid(scene.bounds, scene.dpi, scene.heightAt, coarse));
  const list = walls ?? timed("walls", () => computeWalls(scene, base, undefined, undefined, coarse));
  fine.begin();
  return {
    grid,
    walls: list,
    wallSets: timed("wallSets", () => wallBuffers(list, { u: c.u, k: c.k, shade: c.shade, levels: c.levels, box: c.texture, colors: c.colors })),
    ...(lite ? {} : { shadows: timed("shadows", () => wallShadowBuffers(list, scene.heightAt, { u: c.u, k: c.k, relief: c.relief })) }),
    pieces: timed("pieces", () => scene.pieces.map((piece) => pieceBuffers(piece, { u: c.u, k: c.k, uvBox: c.uvBox, texture: c.texture, colors: c.colors, fine, coarse }))),
    undersides: timed("undersides", () => fillGroups(scene).map((group) => ({ ...group, ...undersideBuffers(scene, group, c.k) }))),
    water: timed("water", () =>
      scene.pieces
        .filter((piece): piece is Piece & { water: number } => !!piece.water && !piece.stand)
        .map((piece) => ({ reach: waterReachData(scene, piece), shape: waterShape(scene, piece), level: piece.height + piece.water }))
    ),
  };
}

/** The arrays a terrain's numbers hold (to hand them to the page without copying them). */
export function terrainTransfers(t: TerrainBuffers): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>([t.grid.cells.buffer as ArrayBuffer]);
  for (const set of t.wallSets) {
    [set.positions, set.colors, set.uvs, set.levels].forEach((a) => buffers.add(a.buffer as ArrayBuffer));
  }
  if (t.shadows) {
    buffers.add(t.shadows.positions.buffer as ArrayBuffer);
    buffers.add(t.shadows.colors.buffer as ArrayBuffer);
  }
  for (const piece of t.pieces) {
    buffers.add(piece.surface.position.buffer as ArrayBuffer);
    if (piece.kind === "top") {
      buffers.add(piece.uv.buffer as ArrayBuffer);
      if (piece.lean && piece.surface.index) {
        // Its own triangles (not the cache's): handed over too.
        buffers.add(piece.surface.index.buffer as ArrayBuffer);
      }
    } else {
      buffers.add(piece.roofUv.buffer as ArrayBuffer);
      if (piece.card) {
        [piece.card.position, piece.card.uv, piece.card.map].forEach((a) => buffers.add(a.buffer as ArrayBuffer));
      }
    }
    // A fine surface's triangles are shared with its cache (kept there): copied, not handed over.
  }
  for (const under of t.undersides) {
    buffers.add(under.heights.buffer as ArrayBuffer);
  }
  for (const water of t.water) {
    buffers.add(water.reach.data.buffer as ArrayBuffer);
  }
  return [...buffers];
}
