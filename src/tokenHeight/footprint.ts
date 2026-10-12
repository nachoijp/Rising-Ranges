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
