import OBR, { type GridType } from "@owlbear-rodeo/sdk";
import { axonometryOf, liftsOn } from "../engine/axonometry";
import { getPluginId } from "../util/getPluginId";
import { isPlainObject } from "../util/isPlainObject";
import type { StoredDisplaySettings } from "./display";

/**
 * The room's settings, edited by the GM from Opciones (the language has its
 * own metadata key). Every optional field is missing from rooms saved
 * before it existed, and falls back as noted.
 */
export type GlobalSettings = {
  /** Single uppercase letters; hotkeyActivate is the Medición tool's shortcut. */
  hotkeyActivate: string;
  hotkeyRaise: string;
  hotkeyLower: string;
  /** Puts the Origen back on the ground while measuring. Missing = DEFAULT_HOTKEY_GROUND. */
  hotkeyGround?: string;
  /** Whether the "Altura" right-click option exists (only with enableAltitude). */
  showAltitudeMenu: boolean;
  /** Only a fallback for display.lecturaStyle/lecturaLabel (false = no Lecturas). Missing = true. */
  enableLecturas?: boolean;
  /** The height feature: markers, Z/X, the height label. Off = plain distance rings. Missing = true. */
  enableAltitude?: boolean;
  /** Only a fallback for display.lecturaLabel. Missing = false. */
  showLecturaDistance?: boolean;
  /** How height markers show. In "label" the marker stays (it stores the height) but is transparent. Missing = "icons". */
  markerStyle?: MarkerStyle;
  /** How things look on the map (see display.ts). */
  display?: StoredDisplaySettings;
  /** Who gets the Distancias panel's toolbar button. Missing = "off". */
  distancePanel?: DistancePanelAccess;
  /**
   * On an isometric/dimetric grid, draws each raised token raised (see
   * lift.ts) — it changes the tokens themselves, so it's opt-in. Missing = false.
   */
  isoLift?: boolean;
  /** With isoLift: a shadow on the floor under a raised token, a light under a sunk one. Missing = true. */
  isoShadow?: boolean;
  /** With isoLift: a line from the floor up (or down) to the token. Missing = true. */
  isoTether?: boolean;
  /**
   * With isoLift: a sunk token is drawn down by its head (its head at its
   * depth, see sunkLift) rather than by its feet, which leaves the light on
   * the floor above it uncovered. Missing = true.
   */
  isoSunkHead?: boolean;
  /**
   * What a height is shown and set against, with terrain (see terrain.ts):
   * "terrain" = above the ground each token stands on, "fixed" = above one
   * fixed ground for the whole map (like sea level). Distances are the same
   * either way. Missing = "terrain".
   */
  groundLevel?: GroundLevel;
  /** Terrain with a height (see terrain.ts): its context menu, its toolbar button, and zones counting. Missing = true. */
  enableTerrain?: boolean;
  /** How terrain zones are drawn (see terrainView.ts). Each field falls back on its own (resolveTerrainLook). */
  terrainLook?: Partial<TerrainLook>;
  /**
   * Who sees the terrain zones (see terrainStyle.ts): "hidden" = nobody
   * (drawn transparent, and not clickable), "gm" = only the GM (hidden in
   * Owlbear), "everyone". Missing = "gm".
   */
  terrainVisibility?: TerrainVisibility;
};

export type GroundLevel = "terrain" | "fixed";

/**
 * "outline": just each zone's outline in its height's color (see
 * terrainStyle.ts); "layers": zones filled like stacked cut paper, each
 * casting a shadow on what's lower (see terrainView.ts).
 */
export type TerrainLook = {
  style: "outline" | "layers";
  /** "grey": lighter the higher; "height": a height marker's color. */
  color: "grey" | "height";
  /** 0-100. */
  shadow: number;
  /** 10-100: how much of the map shows through. */
  opacity: number;
  /** The zones' outlines over the layers. */
  outline: boolean;
  /** Each zone's height written on it. */
  labels: boolean;
};

export const DEFAULT_TERRAIN_LOOK: TerrainLook = {
  style: "outline",
  color: "height",
  shadow: 60,
  opacity: 80,
  outline: true,
  labels: false,
};

