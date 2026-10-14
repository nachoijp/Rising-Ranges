import OBR, {
  buildLabel,
  buildPath,
  Command,
  isImage,
  isLabel,
  isPath,
  isShape,
  type AttachmentBehavior,
  type GridScale,
  type GridType,
  type Image,
  type Item,
  type Label,
  type Path,
  type Vector2,
} from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { applyLabelTextStyle, getColorString, getIconStrokeColor } from "../util/color";
import { formatDistance } from "../util/flattenGridScale";
import { getStoredTheme, THEME_STORAGE_KEYS } from "../theme/themes";
import { BandSet, IconPosition } from "../engine/types";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import { fixedGround, globalSettingsFromMetadata, liftsTokens } from "../settings/globalSettings";
import { terrainAt, terrainZones } from "../terrain/terrain";
import { computeIconAnchor, getTokenBounds, getTokenRadius } from "../render/iconAnchor";
import { getTokenFootprint } from "../tokenHeight/footprint";
import { buildFloorShape } from "../render/floorShape";
import { activeLift, asDrawn, onFloor, sunkHead } from "../tokenHeight/lift";
import { axonometryOf } from "../engine/axonometry";
import { getGridAxonometry } from "../util/gridAxonometry";
import { iconStackExtent } from "../render/iconStack";
import { followMap, LABEL_FONT_SIZE } from "../render/lecturaItems";
import {
  getTokenHeight,
  getMarkerDrag,
  isTokenHeightMarker,
  MARKER_STROKE_OPACITY,
  markerAppearance,
  markerBaseColor,
  markerLookFromMetadata,
  type MarkerLook,
} from "../tokenHeight/markers";

// What a height marker shows: its icon stack ("icons" and "both" styles)
// and its "⬆️ 30ft" label ("label", where the icons would be, and "both",
// just past them). The marker in the scene only stores the height and the
// icons' shape, and is never drawn itself (see markers.ts).
//
// Client-local on every client, derived from the markers themselves, rather
// than real scene items: each client draws them in its own color theme;
// every client runs this background script, so real items would need one
// designated writer to avoid duplicates (and players can't always write);
// and switching styles would mean a scene-wide rewrite. Local items cost
// nothing to add or drop, and each one is attachedTo its token, so Owlbear
// moves it with the token like it does the marker.
//
// An item's position is only ever set when it's created: whenever anything
// it shows changes, it's deleted and rebuilt from the token's current
// position, rather than repositioned in place — an attached local item's
// stored position doesn't follow its token (see measureMirror.ts), so
// writing a fresh absolute position into an existing one isn't safe.
//
// Mid-drag is the exception. Owlbear carries what's attached to a token
// along while it's dragged, but only as it was when the drag began: an item
// added meanwhile rides along at whatever distance it was from the token
// when added, and moving one meanwhile does nothing. Only its content
// (shape, colors, text) can still change. So while its token is being
// dragged (this client's drag, or a marker that says it's mid-drag — see
// MarkerDrag), an overlay that exists is updated in place, and one that
// doesn't is held back until the token is dropped — except on the dragging
// client, which knows where the token is on every move: there it's built
// unattached and moved along by hand (setDraggedToken). Once the token is
// dropped, everything touched during the drag is rebuilt from where it
// landed. For that, every token has its overlays even on the ground (or
// with no marker at all): invisible, but there to be updated in place.

const OVERLAY_KEY = getPluginId("heightOverlay");

/** `follow`: built during this client's drag of its token, so it's put back beside it on every move (see setDraggedToken). */
type Drawn = { id: string; signature: string; follow?: { tokenId: string; offset: Vector2 } };
type Wanted = {
  signature: string;
  build: () => Item;
  /** Changes an existing item's content (not where it is) to this. */
  apply: (item: Item) => void;
  /** Its token is mid-drag: updated in place, never added (see the top of this file). */
  held: boolean;
  /** This client is the one dragging it, and the token is here: built unattached, and moved along by hand. */
  live?: { tokenId: string; position: Vector2 };
};
type Piece = Omit<Wanted, "held" | "live">;

