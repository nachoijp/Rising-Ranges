import OBR, {
  buildLabel,
  buildPath,
  Command,
  type GridScale,
  type GridType,
  type Item,
  type PathCommand,
} from "@owlbear-rodeo/sdk";
import polygonClipping, { type MultiPolygon } from "polygon-clipping";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import {
  globalSettingsFromMetadata,
  resolveTerrainLook,
  terrainOn,
  terrainVisibility,
  type TerrainLook,
} from "../settings/globalSettings";
import { terrainShapes, type TerrainShape } from "../terrain/terrain";
import { terrainLayers } from "../terrain/terrainLayers";
import { markerBaseColor } from "../tokenHeight/markers";
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

function attach<T extends Item>(item: T, zoneId: string | undefined): T {
  if (zoneId) {
    item.attachedTo = zoneId;
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
  if (!sceneReady || !dpi || !terrainOn(settings, gridType) || look.style !== "layers" || !seen) {
    return { items: [], signature: "" };
  }
  const shapes = terrainShapes(items);
  if (shapes.length === 0) {
    return { items: [], signature: "" };
  }
  const theme = getStoredTheme();
  const heights = shapes.map((shape) => shape.height);
  const range: [number, number] = [Math.min(0, ...heights), Math.max(0, ...heights)];
  const offset = dpi * SHADOW_CELLS;
  const shadowOpacity = (look.shadow / 100) * SHADOW_OPACITY;
  const fillOpacity = look.opacity / 100;
  const out: Item[] = [];
  let z = 0;
  const layers = terrainLayers(shapes);
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
    out.push(
      attach(path(commandsOf(layer.shape), getColorString(layerColor(layer.height, look, range, theme)), fillOpacity, z++), layer.zoneId)
    );
  }
  if (look.outline) {
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
    for (const shape of shapes) {
      out.push(attach(label(shape, gridScale, layerColor(shape.height, { ...look, color: "height" }, range, theme), z++), shape.id));
    }
  }
  const signature = JSON.stringify(out.map((item) => [(item as unknown as { commands?: unknown }).commands, item.attachedTo, item.metadata, item.zIndex, JSON.stringify((item as unknown as { style?: unknown }).style), (item as unknown as { text?: { plainText?: string } }).text?.plainText, item.position]));
  return { items: out, signature };
}

/** A zone's height written on it, at the top of its outline. */
function label(shape: TerrainShape, scale: GridScale, color: Color, zIndex: number): Item {
  const points = shape.rings.flat();
  const top = points.reduce((best, p) => (p[1] < best[1] ? p : best), points[0]);
  const centerX = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const text = `${shape.height > 0 ? "▲" : shape.height < 0 ? "▼" : ""} ${formatDistance(scale, Math.abs(shape.height))}`.trim();
  const item = buildLabel()
    .plainText(text)
    .position({ x: centerX, y: top[1] + dpi * 0.35 })
    .pointerHeight(0)
    .backgroundColor(getColorString(color))
    .backgroundOpacity(0.85)
    .layer("DRAWING")
    .zIndex(zIndex)
    .locked(true)
    .disableHit(true)
    .build();
  applyLabelTextStyle(item, color, 1);
  item.metadata[ITEM_KEY] = true;
  return item;
}

async function redraw() {
  const next = wanted();
  if (next.signature === drawnSignature) {
    return;
  }
  const old = drawn;
  drawn = next.items.map((item) => item.id);
  drawnSignature = next.signature;
  // Added first, so the old ones go without a gap.
  if (next.items.length > 0) {
    await OBR.scene.local.addItems(next.items);
  }
  if (old.length > 0) {
    await OBR.scene.local.deleteItems(old);
  }
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
