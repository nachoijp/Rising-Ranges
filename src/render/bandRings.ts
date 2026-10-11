import {
  buildEffect,
  buildShape,
  type GridScale,
  type Item,
  type Matrix,
  type Uniform,
  type Vector2,
} from "@owlbear-rodeo/sdk";
import ringSksl from "./ring.frag";
import { getPluginId } from "../util/getPluginId";
import { getColorString } from "../util/color";
import { flattenGridScale } from "../util/flattenGridScale";
import { Theme } from "../theme/themes";
import { BandSet } from "../engine/types";
import { DEFAULT_TOLERANCE, excessRadius } from "../engine/distance";
import { floorExtent } from "../engine/axonometry";
import { buildFloorShape } from "./floorShape";
import { showsBandName, showsDistance, type RingLabel } from "../settings/display";
import { getBandLabel } from "./lecturaItems";

// The Medición's rings around the Origen, their labels, and the colored
// gradient behind them.

/** How far above its ring a Banda's label sits, in px. */
const LABEL_OFFSET = -16;

/**
 * A Banda's ring radius in px. It matches exactly the boundary a Lectura
 * is matched against: the Banda's radius, plus the Origen's own bulk past a
 * standard token (see excessRadius) and the Tolerancia margin — otherwise
 * the ring would promise a boundary the Lecturas don't agree with.
 */
export function ringRadius(radius: number, dpi: number, bandSet: BandSet, originRadius: number): number {
  const tolerance = (bandSet.tolerance ?? DEFAULT_TOLERANCE) / 100;
  return (radius + excessRadius(originRadius) + tolerance) * dpi;
}

function buildRing(
  center: Vector2,
  radius: number,
  name: string,
  color: string,
  shape: BandSet["shape"],
  axonometry: number
) {
  const { item, offset } = buildFloorShape(center, radius, shape, axonometry, {
    fillOpacity: 0,
    strokeWidth: 2,
    strokeOpacity: 0.9,
    strokeColor: color,
    strokeDash: [10, 10],
  });
  item.name = name;
  // Each ring and label keeps its offset from the Origen, so moving them
  // all is just "Origen minus offset" (see refreshBandPositions).
  item.metadata = { [getPluginId("offset")]: offset };
  return item;
}

/**
 * The one item of a Medición that Owlbear syncs to every client: an
 * invisible point at the Origen. Each client draws the rings, their labels
 * and the gradient itself, in its own color theme, and attaches them to
 * this so they follow it.
 */
export function buildOriginAnchor(center: Vector2): Item {
  return buildShape()
    .shapeType("CIRCLE")
    .width(2)
    .height(2)
    .fillOpacity(0)
    .strokeOpacity(0)
    .strokeWidth(0)
    .position(center)
    .disableHit(true)
    .layer("POPOVER")
    .build();
}

/** One ring per Banda, plus its label when the room's ring label shows anything. */
export function buildBandRingItems(
  center: Vector2,
  theme: Theme,
  bandSet: BandSet,
  dpi: number,
  gridScale: GridScale,
  ringLabel: RingLabel,
  ringLabelSize: number,
  originRadius: number,
  axonometry: number
): Item[] {
  const items: Item[] = [];
  bandSet.bands.forEach((band, i) => {
    const baseColor = theme.colors[i % theme.colors.length];
    const color = getColorString(baseColor);
    const radius = ringRadius(band.radius, dpi, bandSet, originRadius);
    items.push(buildRing(center, radius, band.name, color, bandSet.shape, axonometry));

    const parts: string[] = [];
    if (showsBandName(ringLabel)) {
      parts.push(band.name);
    }
    if (showsDistance(ringLabel)) {
      parts.push(flattenGridScale(gridScale, band.radius));
    }
    if (parts.length > 0) {
      const { halfHeight } = floorExtent(radius, bandSet.shape, axonometry);
      const labelOffset = { x: 0, y: halfHeight + LABEL_OFFSET };
      items.push(getBandLabel(center, labelOffset, parts.join(" "), baseColor, 1, ringLabelSize));
    }
  });
  return items;
}

/**
 * The darkening and the colored gradient behind the rings: two viewport
 * shaders. ring.frag takes up to 12 Bandas as six mat3 uniforms, each
 * holding two: [r1, r2, 0, R1, G1, B1, R2, G2, B2] (radius in px, colors
 * 0-1). On an axonometric grid it measures on the floor (see axonometry.ts),
 * so the gradient follows the rings' ellipses or rhombuses.
 */
export function buildGradientShaders(
  center: Vector2,
  theme: Theme,
  bandSet: BandSet,
  dpi: number,
  originRadius: number,
  axonometry: number
): Item[] {
  const uniforms: Uniform[] = [];
  for (let pair = 0; pair < 6; pair++) {
    const [first, second] = [pair * 2, pair * 2 + 1];
    const color1 = theme.colors[first % theme.colors.length];
    const color2 = theme.colors[second % theme.colors.length];
    const band1 = bandSet.bands[first];
    const band2 = bandSet.bands[second];
    const value: Matrix = [
      band1 ? ringRadius(band1.radius, dpi, bandSet, originRadius) : 0,
      band2 ? ringRadius(band2.radius, dpi, bandSet, originRadius) : 0,
      0,
      color1.r / 255,
      color1.g / 255,
      color1.b / 255,
      color2.r / 255,
      color2.g / 255,
      color2.b / 255,
    ];
    uniforms.push({ name: `data${pair + 1}`, value });
  }

  const darken = buildEffect()
    .sksl(
      `
half4 main(float2 coord) {
    return half4(0.85, 0.85, 0.85, 1.0);
}
      `
    )
    .effectType("VIEWPORT")
    .layer("POINTER")
    .zIndex(0)
    .blendMode("MULTIPLY")
    .build();

  const color = buildEffect()
    .sksl(ringSksl)
    .effectType("VIEWPORT")
    .position(center)
    .layer("POINTER")
    .zIndex(1)
    .blendMode("COLOR")
    .uniforms([
      ...uniforms,
      { name: "minFalloff", value: 0.1 },
      { name: "maxFalloff", value: 0.6 },
      { name: "type", value: bandSet.shape === "square" ? 1 : 0 },
      { name: "axonometry", value: axonometry },
    ])
    .build();

  return [darken, color];
}
