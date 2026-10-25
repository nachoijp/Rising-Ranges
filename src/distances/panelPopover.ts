import OBR from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { GLASS_FRAME } from "../util/glass";

export const DISTANCES_POPOVER_ID = getPluginId("popover/distances");

export const PANEL_MIN_WIDTH = 300;
export const PANEL_MAX_WIDTH = 560;
/** Until Owlbear reports how much room is left on screen (see roomBelow). */
export const PANEL_MAX_HEIGHT = 600;
/**
 * Where the panel opens until someone drags it elsewhere: the screen's
 * top-left corner, clear of Owlbear's own top bar (an estimate, like the
 * other popovers' sizes).
 */
export const DEFAULT_PANEL_POSITION: PanelPosition = { left: 16, top: 72 };
// Only until the panel has measured its content and resized to fit it.
const PANEL_INITIAL_HEIGHT = 160;

export type PanelPosition = { left: number; top: number };

// Where the panel was last dropped, per browser (not a room setting: each
// person's screen is different). The background script and the panel page
// are the same origin, so they share it.
const POSITION_KEY = "distancesPanelPosition";

export function getPanelPosition(): PanelPosition {
  try {
    const stored = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null");
    if (stored && Number.isFinite(stored.left) && Number.isFinite(stored.top)) {
      return { left: stored.left, top: stored.top };
    }
  } catch {
    // No storage (a private window): the default it is.
  }
  return DEFAULT_PANEL_POSITION;
}

/** null forgets the stored position, so the panel goes back to its default. */
export function savePanelPosition(position: PanelPosition | null) {
  try {
    if (position) {
      localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    } else {
      localStorage.removeItem(POSITION_KEY);
    }
  } catch {
    // Not remembered, but the panel still moves.
  }
}

// Its size when set by hand (the corner handle), per browser too; none: it fits its content.
const SIZE_KEY = "rising-ranges/distances/size";

export function readPanelSize(): { width: number; height: number } | null {
  try {
    const stored = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null");
    if (stored && Number.isFinite(stored.width) && Number.isFinite(stored.height)) {
      return { width: stored.width, height: stored.height };
    }
  } catch {
    // Fitted to its content, then.
  }
  return null;
}

/** null: back to fitting its content. */
export function savePanelSize(size: { width: number; height: number } | null) {
  try {
    if (size) {
      localStorage.setItem(SIZE_KEY, JSON.stringify(size));
    } else {
      localStorage.removeItem(SIZE_KEY);
    }
  } catch {
    // Not remembered, but it's that size until it closes.
  }
}

/** Keeps a panel of the given size fully on a screen of the given size. */
export function clampPanelPosition(
  position: PanelPosition,
  size: { width: number; height: number },
  screen: { width: number; height: number }
): PanelPosition {
  return {
    left: Math.round(Math.max(0, Math.min(position.left, screen.width - size.width))),
    top: Math.round(Math.max(0, Math.min(position.top, screen.height - size.height))),
  };
}

function popoverOptions(position: PanelPosition, width: number, height: number) {
  return {
    id: DISTANCES_POPOVER_ID,
    url: "/distances.html",
    width,
    height,
    // Placed on the screen rather than anchored to the toolbar button:
    // anchored, it opened over the middle of the map, right on top of the
    // tokens it lists.
    anchorReference: "POSITION" as const,
    anchorPosition: position,
    anchorOrigin: { horizontal: "LEFT" as const, vertical: "TOP" as const },
    transformOrigin: { horizontal: "LEFT" as const, vertical: "TOP" as const },
    disableClickAway: true,
    // The page draws its own translucent panel (GlassFrame).
    hidePaper: true,
  };
}

/**
 * Moves the open panel. Owlbear can't move a popover, but opening one that
 * is already open, same id and page, only moves and resizes it: the page
 * isn't reloaded, so nothing in it is lost, and it answers fast enough to
 * follow a drag.
 */
export async function moveDistancesPanel(position: PanelPosition, width: number, height: number) {
  await OBR.popover.open(popoverOptions(position, width, height));
}

// The panel's ✕ tells the background script (which owns the toolbar
// button) that it closed, over a broadcast that never leaves this client.
const CLOSED_CHANNEL = getPluginId("distancesClosed");

// Whether this client has the panel open. Tracked here because Owlbear
// can't tell: OBR.popover.getWidth never answers for a closed popover (it
// times out after 5s). If it's ever wrong (the panel closed some other
// way), the button just needs one extra click.
let open = false;

/** Background script: keeps `open` in step with the panel's own ✕. */
let watching = false;
export function watchDistancesPanel() {
  // The toolbar action is registered again whenever the settings change;
  // one listener is enough.
  if (watching) {
    return;
  }
  watching = true;
  OBR.broadcast.onMessage(CLOSED_CHANNEL, () => {
    open = false;
  });
}

/** Panel page: closes itself and lets the toolbar button know. */
export async function closeDistancesPanel() {
  await OBR.broadcast.sendMessage(CLOSED_CHANNEL, null, { destination: "LOCAL" });
  await OBR.popover.close(DISTANCES_POPOVER_ID);
}

/**
 * The toolbar button opens the Distancias panel, or closes it if it's
 * already open. The panel never closes on its own when the map is clicked
 * (it's meant to stay up while tokens move), so the button and the panel's
 * own ✕ are the ways out.
 */
export async function toggleDistancesPanel() {
  if (open) {
    open = false;
    await OBR.popover.close(DISTANCES_POPOVER_ID);
    return;
  }
  open = true;
  const width = PANEL_MIN_WIDTH + GLASS_FRAME;
  let position = getPanelPosition();
  // The screen may have shrunk since it was dropped there.
  try {
    const [screenWidth, screenHeight] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight()]);
    position = clampPanelPosition(
      position,
      { width, height: PANEL_INITIAL_HEIGHT },
      { width: screenWidth, height: screenHeight }
    );
  } catch {
    // Opened where it was, then.
  }
  await OBR.popover.open(popoverOptions(position, width, PANEL_INITIAL_HEIGHT));
}
