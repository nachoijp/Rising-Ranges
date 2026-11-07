import OBR, { type Item, type Metadata } from "@owlbear-rodeo/sdk";
import { DOORS, SMOKE } from "../relief/trace/fogPlan";
import type { DoorLink } from "../relief/types";

// Opening and shutting a relief's door from the Vistazo: written to the fog
// door it's linked to (Owlbear's fog shape's doors, or Smoke & Spectre!'s
// door line), the one place its state is kept; the 3D leaf, the map and the
// fog follow from there.

/**
 * Whether this player may open or shut a fog door: the GM always; a player
 * as the fog extension lets them — Owlbear's, if they may change the fog
 * (the room's fog permission); Smoke & Spectre!'s, with its "players open
 * doors" on, and if they may change its line (written here as theirs).
 */
export function mayOpen(link: DoorLink, items: Item[], sceneMetadata: Metadata, isGM: boolean, mayUpdate: (item: Item) => boolean): boolean {
  if (isGM) return true;
  const item = items.find((i) => i.id === link.item);
  if (!item) return false;
  if (link.kind === "smoke" && sceneMetadata[`${SMOKE}playerDoors`] !== true) return false;
  return mayUpdate(item);
}

/** The fog door set open or shut. */
export async function setFogDoor(link: DoorLink, open: boolean): Promise<void> {
  await OBR.scene.items.updateItems([link.item], (drafts) => {
    const draft = drafts[0];
    if (!draft) return;
    if (link.kind === "smoke") {
      // As Smoke & Spectre! opens one (read from a room, 2026-11): open, and its line no longer blocking
      // (disabled) — doorOpen alone shows it open but the sight stays shut.
      draft.metadata[`${SMOKE}doorOpen`] = open;
      draft.metadata[`${SMOKE}disabled`] = open;
      return;
    }
    const doors = draft.metadata[DOORS];
    if (Array.isArray(doors) && doors[link.index] && typeof doors[link.index] === "object") {
      // A new list (the metadata's compared as a whole): the rest as they were.
      draft.metadata[DOORS] = doors.map((door, i) => (i === link.index ? { ...(door as object), open } : door));
    }
  });
}