let metadata: Record<string, unknown> = {};
let items: Item[] = [];
let dpi = 0;
/** The grid's rhombus ratio, 0 on a flat grid (see axonometry.ts). */
let axonometry = 0;
let gridType: GridType = "SQUARE";
let gridScale: GridScale | null = null;
let role: "GM" | "PLAYER" = "PLAYER";
let sceneReady = false;
/**
 * A marker's drag older than this is taken as over: the client dragging
 * left, or its last write failed. Owlbear stops syncing a drag to other
 * clients 15s in anyway.
 */
const STALE_DRAG_MS = 20000;
/** When this client first saw each marker drag (by marker and drag). */
const dragSeen = new Map<string, number>();
let staleTimer: ReturnType<typeof setTimeout> | null = null;
/** The token this client is dragging (the Medición tool), and where it is now. */
let dragged: { tokenId: string; position: Vector2 } | null = null;

/** "icon:", "label:", "shadow:" or "tether:" + tokenId -> the item drawn for it. */
const drawn = new Map<string, Drawn>();
// Set whenever this client may have labels it isn't tracking (a fresh
// scene, or a write that failed partway): the next pass deletes every one
// and redraws from scratch.
let resync = true;
let running = false;
let dirty = false;

const ARROW = { up: "⬆️", down: "⬇️" } as const;
// Gap between the marker's icon stack and the label, in the "both" style.
const TEXT_GAP = 0.05;
const NO_EXTENT = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
// Never seen: a token on the ground's overlays are invisible.
const GROUND_COLOR = { r: 0, g: 0, b: 0 };

/** Where the label sits on the marker's side of the token, and which way it hangs from there (away from the token). */
function textPlacement(
  token: Image,
  side: IconPosition,
  iconDistance: number,
  extent: typeof NO_EXTENT,
  gap: number
) {
  const anchor = computeIconAnchor(token, dpi, side, iconDistance);
  switch (side) {
    case "top":
      return { position: { x: anchor.x, y: anchor.y + extent.minY - gap }, pointer: "DOWN" as const };
    case "bottom":
      return { position: { x: anchor.x, y: anchor.y + extent.maxY + gap }, pointer: "UP" as const };
    case "left":
      return { position: { x: anchor.x + extent.minX - gap, y: anchor.y }, pointer: "RIGHT" as const };
    case "right":
    default:
      return { position: { x: anchor.x + extent.maxX + gap, y: anchor.y }, pointer: "LEFT" as const };
  }
}

/** A marker's icon stack, as drawn for the height shown (see markerAppearance). */
type IconDrawing = { commands: Path["commands"]; strokeWidth: number };

/** `height` 0: on the ground (or no marker), drawn invisible. */
function wantedLabel(
  drawing: IconDrawing | undefined,
  height: number,
  token: Image,
  bandSet: BandSet,
  scale: GridScale,
  look: MarkerLook,
  held: boolean
): Piece {
  const text = height ? `${height > 0 ? ARROW.up : ARROW.down} ${formatDistance(scale, Math.abs(height))}` : "";
  const baseColor = height ? markerBaseColor(height, bandSet, getStoredTheme()) : GROUND_COLOR;
  const color = getColorString(baseColor);
  const { position: side, distance: iconDistance, size } = look.tuning;
  const opacity = height ? look.tuning.opacity : 0;
  // In "label" the label takes the icons' place; in "both" it goes past them.
  const extent = look.style === "both" && drawing && height ? iconStackExtent(drawing.commands) : NO_EXTENT;
  const gap = look.style === "both" ? TEXT_GAP * dpi : 0;
  const signature = JSON.stringify([
    text,
    color,
    side,
    iconDistance,
    opacity,
    size,
    extent,
    gap,
    dpi,
    token.scale,
    token.image.width,
    token.image.height,
    token.grid,
    token.visible,
    // Rebuilt once the drag it was drawn in is over, from where the token landed.
    held,
  ]);
  const style = (label: Label) => {
    label.text.plainText = text;
    // The marker's size setting scales the label like it does the icons
    label.text.style.fontSize = LABEL_FONT_SIZE * size;
    label.text.style.padding = 4 * size;
    label.style.cornerRadius = 12 * size;
    label.style.backgroundColor = color;
    label.style.backgroundOpacity = 0.85 * opacity;
    label.visible = token.visible;
    applyLabelTextStyle(label, baseColor, opacity);
  };
  return {
    signature,
    apply: (item) => {
      if (isLabel(item)) {
        style(item);
      }
    },
    build: () => {
      const { position, pointer } = textPlacement(token, side, iconDistance, extent, gap);
      const label = buildLabel()
        .position(position)
        .pointerDirection(pointer)
        .pointerHeight(0)
        .attachedTo(token.id)
        .layer("ATTACHMENT")
        .locked(true)
        .disableHit(true)
        .build();
      style(label);
      label.metadata[OVERLAY_KEY] = { tokenId: token.id };
      return followMap(label);
    },
  };
}

