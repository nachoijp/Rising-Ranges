import OBR, {
  buildLabel,
  buildPath,
  Command,
  type GridScale,
  type GridType,
  type Item,
  type PathCommand,
} from "@owlbear-rodeo/sdk";
import type { MultiPolygon } from "polygon-clipping";
import polygonClipping from "../terrain/clip";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import {
  globalSettingsFromMetadata,
  resolveTerrainLook,
  terrainOn,
  terrainVisibility,
  type TerrainLook,
} from "../settings/globalSettings";
import { terrainItemsKey, terrainShapes, type RampSlope, type TerrainShape } from "../terrain/terrain";
import { terrainLayers } from "../terrain/terrainLayers";
import { onRelief, onReliefsChange, reliefShapes, reliefsVersion } from "../relief/live";
import { markerBaseColor, markerLookFromMetadata } from "../tokenHeight/markers";
import { followMap, LABEL_FONT_SIZE } from "../render/lecturaItems";
import { getStoredTheme, THEME_STORAGE_KEYS, type Color, type Theme } from "../theme/themes";
import { applyLabelTextStyle, getColorString } from "../util/color";
import { formatDistance } from "../util/flattenGridScale";
import { getPluginId } from "../util/getPluginId";
import { getGridType } from "../util/gridAxonometry";

// The terrain drawn as stacked cut paper (GlobalSettings.terrainLook,
// style "layers"): what of each zone shows filled in a color for its height,
// lowest first, each casting a shadow on what's lower (see terrainLayers.ts).
// Owlbear can't show an image made here (an image item's URL is limited to
// 2048 characters), so it's drawn with paths.
//
// Client-local, on every client, in its own color theme, and only where
// the terrain's visibility lets this client see it (terrainVisibility):
// nobody, the GM, or everyone. Redrawn when the zones or the look change.
//
// A map image with a relief (made in the Vistazo, see relief/live.ts) has
// its shapes drawn instead of the zones on it, in either look: they aren't
// items of the scene, so their outlines are drawn here too. They follow
// the image when it's dragged.

const ITEM_KEY = getPluginId("terrainView");
/** How far a layer's shadow falls, in cells. */
const SHADOW_CELLS = 0.15;
/** How dark a shadow is at full strength. */
const SHADOW_OPACITY = 0.6;
/** Ground level, and every height when "grey": a neutral lightness range. */
const GREY_LOW = 70;
const GREY_HIGH = 235;
/** Waits this long after a change before redrawing: a drag moves a zone many times. */
const REDRAW_DELAY_MS = 120;

let metadata: Record<string, unknown> = {};
let items: Item[] = [];
let gridType: GridType = "SQUARE";
let dpi = 0;
let gridScale: GridScale | null = null;
let role: "GM" | "PLAYER" = "PLAYER";
let sceneReady = false;
let drawn: string[] = [];
let drawnSignature = "";
/** What the last drawing was worked out from (see redraw): the same, nothing to work out again. */
let wantedKey = "";
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let dirty = false;

const translate = (shape: MultiPolygon, dx: number, dy: number): MultiPolygon =>
  shape.map((polygon) => polygon.map((ring) => ring.map(([x, y]) => [x + dx, y + dy] as [number, number])));

/** A shape as path commands, in scene coordinates (the path at the origin), even-odd so holes stay holes. */
function commandsOf(shape: MultiPolygon): PathCommand[] {
  const commands: PathCommand[] = [];
  for (const polygon of shape) {
    for (const ring of polygon) {
      if (ring.length < 3) {
        continue;
      }
      commands.push([Command.MOVE, ring[0][0], ring[0][1]]);
      for (const [x, y] of ring.slice(1)) {
        commands.push([Command.LINE, x, y]);
      }
      commands.push([Command.CLOSE]);
    }
  }
  return commands;
}

/** How many bands a ramp is painted in: one more than the cells it climbs, 3 to 8. */
function rampBands(slope: RampSlope, height: number): number {
  return Math.max(3, Math.min(8, Math.round(Math.abs(height - slope.low)) + 1));
}

/** The part of a ramp from a to b of the way up it (0 to 1), cut from `shape`. */
function band(shape: MultiPolygon, slope: RampSlope, a: number, b: number): MultiPolygon {
  const { origin, axis } = slope;
  const length = Math.hypot(axis.x, axis.y) || 1;
  // Far enough across to take the whole ramp in.
  const reach = 1e6;
  const px = (-axis.y / length) * reach;
  const py = (axis.x / length) * reach;
  const at = (t: number, side: number): [number, number] => [origin.x + axis.x * t + px * side, origin.y + axis.y * t + py * side];
  const strip: MultiPolygon = [[[at(a, -1), at(b, -1), at(b, 1), at(a, 1), at(a, -1)]]];
  return polygonClipping.intersection(shape, strip);
}

