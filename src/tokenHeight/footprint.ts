import type { Item } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";

// How many cells across a token takes on the floor, when it's set by hand
// (the token's context menu): what it's measured as, instead of its image.
// For art whose image says little about the creature's size — a model with
// long tentacles, or a lot of empty space around it. Unset = from its image
// (see getTokenRadius).

const METADATA_KEY = getPluginId("footprint");

/** The sizes the menu offers, in cells across. */
export const FOOTPRINTS = [1, 2, 3, 4] as const;

/** The range a size typed by hand is kept to, in cells across. */
export const MIN_FOOTPRINT = 0.25;
export const MAX_FOOTPRINT = 20;

/** A size typed by hand, kept in range and to two decimals. */
export function clampFootprint(cells: number): number {
  return Math.round(Math.min(MAX_FOOTPRINT, Math.max(MIN_FOOTPRINT, cells)) * 100) / 100;
}

/** The token's footprint in cells across, if set by hand. */
export function getTokenFootprint(item: Item): number | undefined {
  const stored = item.metadata[METADATA_KEY];
  return typeof stored === "number" && Number.isFinite(stored) && stored > 0 ? stored : undefined;
}

/** Sets a token draft's footprint (undefined = from its image again). */
export function setTokenFootprint(item: Item, cells: number | undefined) {
  if (cells === undefined) {
    delete item.metadata[METADATA_KEY];
  } else {
    item.metadata[METADATA_KEY] = cells;
  }
}

// How tall a token is, in cells, when it's set by hand (the same menu): how
// far down a sunk token goes for its head to be below its depth (see
// sunkHead), instead of its image's top — art with empty space above it, or
// a raised weapon or wings, would go too far. Unset = from its image.
// Only for drawing: distances still take a token's height from its footprint.

const TALL_KEY = getPluginId("tall");

/** The range a height typed by hand is kept to, in cells. */
export const MIN_TALL = 0.25;
export const MAX_TALL = 20;

/** A height typed by hand, kept in range and to two decimals. */
export function clampTall(cells: number): number {
  return Math.round(Math.min(MAX_TALL, Math.max(MIN_TALL, cells)) * 100) / 100;
}

/** How tall the token is in cells, if set by hand. */
export function getTokenTall(item: Item): number | undefined {
  const stored = item.metadata[TALL_KEY];
  return typeof stored === "number" && Number.isFinite(stored) && stored > 0 ? stored : undefined;
}

/** Sets a token draft's height (undefined = from its image again). */
export function setTokenTall(item: Item, cells: number | undefined) {
  if (cells === undefined) {
    delete item.metadata[TALL_KEY];
  } else {
    item.metadata[TALL_KEY] = cells;
  }
}

// Where a standing image touches the ground in the Vistazo 3D, when it's set
// by hand (the same menu): a point of its picture, as fractions of its width
// and height from its top-left. Unset = from what of it shows (see
// visibleBox in vistazo/render.ts). Only for the Vistazo: the map and the
// distances don't change.

const VISTAZO_BASE_KEY = getPluginId("vistazoBase");

export type VistazoBase = { x: number; y: number };

/** Where setting it by hand starts: its bottom, in the middle. */
export const DEFAULT_VISTAZO_BASE: VistazoBase = { x: 0.5, y: 1 };

export function getVistazoBase(item: Item): VistazoBase | undefined {
  const stored = item.metadata[VISTAZO_BASE_KEY] as Partial<VistazoBase> | undefined;
  const ok = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  return stored && ok(stored.x) && ok(stored.y) ? { x: stored.x, y: stored.y } : undefined;
}

/** Sets an item draft's base (undefined = from its image again). */
export function setVistazoBase(item: Item, base: VistazoBase | undefined) {
  if (base === undefined) {
    delete item.metadata[VISTAZO_BASE_KEY];
  } else {
    item.metadata[VISTAZO_BASE_KEY] = { x: base.x, y: base.y };
  }
}