/** `height` 0: on the ground (or no marker), drawn invisible. */
function wantedIcons(
  drawing: IconDrawing | undefined,
  height: number,
  token: Image,
  bandSet: BandSet,
  look: MarkerLook,
  held: boolean
): Piece {
  const baseColor = height ? markerBaseColor(height, bandSet, getStoredTheme()) : GROUND_COLOR;
  const color = getColorString(baseColor);
  const strokeColor = getIconStrokeColor(baseColor);
  const { position: side, distance: iconDistance } = look.tuning;
  const opacity = height ? look.tuning.opacity : 0;
  const commands = drawing && height ? drawing.commands : [];
  const strokeWidth = drawing && height ? drawing.strokeWidth : 0;
  const signature = JSON.stringify([
    commands,
    strokeWidth,
    color,
    side,
    iconDistance,
    opacity,
    dpi,
    token.scale,
    token.image.width,
    token.image.height,
    token.grid,
    token.visible,
    // Rebuilt once the drag it was drawn in is over, from where the token landed.
    held,
  ]);
  const style = (icons: Path) => {
    icons.commands = commands;
    icons.style.fillColor = color;
    icons.style.fillOpacity = opacity;
    icons.style.strokeColor = strokeColor;
    icons.style.strokeOpacity = MARKER_STROKE_OPACITY * opacity;
    icons.style.strokeWidth = strokeWidth;
    icons.visible = token.visible;
  };
  return {
    signature,
    apply: (item) => {
      if (isPath(item)) {
        style(item);
      }
    },
    build: () => {
      const icons = buildPath()
        .position(computeIconAnchor(token, dpi, side, iconDistance))
        .attachedTo(token.id)
        .layer("ATTACHMENT")
        .locked(true)
        .disableHit(true)
        .build();
      style(icons);
      icons.metadata[OVERLAY_KEY] = { tokenId: token.id };
      return icons;
    },
  };
}

// A raised token's shadow on the floor, a sunk one's light: as wide as its
// image, fainter the higher it is. On an axonometric grid a floor circle as
// wide as the token's footprint (getTokenRadius) is drawn only 1/√2 of its
// width — the cell's inscribed ellipse — which reads as too small a shadow.
// On hex (flat) it's a circle as wide as its image or its footprint set by
// hand — not its larger side, which for art drawn standing is its height.
const SHADOW_SCALE = Math.SQRT2;
const SHADOW_COLOR = "#000000";
const LIGHT_COLOR = "#ffffff";
const LIGHT_OPACITY = 0.4;
const TETHER_OPACITY = 0.8;
// They're drawn to the token's size and its lift on screen themselves:
// Owlbear scaling or turning them with the token (a resize) would stretch
// the line past it.
const FOLLOW_POSITION_ONLY: AttachmentBehavior[] = ["SCALE", "ROTATION"];

function shadowOpacity(lift: number): number {
  return lift > 0 ? 0.5 / (1 + (0.08 * lift) / dpi) : LIGHT_OPACITY;
}

/**
 * Under a token drawn raised or sunk (see lift.ts), on the floor where it
 * really is: its shadow, or its light. `lift` 0: drawn invisible.
 */