/** An arrow up a ramp, in its middle. */
function rampArrow(slope: RampSlope, cell: number): PathCommand[] {
  const { origin, axis } = slope;
  const length = Math.hypot(axis.x, axis.y) || 1;
  const dx = axis.x / length;
  const dy = axis.y / length;
  const size = Math.min(length * 0.4, cell * 0.8);
  const cx = origin.x + axis.x / 2;
  const cy = origin.y + axis.y / 2;
  const point = (along: number, across: number): [number, number] => [cx + dx * along - dy * across, cy + dy * along + dx * across];
  const outline = [point(size / 2, 0), point(0, size * 0.45), point(0, size * 0.18), point(-size / 2, size * 0.18), point(-size / 2, -size * 0.18), point(0, -size * 0.18), point(0, -size * 0.45)];
  return commandsOf([[[...outline, outline[0]]]]);
}

/** A layer's color: lighter the higher (grey), or a height marker's color for its height. */
function layerColor(height: number, look: TerrainLook, range: [number, number], theme: Theme): Color {
  if (look.color === "height" && height !== 0) {
    return markerBaseColor(height, bandSetFromMetadata(metadata), theme);
  }
  const [low, high] = range;
  const t = high === low ? 0.5 : (height - low) / (high - low);
  const v = Math.round(GREY_LOW + t * (GREY_HIGH - GREY_LOW));
  return { r: v, g: v, b: Math.min(255, v + 8) };
}

/**
 * Drawn pieces follow their zone while it's dragged (Owlbear only reports
 * the move on the drop, but carries what's attached along): by position
 * only — they're drawn in scene coordinates, already turned and scaled —
 * and not hidden with it ("GM only" hides the zone itself).
 */
const FOLLOW_POSITION_ONLY: Item["disableAttachmentBehavior"] = ["ROTATION", "SCALE", "VISIBLE", "LOCKED", "COPY"];

/** A relief's shapes follow its map image (see wanted). */
let follows = new Map<string, string>();

function attach<T extends Item>(item: T, zoneId: string | undefined): T {
  if (zoneId) {
    item.attachedTo = follows.get(zoneId) ?? zoneId;
    item.disableAttachmentBehavior = FOLLOW_POSITION_ONLY;
  }
  return item;
}

function path(commands: PathCommand[], fill: string, fillOpacity: number, zIndex: number): Item {
  const item = buildPath()
    .commands(commands)
    .fillRule("evenodd")
    .fillColor(fill)
    .fillOpacity(fillOpacity)
    .strokeOpacity(0)
    .strokeWidth(0)
    .position({ x: 0, y: 0 })
    .layer("DRAWING")
    .zIndex(zIndex)
    .locked(true)
    .disableHit(true)
    .build();
  item.metadata[ITEM_KEY] = true;
  return item;
}

