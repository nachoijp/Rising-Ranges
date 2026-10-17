import OBR from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";

// The Vistazo's panel: a popover the Medición's toolbar button opens and
// closes (see createVistazoAction.ts), like the Distancias panel. It stays
// open when another tool is picked (a minimap), and its page resizes it
// (Owlbear lets a page set its popover's size) or shrinks it to a bar.

export const VISTAZO_POPOVER_ID = getPluginId("popover/vistazo");

/** Where it opens until it's dragged elsewhere: the screen's top-left corner, clear of Owlbear's top bar (an estimate). */
export const DEFAULT_POSITION = { left: 16, top: 72 };

export type PanelPosition = { left: number; top: number };

// Where it was last dropped, per browser (each screen is different).
const POSITION_KEY = "rising-ranges/vistazo-position";

export function readPanelPosition(): PanelPosition {
  try {
    const stored = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null");
    if (stored && Number.isFinite(stored.left) && Number.isFinite(stored.top)) {
      return { left: stored.left, top: stored.top };
    }
  } catch {
    // The default, then.
  }
  return DEFAULT_POSITION;
}

/** null forgets it: back to the default corner. */
export function savePanelPosition(position: PanelPosition | null) {
  try {
    if (position) {
      localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    } else {
      localStorage.removeItem(POSITION_KEY);
    }
  } catch {
    // Not remembered, but it still moves.
  }
}

function popoverOptions(position: PanelPosition, width: number, height: number) {
  return {
    id: VISTAZO_POPOVER_ID,
    url: "/vistazo.html",
    width: Math.round(width),
    height: Math.round(height),
    anchorReference: "POSITION" as const,
    anchorPosition: position,
    anchorOrigin: { horizontal: "LEFT" as const, vertical: "TOP" as const },
    transformOrigin: { horizontal: "LEFT" as const, vertical: "TOP" as const },
    // Meant to stay up while the map's used: only its button, its Esc or full screen close it.
    disableClickAway: true,
    hidePaper: true,
  };
}

/**
 * Moves the open panel: opening an open popover again (same id and page)
 * only moves and resizes it, without reloading the page (as the Distancias panel's handle does).
 */
export async function moveVistazoPanel(position: PanelPosition, width: number, height: number) {
  await OBR.popover.open(popoverOptions(position, width, height));
}

/** The size it was left at, per browser (the page saves it; same origin, so shared). */
export const SIZE_KEY = "rising-ranges/vistazo-size";
export const MIN_WIDTH = 220;
export const MIN_HEIGHT = 180;
/** Shrunk to a bar (see the page's minimize button). */
export const BAR_WIDTH = 200;
export const BAR_HEIGHT = 44;

export type PanelSize = { width: number; height: number; compact: boolean };

export function readPanelSize(): Partial<PanelSize> {
  try {
    return JSON.parse(localStorage.getItem(SIZE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function savePanelSize(size: Partial<PanelSize>) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify({ ...readPanelSize(), ...size }));
  } catch {
    // Only a convenience.
  }
}

// The page tells the background script (which owns the button) when it opens or closes itself,
// over a broadcast that never leaves this client.
const STATE_CHANNEL = getPluginId("vistazoPanel");

// Whether this client has the panel open (Owlbear can't tell: see the Distancias panel).
let open = false;
let watching = false;

/** Background script: keeps `open` in step with the page closing or reopening itself. */
export function watchVistazoPanel() {
  if (watching) {
    return;
  }
  watching = true;
  OBR.broadcast.onMessage(STATE_CHANNEL, (event) => {
    open = event.data === true;
  });
}

/** Opens the panel, at the size it was left at (most of the screen the first time). */
export async function openVistazoPanel() {
  let width = 900;
  let height = 600;
  let position = readPanelPosition();
  try {
    const [screenWidth, screenHeight] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight()]);
    const saved = readPanelSize();
    width = Math.min(screenWidth - 32, saved.width ?? screenWidth - 120);
    height = Math.min(screenHeight - 88, saved.height ?? screenHeight - 140);
    // Kept on screen: it may have shrunk since it was dropped there.
    position = {
      left: Math.max(0, Math.min(position.left, screenWidth - width)),
      top: Math.max(0, Math.min(position.top, screenHeight - height)),
    };
  } catch {
    // The defaults, then.
  }
  open = true;
  await OBR.broadcast.sendMessage(STATE_CHANNEL, true, { destination: "LOCAL" }).catch(() => {});
  await OBR.popover.open(popoverOptions(position, Math.max(MIN_WIDTH, width), Math.max(MIN_HEIGHT, height)));
}

/** Whether this client has the panel open, as far as the background script knows. */
export function isVistazoOpen(): boolean {
  return open;
}

/** The page: closes its panel, and lets the button know. */
export async function closeVistazoPanel() {
  open = false;
  await OBR.broadcast.sendMessage(STATE_CHANNEL, false, { destination: "LOCAL" }).catch(() => {});
  await OBR.popover.close(VISTAZO_POPOVER_ID);
}

/** The toolbar button: opens the panel, or closes it if it's open. */
export async function toggleVistazoPanel() {
  if (open) {
    await closeVistazoPanel();
  } else {
    await openVistazoPanel();
  }
}