function wantedShadow(token: Image, lift: number, held: boolean): Piece {
  const footprint = getTokenFootprint(token);
  const radius = axonometry
    ? getTokenRadius(token, dpi, axonometry) * dpi * SHADOW_SCALE
    : footprint !== undefined
      ? (footprint * dpi) / 2
      : Math.abs(getTokenBounds(token, dpi).scaledWidth) / 2;
  const signature = JSON.stringify([lift, radius, axonometry, token.visible, held]);
  const style = (item: Item) => {
    if (isShape(item)) {
      item.style.fillColor = lift < 0 ? LIGHT_COLOR : SHADOW_COLOR;
      item.style.fillOpacity = lift ? shadowOpacity(lift) : 0;
      item.style.strokeOpacity = 0;
      item.visible = token.visible;
    }
  };
  return {
    signature,
    apply: style,
    build: () => {
      const { item } = buildFloorShape(token.position, radius, "circle", axonometry, {});
      // Under the tokens, like something on the floor.
      item.layer = "MOUNT";
      item.attachedTo = token.id;
      item.disableAttachmentBehavior = FOLLOW_POSITION_ONLY;
      item.locked = true;
      style(item);
      item.metadata[OVERLAY_KEY] = { tokenId: token.id };
      return item;
    },
  };
}

/** A line from where a raised (or sunk) token is on the floor to where it's drawn, in its height's color. */
function wantedTether(token: Image, lift: number, height: number, bandSet: BandSet, held: boolean): Piece {
  const color = getColorString(height ? markerBaseColor(height, bandSet, getStoredTheme()) : GROUND_COLOR);
  const signature = JSON.stringify([lift, color, token.visible, held]);
  const style = (item: Item) => {
    if (isPath(item)) {
      item.commands = [
        [Command.MOVE, 0, 0],
        [Command.LINE, 0, -lift],
      ];
      item.style.strokeColor = color;
      item.style.strokeOpacity = lift ? TETHER_OPACITY : 0;
      item.style.strokeWidth = 3;
      item.style.strokeDash = [8, 8];
      item.style.fillOpacity = 0;
      item.visible = token.visible;
    }
  };
  return {
    signature,
    apply: style,
    build: () => {
      const tether = buildPath()
        .position(token.position)
        .attachedTo(token.id)
        .disableAttachmentBehavior(FOLLOW_POSITION_ONLY)
        .layer("MOUNT")
        .zIndex(1)
        .locked(true)
        .disableHit(true)
        .build();
      style(tether);
      tether.metadata[OVERLAY_KEY] = { tokenId: token.id };
      return tether;
    },
  };
}

/**
 * A piece drawn around a token that may be raised (see lift.ts): only
 * carried along by its position, and rebuilt whenever the token moves or
 * turns rather than left to follow it. A token raised and resized or
 * turned by hand is put back where it stood (plannedLift), and the client
 * that did it doesn't carry what's attached to it along with the gesture,
 * only with the putting back — so whatever was there drifts off by as much
 * as the gesture moved it (it's right again on a reload).
 */
function onRaised(piece: Piece, token: Image): Piece {
  return {
    ...piece,
    signature: JSON.stringify([piece.signature, activeLift(token), token.position, token.rotation]),
    build: () => {
      const item = piece.build();
      item.disableAttachmentBehavior = FOLLOW_POSITION_ONLY;
      return item;
    },
  };
}

