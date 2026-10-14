import type { Image } from "@owlbear-rodeo/sdk";
import { groundOffset } from "../engine/hex";
import { BandSet } from "../engine/types";
import {
  DEFAULT_TOLERANCE,
  bodyCenterHeight,
  bodyDistance,
  excessRadius,
  matchedDistance,
} from "../engine/distance";
import { findBandIndex } from "../engine/bands";
import { toFloor } from "../engine/axonometry";
import { getTokenRadius } from "../render/iconAnchor";

export type DistanceRow = {
  token: Image;
  /** Index into measuredBands(bandSet), or null if out of range. */
  bandIndex: number | null;
  /** Grid units, the same number a Lectura shows. */
  distance: number;
  /** The gap between the bodies on the ground alone (the metric's own flat distance). */
  horizontal: number;
  /** The gap between the bodies in height alone, signed: positive = the target is higher. 0 when they overlap. */
  heightDifference: number;
};

/**
 * Every other token's reading from `origin`, closest first — the same math
 * a Medición started on `origin` would use for its Lecturas (heights from
 * the persistent markers, both tokens' excess bulk, Tolerancia for which
 * Banda it falls in).
 */
export function computeDistanceRows(
  origin: Image,
  others: Image[],
  heights: Map<string, number>,
  bandSet: BandSet,
  dpi: number,
  axonometry: number
): DistanceRow[] {
  const originRadius = getTokenRadius(origin, dpi, axonometry);
  const originCenter = bodyCenterHeight(heights.get(origin.id) ?? 0, originRadius);
  const originExcess = excessRadius(originRadius);
  const tolerance = (bandSet.tolerance ?? DEFAULT_TOLERANCE) / 100;
  const rows = others.map((token): DistanceRow => {
    const { x: dx, y: dy } = toFloor(
      (token.position.x - origin.position.x) / dpi,
      (token.position.y - origin.position.y) / dpi,
      axonometry
    );
    const tokenRadius = getTokenRadius(token, dpi, axonometry);
    const dz = bodyCenterHeight(heights.get(token.id) ?? 0, tokenRadius) - originCenter;
    const excessSum = originExcess + excessRadius(tokenRadius);
    const ground = groundOffset(dx, dy, bandSet.shape);
    const { distance, horizontal, vertical } = bodyDistance(ground.x, ground.y, dz, excessSum, bandSet.metric);
    return {
      token,
      bandIndex: findBandIndex(matchedDistance(distance, tolerance), bandSet),
      distance,
      horizontal,
      heightDifference: Math.sign(dz) * vertical,
    };
  });
  return rows.sort((a, b) => a.distance - b.distance);
}

/** The name Owlbear shows on a token, falling back to its item name. */
export function tokenName(token: Image): string {
  return token.text?.plainText || token.name || "?";
}