/** The terrain look with every missing or invalid field filled from the defaults. */
export function resolveTerrainLook(settings: GlobalSettings): TerrainLook {
  const stored = isPlainObject(settings.terrainLook) ? settings.terrainLook : {};
  const pick = <K extends keyof TerrainLook>(key: K, valid: (value: unknown) => boolean): TerrainLook[K] =>
    valid(stored[key]) ? (stored[key] as TerrainLook[K]) : DEFAULT_TERRAIN_LOOK[key];
  const inRange = (min: number, max: number) => (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  return {
    style: pick("style", (v) => v === "outline" || v === "layers"),
    color: pick("color", (v) => v === "grey" || v === "height"),
    shadow: pick("shadow", inRange(0, 100)),
    opacity: pick("opacity", inRange(10, 100)),
    outline: pick("outline", (v) => typeof v === "boolean"),
    labels: pick("labels", (v) => typeof v === "boolean"),
  };
}
export type TerrainVisibility = "hidden" | "gm" | "everyone";

export function terrainVisibility(settings: GlobalSettings): TerrainVisibility {
  return settings.terrainVisibility ?? "gm";
}

export type DistancePanelAccess = "off" | "gm" | "everyone";
export type MarkerStyle = "icons" | "label" | "both";

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  hotkeyActivate: "O",
  hotkeyRaise: "X",
  hotkeyLower: "Z",
  showAltitudeMenu: true,
  enableLecturas: true,
  enableAltitude: true,
  showLecturaDistance: false,
  markerStyle: "icons",
  distancePanel: "off",
};

export const DEFAULT_HOTKEY_GROUND = "C";

/** Whether heights are shown and set above one fixed ground (see GlobalSettings.groundLevel). */
export function fixedGround(settings: GlobalSettings): boolean {
  return settings.groundLevel === "fixed";
}

export function groundHotkey(settings: GlobalSettings): string {
  return settings.hotkeyGround ?? DEFAULT_HOTKEY_GROUND;
}

const optionalBoolean = (value: unknown) => value === undefined || typeof value === "boolean";

const METADATA_KEY = getPluginId("globalSettings");

function isLetter(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]$/.test(value);
}

function isGlobalSettings(value: unknown): value is GlobalSettings {
  return (
    isPlainObject(value) &&
    isLetter(value.hotkeyActivate) &&
    isLetter(value.hotkeyRaise) &&
    isLetter(value.hotkeyLower) &&
    (value.hotkeyGround === undefined || isLetter(value.hotkeyGround)) &&
    typeof value.showAltitudeMenu === "boolean" &&
    optionalBoolean(value.enableLecturas) &&
    optionalBoolean(value.enableAltitude) &&
    optionalBoolean(value.showLecturaDistance) &&
    optionalBoolean(value.isoLift) &&
    optionalBoolean(value.isoShadow) &&
    optionalBoolean(value.isoTether) &&
    optionalBoolean(value.isoSunkHead) &&
    (value.markerStyle === undefined ||
      value.markerStyle === "icons" ||
      value.markerStyle === "label" ||
      value.markerStyle === "both") &&
    (value.distancePanel === undefined ||
      value.distancePanel === "off" ||
      value.distancePanel === "gm" ||
      value.distancePanel === "everyone") &&
    (value.groundLevel === undefined || value.groundLevel === "terrain" || value.groundLevel === "fixed") &&
    optionalBoolean(value.enableTerrain) &&
    // Each field inside is checked (and falls back) on its own in resolveTerrainLook.
    (value.terrainLook === undefined || isPlainObject(value.terrainLook)) &&
    (value.terrainVisibility === undefined ||
      value.terrainVisibility === "hidden" ||
      value.terrainVisibility === "gm" ||
      value.terrainVisibility === "everyone") &&
    // Each field inside is checked (and falls back) on its own in resolveDisplay.
    (value.display === undefined || isPlainObject(value.display))
  );
}

export function globalSettingsFromMetadata(metadata: Record<string, unknown>): GlobalSettings {
  const stored = metadata[METADATA_KEY];
  return isGlobalSettings(stored) ? stored : DEFAULT_GLOBAL_SETTINGS;
}

export async function getGlobalSettings(): Promise<GlobalSettings> {
  return globalSettingsFromMetadata(await OBR.scene.getMetadata());
}

export async function setGlobalSettings(settings: GlobalSettings): Promise<void> {
  await OBR.scene.setMetadata({ [METADATA_KEY]: settings });
}

/**
 * Whether terrain counts on this grid (see terrain.ts): with heights and
 * terrain on, and not on an isometric or dimetric grid — there the map's
 * art already shows the relief, and a token drawn on a roof stands up the
 * screen from where it is on the floor, so its distances would be off.
 * Hex grids are flat to Owlbear: terrain works there.
 */
export function terrainOn(settings: GlobalSettings, gridType: GridType): boolean {
  return (settings.enableAltitude ?? true) && (settings.enableTerrain ?? true) && axonometryOf(gridType) === 0;
}

/** Whether raised tokens are drawn raised on this grid (see liftsOn). */
export function liftsTokens(settings: GlobalSettings, gridType: GridType): boolean {
  return liftsOn(gridType) && (settings.enableAltitude ?? true) && settings.isoLift === true;
}

/** A hotkey letter as ToolMode.onKeyDown's event.code, e.g. "X" -> "KeyX". */
export function letterToCode(letter: string): string {
  return `Key${letter}`;
}