function computeWanted(): Map<string, Wanted> {
  const wanted = new Map<string, Wanted>();
  if (!sceneReady || !dpi || !gridScale) {
    return wanted;
  }
  const settings = globalSettingsFromMetadata(metadata);
  const look = markerLookFromMetadata(metadata);
  if (!(settings.enableAltitude ?? true)) {
    return wanted;
  }
  const bandSet = bandSetFromMetadata(metadata);
  const lifting = liftsTokens(settings, gridType);
  const fixed = fixedGround(settings);
  const terrain = fixed ? terrainZones(items) : [];
  const markers = new Map<string, Path>();
  for (const item of items) {
    if (isTokenHeightMarker(item) && item.attachedTo && !markers.has(item.attachedTo)) {
      markers.set(item.attachedTo, item);
    }
  }
  const now = Date.now();
  const seen = new Set<string>();
  let nextStale = Infinity;
  for (const token of items) {
    // Every token a height can be set on (see createTokenHeightMenu.ts), and
    // any other with a marker (moved to another layer since). A player never
    // sees a hidden token, so neither should its label.
    const marker = isImage(token) ? markers.get(token.id) : undefined;
    if (!isImage(token) || (token.layer !== "CHARACTER" && !marker) || (role !== "GM" && !token.visible)) {
      continue;
    }
    const own = (marker && getTokenHeight(marker, bandSet)) || 0;
    // Only while the token is still stored where the drag began: once it's
    // dropped (or moved any other way) the marker's drag is stale.
    const drag = marker && getMarkerDrag(marker);
    let midDrag = !!drag && drag.from.x === token.position.x && drag.from.y === token.position.y;
    if (marker && drag && midDrag) {
      const key = `${marker.id}:${JSON.stringify(drag)}`;
      seen.add(key);
      const since = dragSeen.get(key) ?? now;
      dragSeen.set(key, since);
      midDrag = now - since < STALE_DRAG_MS;
      if (midDrag) {
        nextStale = Math.min(nextStale, since + STALE_DRAG_MS);
      }
    }
    const live = dragged?.tokenId === token.id ? { tokenId: token.id, position: dragged.position } : undefined;
    const held = midDrag || !!live;
    const placed = live ? { ...token, position: live.position } : token;
    // Above its own ground, or above the fixed one, the terrain where it is
    // included (see GlobalSettings.groundLevel): then its icons are drawn
    // for that height rather than taken from its marker.
    const height = fixed ? own + terrainAt(terrain, placed.position) : own;
    const drawing =
      height === own
        ? marker && { commands: marker.commands, strokeWidth: marker.style.strokeWidth }
        : height
          ? markerAppearance(height, bandSet, dpi, look)
          : undefined;
    // Beside the token's image, raised or not (see lift.ts).
    const beside = asDrawn(placed);
    const raised = lifting && activeLift(placed) !== 0;
    const around = (piece: Piece) => (raised ? onRaised(piece, placed) : piece);
    const icons = look.style === "label" ? null : wantedIcons(drawing, height, beside, bandSet, look, held);
    if (icons) {
      wanted.set(`icon:${token.id}`, { ...around(icons), held, live });
    }
    const label = look.style === "icons" ? null : wantedLabel(drawing, height, beside, bandSet, gridScale, look, held);
    if (label) {
      wanted.set(`label:${token.id}`, { ...around(label), held, live });
    }
    if (lifting) {
      // What the token's image shows now (it's moved by the GM's client),
      // not its height: a token that couldn't be moved gets neither.
      const lift = activeLift(token);
      const floor = onFloor(placed);
      if (settings.isoShadow ?? true) {
        wanted.set(`shadow:${token.id}`, { ...around(wantedShadow(floor, lift, held)), held, live });
      }
      if (settings.isoTether ?? true) {
        // A sunk one's reaches its head, where its depth is (see sunkLift).
        const reach = lift < 0 ? Math.min(0, lift + Math.round(sunkHead(floor, dpi))) : lift;
        const tether = wantedTether(floor, reach, height, bandSet, held);
        wanted.set(`tether:${token.id}`, { ...around(tether), held, live });
      }
    }
  }
  for (const key of dragSeen.keys()) {
    if (!seen.has(key)) {
      dragSeen.delete(key);
    }
  }
  // Another pass once the oldest drag still held goes stale.
  if (staleTimer) {
    clearTimeout(staleTimer);
    staleTimer = null;
  }
  if (nextStale !== Infinity) {
    staleTimer = setTimeout(schedule, nextStale - now + 50);
  }
  return wanted;
}

async function reconcile() {
  if (resync) {
    resync = false;
    drawn.clear();
    const leftovers = await OBR.scene.local.getItems((item) => OVERLAY_KEY in item.metadata);
    if (leftovers.length > 0) {
      await OBR.scene.local.deleteItems(leftovers.map((item) => item.id));
    }
  }
  const wanted = computeWanted();
  const toDelete: string[] = [];
  const toAdd: Item[] = [];
  const toUpdate = new Map<string, (item: Item) => void>();
  for (const [key, current] of drawn) {
    const next = wanted.get(key);
    if (next && next.signature === current.signature) {
      continue;
    }
    if (next?.held) {
      toUpdate.set(current.id, next.apply);
      current.signature = next.signature;
      continue;
    }
    toDelete.push(current.id);
    drawn.delete(key);
  }
  for (const [key, next] of wanted) {
    if (drawn.has(key) || (next.held && !next.live)) {
      continue;
    }
    const item = next.build();
    let follow: Drawn["follow"];
    if (next.live) {
      // Not attached until the token is dropped: it's moved along by hand.
      item.attachedTo = undefined;
      const { tokenId, position } = next.live;
      follow = { tokenId, offset: { x: item.position.x - position.x, y: item.position.y - position.y } };
    }
    toAdd.push(item);
    drawn.set(key, { id: item.id, signature: next.signature, follow });
  }
  if (toUpdate.size > 0) {
    await OBR.scene.local.updateItems([...toUpdate.keys()], (drafts) => {
      for (const item of drafts) {
        toUpdate.get(item.id)?.(item);
      }
    });
  }
  // Added first: a rebuilt overlay replaces the old one without a gap.
  if (toAdd.length > 0) {
    await OBR.scene.local.addItems(toAdd);
  }
  if (toDelete.length > 0) {
    await OBR.scene.local.deleteItems(toDelete);
  }
}