/** Everything to draw now, and a signature of it (so nothing is redrawn when nothing changed). */
function wanted(): { items: Item[]; signature: string } {
  const settings = globalSettingsFromMetadata(metadata);
  const look = resolveTerrainLook(settings);
  const mode = terrainVisibility(settings);
  const seen = mode === "everyone" || (mode === "gm" && role === "GM");
  if (!sceneReady || !dpi || !terrainOn(settings, gridType) || !seen) {
    return { items: [], signature: "" };
  }
  const relief = reliefShapes();
  follows = new Map(relief.map((shape) => [shape.id, shape.follow]));
  // Outlined, the zones are drawn by being styled themselves (terrainStyle.ts): only the reliefs' here.
  const layered = look.style === "layers";
  if (!layered && relief.length === 0) {
    return { items: [], signature: "" };
  }
  const shapes = layered ? [...relief, ...terrainShapes(items).filter((shape) => !onRelief({ x: shape.rings[0][0][0], y: shape.rings[0][0][1] }))] : relief;
  if (shapes.length === 0) {
    return { items: [], signature: "" };
  }
  const theme = getStoredTheme();
  const heights = shapes.flatMap((shape) => [shape.height, shape.slope?.low ?? shape.height]);
  const slopes = new Map(shapes.filter((shape) => shape.slope).map((shape) => [shape.id, shape.slope as RampSlope]));
  const range: [number, number] = [Math.min(0, ...heights), Math.max(0, ...heights)];
  const offset = dpi * SHADOW_CELLS;
  const shadowOpacity = (look.shadow / 100) * SHADOW_OPACITY;
  const fillOpacity = look.opacity / 100;
  const out: Item[] = [];
  let z = 0;
  const layers = layered ? terrainLayers(shapes) : [];
  // Each height's layers together: a layer's shadow doesn't fall on another at its height.
  const atHeight = new Map<number, MultiPolygon>();
  for (const layer of layers.filter((l) => !l.rim)) {
    const same = atHeight.get(layer.height);
    atHeight.set(layer.height, same ? polygonClipping.union(same, layer.shape) : layer.shape);
  }
  for (const layer of layers) {
    const moved = translate(layer.shape, offset, offset);
    if (layer.rim) {
      // The bare ground's rim, inside the pits: they minus every zone moved away from the light.
      const rim = polygonClipping.difference(layer.shape, translate(layer.cover ?? layer.shape, offset, offset));
      if (shadowOpacity > 0 && rim.length > 0) {
        out.push(path(commandsOf(rim), "#000000", shadowOpacity, z++));
      }
      continue;
    }
    if (shadowOpacity > 0) {
      // Only where it falls outside the layer itself: under its own see-through fill it would
      // darken all but the edge facing the light.
      const shadow = polygonClipping.difference(moved, atHeight.get(layer.height) ?? layer.shape);
      if (shadow.length > 0) {
        out.push(attach(path(commandsOf(shadow), "#000000", shadowOpacity, z++), layer.zoneId));
      }
    }
    const slope = layer.zoneId ? slopes.get(layer.zoneId) : undefined;
    if (!slope) {
      out.push(
        attach(path(commandsOf(layer.shape), getColorString(layerColor(layer.height, look, range, theme)), fillOpacity, z++), layer.zoneId)
      );
      continue;
    }
    // A ramp: bands from its low end's colour to its high end's, and an arrow up it.
    const count = rampBands(slope, layer.height);
    for (let i = 0; i < count; i++) {
      // The first and last reach past the ends, so nothing at the edges is left out.
      const piece = band(layer.shape, slope, i === 0 ? -1 : i / count, i === count - 1 ? 2 : (i + 1) / count);
      if (piece.length > 0) {
        const height = slope.low + ((layer.height - slope.low) * (i + 0.5)) / count;
        out.push(attach(path(commandsOf(piece), getColorString(layerColor(height, look, range, theme)), fillOpacity, z++), layer.zoneId));
      }
    }
    out.push(attach(path(rampArrow(slope, dpi), "#000000", 0.35, z++), layer.zoneId));
  }
  if (look.outline || !layered) {
    for (const shape of shapes) {
      const color = getColorString(layerColor(shape.height, { ...look, color: "height" }, range, theme));
      const outline = path(commandsOf(shape.rings.map((ring) => [ring])), "#000000", 0, z++);
      if (outline.type === "PATH") {
        Object.assign((outline as Item & { style: Record<string, unknown> }).style, {
          strokeColor: color,
          strokeOpacity: 0.95,
          strokeWidth: 2,
        });
      }
      out.push(attach(outline, shape.id));
    }
  }
  if (look.labels && gridScale) {
    const labelSize = markerLookFromMetadata(metadata).tuning.size;
    for (const shape of shapes) {
      const color = layerColor(shape.height, { ...look, color: "height" }, range, theme);
      out.push(attach(label(shape, gridScale, color, labelSize, z++), shape.id));
    }
  }
  const signature = JSON.stringify(out.map((item) => [(item as unknown as { commands?: unknown }).commands, item.attachedTo, item.metadata, item.zIndex, JSON.stringify((item as unknown as { style?: unknown }).style), JSON.stringify((item as unknown as { text?: unknown }).text), item.position]));
  return { items: out, signature };
}

/**
 * A zone's height written on it, centered on the topmost point of its
 * outline (on the edge itself, wherever the shape is lopsided). Lettered
 * like a token's height label (see heightOverlays.ts): same size setting,
 * outline and growing with the map as it's zoomed.
 */
