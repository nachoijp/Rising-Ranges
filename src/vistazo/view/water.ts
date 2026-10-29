import * as THREE from "three";
import polygonClipping from "../../terrain/clip";
import type { MultiPolygon } from "polygon-clipping";
import { growRings } from "../../terrain/terrain";
import { inShape, type Piece, type VistazoScene } from "../scene";
import { WATER_FRAGMENT, WATER_VERTEX } from "./shaders";
import type { Texture } from "./types";

/**
 * Where a zone's water reaches, as a texture over a grid of its own: not
 * only its zone, but what's below its level round it (see buildWater).
 */
export type WaterReach = { mask: THREE.DataTexture; x0: number; y0: number; step: number; w: number; h: number };

/** Where a water reaches as numbers (see waterReachData): a byte a grid point (255: reached), over its grid. */
export type WaterReachData = { data: Uint8Array; x0: number; y0: number; step: number; w: number; h: number };

/** Where a water reaches (see waterReachData), as its mask texture. */
export function waterReach(scene: VistazoScene, piece: Piece & { water: number }): WaterReach {
  return reachMask(waterReachData(scene, piece));
}

/** A water's reach as the mask its surface's material reads. */
export function reachMask(reach: WaterReachData): WaterReach {
  const mask = new THREE.DataTexture(reach.data, reach.w, reach.h, THREE.RedFormat, THREE.UnsignedByteType);
  // A byte a cell: rows not padded to four bytes (any width).
  mask.unpackAlignment = 1;
  mask.needsUpdate = true;
  return { mask, x0: reach.x0, y0: reach.y0, step: reach.step, w: reach.w, h: reach.h };
}

/**
 * Water fills what's below its level, not only its zone: from its zone
 * outward over the terrain's heights, through ground between its floor and
 * its level, up to two cells away. It stops at the shore of a slope beside
 * it, and can't cross a rim higher than its level (a raised pool's). On its
 * own fine grid (a twentieth of a cell, the terrain's exact heights), over
 * its zone's box and two cells round it: so its edges sit on its zone's,
 * not rounded to the coarser heights grid.
 */
export function waterReachData(scene: VistazoScene, piece: Piece & { water: number }): WaterReachData {
  const level = piece.height + piece.water;
  const xs = piece.shape.flatMap((polygon) => polygon[0].map((p) => p[0]));
  const ys = piece.shape.flatMap((polygon) => polygon[0].map((p) => p[1]));
  const margin = scene.dpi * 2;
  const step = scene.dpi / 20;
  const gx0 = Math.min(...xs) - margin;
  const gy0 = Math.min(...ys) - margin;
  const gw = Math.ceil((Math.max(...xs) + margin - gx0) / step) + 1;
  const gh = Math.ceil((Math.max(...ys) + margin - gy0) / step) + 1;
  const heightAt = (i: number, j: number) => scene.heightAt(gx0 + i * step, gy0 + j * step) ?? NaN;
  const reached = new Uint8Array(gw * gh);
  // Each point's ground read once (a point the water can't fill is asked again by each neighbour).
  const checked = new Uint8Array(gw * gh);
  const queue: number[] = [];
  // Its zone's points: only within its zone's box (the margin round it can't be in it).
  const span = Math.ceil(margin / step);
  for (let j = span; j < gh - span; j++) {
    for (let i = span; i < gw - span; i++) {
      if (inShape(gx0 + i * step, gy0 + j * step, piece.shape)) {
        reached[j * gw + i] = 255;
        checked[j * gw + i] = 1;
        queue.push(j * gw + i);
      }
    }
  }
  const fits = (h: number) => !Number.isNaN(h) && h >= piece.height - 0.01 && h < level;
  const reach = 40; // two cells, in twentieths
  const depth = new Uint8Array(gw * gh);
  for (let q = 0; q < queue.length; q++) {
    const at = queue[q];
    if (depth[at] >= reach) {
      continue;
    }
    const i = at % gw;
    const j = (at - i) / gw;
    for (const [ni, nj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
      if (ni < 0 || nj < 0 || ni >= gw || nj >= gh) {
        continue;
      }
      const next = nj * gw + ni;
      if (checked[next]) {
        continue;
      }
      checked[next] = 1;
      if (fits(heightAt(ni, nj))) {
        reached[next] = 255;
        depth[next] = depth[at] + 1;
        queue.push(next);
      }
    }
  }
  return { data: reached, x0: gx0, y0: gy0, step, w: gw, h: gh };
}

/** What a water's surface covers: its zone and two cells round it, on the map (the mask cuts it to its reach). */
export function waterShape(scene: VistazoScene, piece: Piece): MultiPolygon {
  try {
    const grown = growRings(piece.shape.map((polygon) => polygon[0] as [number, number][]), scene.dpi * 2).map((ring) => [ring]);
    return polygonClipping.intersection(polygonClipping.union(piece.shape, ...grown), scene.world);
  } catch {
    // Its zone alone, then.
    return piece.shape;
  }
}

/** A water's surface's look: the map seen through it (`u`: view units per scene px), where it reaches. */
export function waterMaterial(map: THREE.Texture, texture: Texture, u: number, dpi: number, reach: WaterReach): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: WATER_VERTEX,
    fragmentShader: WATER_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uMap: { value: map },
      // Its place on the map (a lone map image's picture is placed by it: see placed in render.ts).
      uMapMatrix: { value: map.matrix },
      uU: { value: u },
      uCell: { value: dpi },
      uTex: { value: new THREE.Vector4(texture.x0, texture.y0, texture.w, texture.h) },
      uReach: { value: reach.mask },
      uGrid: { value: new THREE.Vector4(reach.x0, reach.y0, reach.step, 0) },
      uGridSize: { value: new THREE.Vector2(reach.w, reach.h) },
    },
  });
}
