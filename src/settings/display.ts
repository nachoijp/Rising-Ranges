import { BandSet, IconPosition, IconShape } from "../engine/types";
import { isPlainObject } from "../util/isPlainObject";
import { ICON_SHAPES } from "../render/iconStack";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import { globalSettingsFromMetadata } from "./globalSettings";

/** What each measured token shows during a Medición. */
export type LecturaStyle = "none" | "icon" | "ring" | "circle";
/** What a Lectura's text label shows. */
export type LecturaLabel = "none" | "band" | "distance" | "both";
/** What the label next to each Banda ring shows. */
export type RingLabel = "none" | "name" | "distance" | "both";

/** The two "Avanzado" levers of a Lectura style; what `size` means depends on the style. */
export type StyleTuning = {
  /** Icon: stack scale (0.5-2). Ring: stroke width, fraction of a grid cell (0.01-0.2). Circle: diameter relative to the token (0.5-1.5). */
  size: number;
  /** 0-1 */
  opacity: number;
};

export type MarkerTuning = {
  position: IconPosition;
  /** 0.5-2 */
  size: number;
  /** 0-1 */
  opacity: number;
  /** Gap from the token, fraction of a grid cell (0-0.4). */
  distance: number;
};

/**
 * How the extension looks on the map — a room setting, edited from the
 * Medidas and Altura tabs, the same whichever set of Bandas is picked
 * (built-in presets included).
 */
export type DisplaySettings = {
  lecturaStyle: LecturaStyle;
  lecturaLabel: LecturaLabel;
  ringLabel: RingLabel;
  /** Scale of the Lecturas' labels and the Origen's height label (0.5-2). */
  lecturaLabelSize: number;
  /** Scale of the rings' labels (0.5-2). */
  ringLabelSize: number;
  filterEnabled: boolean;
  /** Only meaningful while filterEnabled; a Banda of the active set, or ignored. */
  filterBandId?: string;
  /** Shared by the markers and icon-style Lecturas (a Banda can override it). */
  iconShape: IconShape;
  lecturaIcon: StyleTuning;
  lecturaRing: StyleTuning;
  lecturaCircle: StyleTuning;
  marker: MarkerTuning;
};

/** As stored: any field may be missing (or invalid), falling back per field. */
export type StoredDisplaySettings = Partial<Record<keyof DisplaySettings, unknown>>;

const LECTURA_STYLES: LecturaStyle[] = ["none", "icon", "ring", "circle"];
const LECTURA_LABELS: LecturaLabel[] = ["none", "band", "distance", "both"];
const RING_LABELS: RingLabel[] = ["none", "name", "distance", "both"];
const POSITIONS: IconPosition[] = ["left", "top", "bottom", "right"];

const oneOf = <T extends string>(options: readonly T[], value: unknown): T | undefined =>
  options.includes(value as T) ? (value as T) : undefined;

const inRange = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;

function tuning(value: unknown, sizeRange: [number, number], fallback: StyleTuning): StyleTuning {
  const stored = isPlainObject(value) ? value : {};
  return {
    size: inRange(stored.size, ...sizeRange) ?? fallback.size,
    opacity: inRange(stored.opacity, 0, 1) ?? fallback.opacity,
  };
}

/** Two on/off parts as one four-way choice. */
function parts<T extends string>(first: boolean, second: boolean, names: [T, T, T, T]): T {
  const [none, onlyFirst, onlySecond, both] = names;
  return first ? (second ? both : onlyFirst) : second ? onlySecond : none;
}

export const SIZE_RANGES = {
  icon: [0.5, 2] as [number, number],
  ring: [0.01, 0.2] as [number, number],
  circle: [0.5, 1.5] as [number, number],
  marker: [0.5, 2] as [number, number],
  // Below 0 the marker goes over the image: a slim figure on wide art (often on axonometric maps) can have its label right beside it.
  markerDistance: [-1, 0.5] as [number, number],
  label: [0.5, 2] as [number, number],
};

/**
 * The room's display settings, every field filled in. A field the room
 * hasn't set yet (every room from before 0.6.0) falls back to where it
 * used to live — the active BandSet, or the old Global toggles — so
 * updating changes nothing on screen until the GM changes it.
 */
export function resolveDisplay(
  stored: StoredDisplaySettings | undefined,
  bandSet: BandSet,
  legacy: { enableLecturas?: boolean; showLecturaDistance?: boolean } = {}
): DisplaySettings {
  const s = stored ?? {};
  const filterEnabled = typeof s.filterEnabled === "boolean" ? s.filterEnabled : bandSet.filterEnabled ?? false;
  const filterBandId =
    typeof s.filterBandId === "string" ? s.filterBandId : s.filterEnabled === undefined ? bandSet.filterBandId : undefined;
  const marker = isPlainObject(s.marker) ? s.marker : {};
  return {
    lecturaStyle:
      oneOf(LECTURA_STYLES, s.lecturaStyle) ??
      (legacy.enableLecturas === false ? "none" : bandSet.visualization ?? "icon"),
    // The old "Lecturas" switch hid the label too; now "none" only hides the
    // visual, so a room that had it off keeps no label either.
    lecturaLabel:
      oneOf(LECTURA_LABELS, s.lecturaLabel) ??
      (legacy.enableLecturas === false
        ? "none"
        : parts(bandSet.showLabel ?? false, legacy.showLecturaDistance ?? false, ["none", "band", "distance", "both"])),
    ringLabel:
      oneOf(RING_LABELS, s.ringLabel) ??
      parts(!bandSet.hideLabel, !bandSet.hideSize, ["none", "name", "distance", "both"]),
    lecturaLabelSize: inRange(s.lecturaLabelSize, ...SIZE_RANGES.label) ?? 1,
    ringLabelSize: inRange(s.ringLabelSize, ...SIZE_RANGES.label) ?? 1,
    filterEnabled,
    filterBandId,
    iconShape: oneOf(ICON_SHAPES, s.iconShape) ?? bandSet.iconShape ?? "circle",
    lecturaIcon: tuning(s.lecturaIcon, SIZE_RANGES.icon, { size: bandSet.iconSize ?? 1, opacity: 1 }),
    lecturaRing: tuning(s.lecturaRing, SIZE_RANGES.ring, { size: bandSet.ringWidth ?? 0.05, opacity: 0.9 }),
    lecturaCircle: tuning(s.lecturaCircle, SIZE_RANGES.circle, { size: 1, opacity: bandSet.circleOpacity ?? 0.35 }),
    marker: {
      position: oneOf(POSITIONS, marker.position) ?? bandSet.iconPosition ?? "top",
      size: inRange(marker.size, ...SIZE_RANGES.marker) ?? bandSet.iconSize ?? 1,
      opacity: inRange(marker.opacity, 0, 1) ?? 1,
      distance: inRange(marker.distance, ...SIZE_RANGES.markerDistance) ?? bandSet.iconDistance ?? 0.15,
    },
  };
}

/** The room's display settings from already-fetched scene metadata. */
export function displayFromMetadata(metadata: Record<string, unknown>): DisplaySettings {
  const settings = globalSettingsFromMetadata(metadata);
  return resolveDisplay(settings.display, bandSetFromMetadata(metadata), settings);
}

export const showsBandName =(label: LecturaLabel | RingLabel) => label === "band" || label === "name" || label === "both";
export const showsDistance = (label: LecturaLabel | RingLabel) => label === "distance" || label === "both";