function label(shape: TerrainShape, scale: GridScale, color: Color, size: number, zIndex: number): Item {
  const points = shape.rings.flat();
  const top = points.reduce((best, p) => (p[1] < best[1] ? p : best), points[0]);
  // A ramp says where it goes from and to.
  const text = shape.slope
    ? `${formatDistance(scale, shape.slope.low)} → ${formatDistance(scale, shape.height)}`
    : `${shape.height > 0 ? "▲" : shape.height < 0 ? "▼" : ""} ${formatDistance(scale, Math.abs(shape.height))}`.trim();
  const item = buildLabel()
    .plainText(text)
    .position({ x: top[0], y: top[1] })
    .pointerHeight(0)
    .fontSize(LABEL_FONT_SIZE * size)
    .padding(4 * size)
    .cornerRadius(12 * size)
    .backgroundColor(getColorString(color))
    .backgroundOpacity(0.85)
    .layer("DRAWING")
    .zIndex(zIndex)
    .locked(true)
    .disableHit(true)
    .build();
  applyLabelTextStyle(item, color, 1);
  item.metadata[ITEM_KEY] = true;
  return followMap(item);
}

async function redraw() {
  // Everything the drawing depends on, cheaply: a token moving (most changes of the items) changes none
  // of it, and the layers' unions and differences aren't done again. With what's drawn in it, so a reset
  // (a new scene) draws again.
  const key = JSON.stringify([
    drawnSignature,
    sceneReady,
    role,
    dpi,
    gridType,
    gridScale?.raw,
    terrainItemsKey(items),
    reliefsVersion(),
    JSON.stringify(globalSettingsFromMetadata(metadata)),
    JSON.stringify(markerLookFromMetadata(metadata)),
    JSON.stringify(bandSetFromMetadata(metadata)),
    JSON.stringify(getStoredTheme()),
  ]);
  if (key === wantedKey) {
    return;
  }
  const next = wanted();
  if (next.signature === drawnSignature) {
    wantedKey = key;
    return;
  }
  const old = drawn;
  // Added first, so the old ones go without a gap.
  if (next.items.length > 0) {
    await OBR.scene.local.addItems(next.items);
  }
  drawn = next.items.map((item) => item.id);
  drawnSignature = next.signature;
  if (old.length > 0) {
    await OBR.scene.local.deleteItems(old);
  }
  // Only once it's drawn: if anything above failed, the same state is tried again on the next change.
  wantedKey = key;
}

/** Redraws a moment after the last change; one pass at a time. */
function schedule() {
  if (timer) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    timer = null;
    dirty = true;
    if (running) {
      return;
    }
    running = true;
    (async () => {
      while (dirty) {
        dirty = false;
        try {
          await redraw();
        } catch (error) {
          console.error("Rising Ranges: failed to draw the terrain", error);
        }
      }
      running = false;
    })();
  }, REDRAW_DELAY_MS);
}

async function loadScene() {
  const [nextMetadata, nextItems, nextGridType, nextDpi, nextScale] = await Promise.all([
    OBR.scene.getMetadata(),
    OBR.scene.items.getItems(),
    getGridType(),
    OBR.scene.grid.getDpi(),
    OBR.scene.grid.getScale(),
  ]);
  metadata = nextMetadata;
  items = nextItems;
  gridType = nextGridType;
  dpi = nextDpi;
  gridScale = nextScale;
  sceneReady = true;
  // Anything left from before (a reload keeps the scene's local items).
  const leftover = await OBR.scene.local.getItems((item) => item.metadata[ITEM_KEY] === true);
  if (leftover.length > 0) {
    await OBR.scene.local.deleteItems(leftover.map((item) => item.id));
  }
  drawn = [];
  drawnSignature = "";
  schedule();
}

export async function startTerrainView() {
  OBR.scene.onReadyChange((ready) => {
    sceneReady = false;
    drawn = [];
    drawnSignature = "";
    if (ready) {
      loadScene().catch((error) => console.error("Rising Ranges: failed to load the terrain", error));
    }
  });
  OBR.scene.items.onChange((next) => {
    items = next;
    schedule();
  });
  onReliefsChange(schedule);
  OBR.scene.onMetadataChange((next) => {
    metadata = next;
    schedule();
  });
  OBR.scene.grid.onChange(async (grid) => {
    gridType = grid.type;
    [dpi, gridScale] = await Promise.all([OBR.scene.grid.getDpi(), OBR.scene.grid.getScale()]);
    schedule();
  });
  OBR.player.onChange((player) => {
    if (player.role !== role) {
      role = player.role;
      schedule();
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key && THEME_STORAGE_KEYS.includes(event.key)) {
      schedule();
    }
  });
  role = await OBR.player.getRole();
  if (await OBR.scene.isReady()) {
    await loadScene();
  }
}