/** The token this client is dragging is at `position` now; null once it's dropped and saved. */
export function setDraggedToken(tokenId: string, position: Vector2 | null) {
  if (position) {
    dragged = { tokenId, position };
    // What was built during this drag isn't attached: it's moved along by
    // hand. Absolute positions, so a lost update is made up for by the next.
    const offsets = new Map<string, Vector2>();
    for (const d of drawn.values()) {
      if (d.follow?.tokenId === tokenId) {
        offsets.set(d.id, d.follow.offset);
      }
    }
    if (offsets.size > 0 && sceneReady) {
      OBR.scene.local
        .updateItems([...offsets.keys()], (drafts) => {
          for (const item of drafts) {
            const offset = offsets.get(item.id);
            if (offset) {
              item.position = { x: position.x + offset.x, y: position.y + offset.y };
            }
          }
        })
        .catch((error) => console.error("Rising Ranges: failed to move a height marker", error));
    }
  } else if (dragged?.tokenId === tokenId) {
    dragged = null;
    // No longer held: what the drag touched is rebuilt where the token landed.
    schedule();
  }
}

/** Runs reconcile() once at a time; a change landing mid-run gets one more pass afterwards. */
function schedule() {
  dirty = true;
  if (running) {
    return;
  }
  running = true;
  (async () => {
    while (dirty) {
      dirty = false;
      try {
        await reconcile();
      } catch (error) {
        console.error("Rising Ranges: failed to draw height markers", error);
        resync = true;
      }
    }
    running = false;
  })();
}

async function loadScene() {
  const [nextMetadata, nextItems, nextDpi, nextScale, nextAxonometry, nextGridType] = await Promise.all([
    OBR.scene.getMetadata(),
    OBR.scene.items.getItems(),
    OBR.scene.grid.getDpi(),
    OBR.scene.grid.getScale(),
    getGridAxonometry(),
    OBR.scene.grid.getType(),
  ]);
  metadata = nextMetadata;
  items = nextItems;
  dpi = nextDpi;
  gridScale = nextScale;
  axonometry = nextAxonometry;
  gridType = nextGridType;
  sceneReady = true;
  resync = true;
  schedule();
}

export async function startHeightOverlays() {
  OBR.scene.onReadyChange((ready) => {
    if (ready) {
      loadScene().catch((error) => console.error("Rising Ranges: failed to load height markers", error));
    } else {
      // The scene's local items go with it.
      sceneReady = false;
      drawn.clear();
    }
  });
  OBR.scene.items.onChange((next) => {
    items = next;
    schedule();
  });
  OBR.scene.onMetadataChange((next) => {
    metadata = next;
    schedule();
  });
  OBR.scene.grid.onChange(async (grid) => {
    gridType = grid.type;
    [dpi, gridScale, axonometry] = await Promise.all([
      OBR.scene.grid.getDpi(),
      OBR.scene.grid.getScale(),
      axonometryOf(grid.type),
    ]);
    schedule();
  });
  OBR.player.onChange((player) => {
    if (player.role !== role) {
      role = player.role;
      schedule();
    }
  });
  // The color theme is picked on another page of this extension and only
  // stored in localStorage, which tells other same-origin pages it changed.
  window.addEventListener("storage", (event) => {
    if (event.key && THEME_STORAGE_KEYS.includes(event.key) && drawn.size > 0) {
      schedule();
    }
  });
  role = await OBR.player.getRole();
  if (await OBR.scene.isReady()) {
    await loadScene();
  }
}
