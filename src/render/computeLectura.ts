import type { GridScale, Image, Vector2 } from "@owlbear-rodeo/sdk";
import { getTokenRadius } from "./iconAnchor";
import type { LecturaState } from "./lecturaItems";
import { DEFAULT_TOLERANCE, bodyCenterHeight, bodyDistance, excessRadius, matchedDistance } from "../engine/distance";
import { findBandIndex } from "../engine/bands";
import { toFloor } from "../engine/axonometry";
import { bandAtHeight, heightStepOf } from "../engine/heights";
import { BandSet } from "../engine/types";
import { formatDistance } from "../util/flattenGridScale";
import type { DisplaySettings } from "../settings/display";
import { type Language } from "../i18n/language";
import { translate } from "../i18n/translate";

// What a Lectura says about a token, measured from an Origen: shared by the
// Medición in progress (createMeasureTool.ts) and the Medición fija
// (fixedMedicion.ts).

export type LecturaOrigin = {
  /** What the Lecturas measure from, in px. */
  center: Vector2;
  /** Grid units: 0 = ground, positive up, negative down. */
  height: number;
  /** The Origen token's radius in grid units, 0 from a point. */
  radius: number;
};

export type LecturaParams = {
  bandSet: BandSet;
  dpi: number;
  /** The grid's rhombus ratio, 0 on a flat grid (see axonometry.ts). */
  axonometry: number;
  display: DisplaySettings | null;
  /** Whether Lectura labels show the distance, so each state carries it. */
  showDistance: boolean;
};

/**
 * A token's distance from the Origen: `matched` (with Tolerancia) decides
 * its Banda and the Filtro; `shown` (without it) is the number its label
 * displays. Both measure between the two bodies (see bodyDistance).
 */
function lecturaDistance(
  token: Image,
  position: Vector2,
  tokenHeight: number,
  origin: LecturaOrigin,
  { bandSet, dpi, axonometry }: LecturaParams
): { matched: number; shown: number } {
  const { x: dx, y: dy } = toFloor(
    (position.x - origin.center.x) / dpi,
    (position.y - origin.center.y) / dpi,
    axonometry
  );
  const tokenRadius = getTokenRadius(token, dpi, axonometry);
  const dz = bodyCenterHeight(tokenHeight, tokenRadius) - bodyCenterHeight(origin.height, origin.radius);
  const excessRadiusSum = excessRadius(origin.radius) + excessRadius(tokenRadius);
  const { distance } = bodyDistance(dx, dy, dz, excessRadiusSum, bandSet.metric);
  const tolerance = (bandSet.tolerance ?? DEFAULT_TOLERANCE) / 100;
  return { matched: matchedDistance(distance, tolerance), shown: distance };
}

function isWithinFilter(distance: number, { bandSet, display }: LecturaParams): boolean {
  if (!display?.filterEnabled || !display.filterBandId) {
    return true;
  }
  const filterBandId = display.filterBandId;
  // A Banda that isn't in this set (deleted, or picked with another set)
  // filters nothing.
  const filterBand = bandSet.bands.find((band) => band.id === filterBandId);
  if (!filterBand) {
    return true;
  }
  return distance <= filterBand.radius;
}

/** One token's Lectura, at `position` and `tokenHeight` (which may differ from the stored token's while it's dragged). */
export function computeLecturaState(
  token: Image,
  position: Vector2,
  tokenHeight: number,
  origin: LecturaOrigin,
  params: LecturaParams
): LecturaState {
  const { matched, shown } = lecturaDistance(token, position, tokenHeight, origin, params);
  const state: LecturaState = {
    index: findBandIndex(matched, params.bandSet),
    withinFilter: isWithinFilter(matched, params),
    // Only its sign matters: which way the Lectura's arrow points.
    dz: origin.height - tokenHeight,
  };
  // Rounded here, not when drawn: sameLecturaState compares it, so a Lectura
  // is only redrawn and re-sent when the number shown changes.
  if (params.showDistance) {
    state.distance = Math.round(shown);
  }
  return state;
}

/** The Origen's height label: "Suelo", a Banda's name, or the distance, with its arrow. */
export function heightLabelText(
  height: number,
  bandSet: BandSet | null,
  gridScale: GridScale | null,
  language: Language
): string {
  if (height === 0) {
    return translate(language, "onMap.ground");
  }
  // By Banda, a height that is one is called by its name; otherwise (or by
  // cell) it's the distance itself.
  const band = bandSet && heightStepOf(bandSet) === "band" ? bandAtHeight(height, bandSet) : undefined;
  const text = band ? band.name : gridScale ? formatDistance(gridScale, Math.abs(height)) : String(Math.abs(height));
  // Emoji arrows: Owlbear's map font has no plain ↑/↓.
  return `${text} ${height > 0 ? "⬆️" : "⬇️"}`;
}
