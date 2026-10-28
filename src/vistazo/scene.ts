import { isImage, type GridScale, type GridType, type Image, type Item } from "@owlbear-rodeo/sdk";
import type { MultiPolygon, Pair } from "polygon-clipping";
import polygonClipping from "../terrain/clip";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import { onGrid } from "../engine/hex";
import { tokenName } from "../distances/rows";
import { getVistazoBase, type VistazoBase } from "../tokenHeight/footprint";
import { globalSettingsFromMetadata, terrainOn } from "../settings/globalSettings";
import { itemOutline, type BridgeFrame, type TerrainSkin, type TerrainWallStyle } from "../terrain/terrain";
import { weatherOf, type Weather } from "./weather";
import { isTokenHeightMarker, tokenHeightsFromMarkers } from "../tokenHeight/markers";
import { onFloor } from "../tokenHeight/lift";
import { getTokenRadius } from "../render/iconAnchor";
import { anchorOf } from "../relief/anchor";
import type { Relief } from "../relief/relief";
import type { UnderLook } from "../relief/types";
import { reliefTerrain } from "../relief/vistazo";
import { time } from "../timing";

// What the Vistazo draws, read from the scene: the map images where they
// lie, the terrain as non-overlapping pieces (from each map image's relief,
// see relief/vistazo.ts), and the tokens with their height above the
// ground and the terrain under them. All in scene px; heights in grid units.

/** An image of the Map layer: drawn as an <img> of its own size under `transform`; `video`: an animated one (webm and the like), drawn with a video element. */
export type MapImage = { url: string; video: boolean; width: number; height: number; transform: string; corners: Pair[] };

/** Whether an image item is a video (Owlbear takes webm and the like as images). */
const isVideo = (item: Image) => item.image.mime.startsWith("video");

/** The edge a standing shape turns up on (the way its front faces most). */
export type StandEdge = "top" | "bottom" | "left" | "right";

/** A piece of terrain at its height (see relief/vistazo.ts). */
export type Piece = {
  height: number;
  shape: MultiPolygon;
  /** A standing shape: drawn as a block with its picture (`card`) in front, facing this way most. */
  stand?: StandEdge;
  /** Its shape's own wall style, if it has one. */
  walls?: TerrainWallStyle;
  /** Its walls' picture from a part of the map, if its shape has one. */
  skin?: TerrainSkin;
  /** Water over it, cells deep. */
  water?: number;
  /** Its surface, where it isn't flat: its height at a scene point. */
  surface?: (point: { x: number; y: number }) => number;
  /**
   * With a surface, but flat now (being edited: every piece has one, see
   * Reliefs.surfaced): drawn by its outline alone, not cut small, until
   * `fine` says its heights vary inside it (painted on, a soft edge over it).
   */
  coarse?: boolean;
  fine?: () => boolean;
  /** The relief's shape it's of (its index), for moving it whole while it's dragged (see VistazoView.moveShapes). */
  si?: number;
  /**
   * A standing shape's picture, made by the relief: [x, y, height, mapX,
   * mapY] triangles (scene px, grid units, where on the map each corner's
   * picture is), in front of its walls (none taken away).
   */
  card?: [number, number, number, number, number][];
};

/** How high a piece is at a scene point. */
export function pieceHeight(piece: Piece, x: number, y: number): number {
  return piece.surface ? piece.surface({ x, y }) : piece.height;
}

export type Token = {
  id: string;
  name: string;
  url: string;
  /** An animated image (webm), drawn with a video element. */
  video: boolean;
  x: number;
  y: number;
  /** Its image's size across, in scene px. */
  size: number;
  /** Half its footprint, scene px: as it's measured (set by hand, or from its image; see getTokenRadius). */
  radius: number;
  /** The terrain it stands on, and its own height above that, in grid units. */
  terrain: number;
  own: number;
  /** Its own turn (degrees) and whether it's flipped, to draw its image as on the map. */
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  /** Hidden from the players (the GM sees it anyway). */
  hidden: boolean;
  /** The item itself, for the distance math (computeDistanceRows). */
  item: Image;
  /** Where its picture touches the ground standing, if set by hand (see getVistazoBase). */
  base?: VistazoBase;
  /** Raised to a bridge's top over where it is: it stands on it (drawn so, not flying); that top, grid units. */
  bridge?: number;
};

/** An image of the Props layer, where it lies, to draw flat on the ground or standing; `own`: its height above the terrain, set like a token's (the Elevation menu works on props too). */
export type Prop = {
  id: string;
  name: string;
  url: string;
  video: boolean;
  x: number;
  y: number;
  size: number;
  width: number;
  height: number;
  transform: string;
  /** Its picture's corners on the map, scene px (where a click picks it lying flat). */
  corners: Pair[];
  rotation: number;
  terrain: number;
  own: number;
  item: Image;
  base?: VistazoBase;
  /** Half its footprint, scene px, as a token's (the Elevation menu's footprint works on props too). */
  radius: number;
};

/** A Props-layer image as the Vistazo draws it: where it is, the terrain under it and its own height. */
export function propOf(item: Image, dpi: number, measuredAt: (x: number, y: number) => number, own: number): Prop {
  const [x, y] = imageToScene(item, dpi, item.image.width / 2, item.image.height / 2);
  const k = dpi / item.grid.dpi;
  const map = mapImage(item, dpi);
  return {
    id: item.id,
    name: tokenName(item),
    url: item.image.url,
    video: isVideo(item),
    x,
    y,
    size: Math.max(item.image.width * Math.abs(item.scale.x), item.image.height * Math.abs(item.scale.y)) * k,
    width: item.image.width,
    height: item.image.height,
    transform: map.transform,
    corners: map.corners,
    rotation: item.rotation,
    terrain: measuredAt(x, y),
    own,
    item,
    base: getVistazoBase(item),
    radius: getTokenRadius(item, dpi, 0) * dpi,
  };
}

/** The part of the scene that only changes with the map and the terrain, kept while only tokens move. */
type Terrain = {
  /** What it was built from: the same key, the same terrain. */
  terrainKey: string;
  maps: MapImage[];
  /** Where the map is: the map images' outlines, or a box around everything when there's none. */
  world: MultiPolygon;
  bounds: { x0: number; y0: number; x1: number; y1: number };
  pieces: Piece[];
  /** Height at a scene point as drawn (the ground is 0; outside `world`, undefined). */
  heightAt: (x: number, y: number) => number | undefined;
  /** The piece at a scene point, if it's on the map. */
  pieceAt: (x: number, y: number) => Piece | undefined;
  /** Height at a scene point as measured. */
  measuredAt: (x: number, y: number) => number;
  /** Terrain is off for this scene (turned off, heights off, or an axonometric grid). */
  terrainOff: boolean;
  /** Bridges and balconies: slabs floating over the ground (not ground themselves). */
  bridges: Bridge[];
  /** Outlines (scene px) of what keeps its look under slabs: their fill isn't painted there. */
  unfilled?: MultiPolygon[];
};

/** A bridge or balcony drawn: its outline (scene px), top and underside (grid units), its wall style. */
/**
 * A slab over the terrain: its top and underside (grid units) as its middle
 * has them; one that isn't flat (a ramp, inclined, stairs, painted) its top
 * at each scene point too (`surface`), its underside as far under it.
 */
export type Bridge = { id: string; shape: MultiPolygon; top: number; bottom: number; surface?: (point: { x: number; y: number }) => number; walls?: TerrainWallStyle; skin?: TerrainSkin; frame: BridgeFrame; si?: number; under?: UnderLook };

/** A bridge's top at a scene point (its own height there, if it isn't flat). */
export const bridgeTop = (bridge: Bridge, x: number, y: number) => (bridge.surface ? bridge.surface({ x, y }) : bridge.top);

/** A bridge's highest top (at its corners, if it isn't flat). */
export const bridgeHighest = (bridge: Bridge) => (bridge.surface ? Math.max(bridge.top, ...bridge.shape.flat(2).map(([x, y]) => bridgeTop(bridge, x, y))) : bridge.top);

/**
 * The player view's sight: what of the map the fog leaves clear (worked out
 * from the map's outline), and a key that changes with it. Under the fog the
 * terrain is flat ground: its heights would give away what's there.
 */
export type Sight = { key: string; clear: (world: MultiPolygon) => MultiPolygon | null };

export type VistazoScene = Terrain & {
  dpi: number;
  scale: GridScale;
  /** The grid is square: its cells can be drawn on the ground. */
  squareGrid: boolean;
  /** A hex grid: its orientation and one cell's center (for drawing its cells on the ground). */
  hexGrid: { shape: "hexHorizontal" | "hexVertical"; center: { x: number; y: number } } | null;
  tokens: Token[];
  props: Prop[];
  /** Each token's height above the ground, terrain under it included (as the Distancias panel has it). */
  heights: Map<string, number>;
  /** The Weather extension's weather on the scene's items (see weather.ts). */
  weather: Weather[];
};

/** Where an image's own pixel (u, v) lies in the scene: position + R(rotation)·(scale·k·(p − offset)), k = scene dpi / image dpi. */
function imageToScene(item: Image, dpi: number, u: number, v: number): Pair {
  const k = dpi / item.grid.dpi;
  const x = (u - item.grid.offset.x) * item.scale.x * k;
  const y = (v - item.grid.offset.y) * item.scale.y * k;
  const angle = (item.rotation * Math.PI) / 180;
  return [
    item.position.x + x * Math.cos(angle) - y * Math.sin(angle),
    item.position.y + x * Math.sin(angle) + y * Math.cos(angle),
  ];
}

function mapImage(item: Image, dpi: number): MapImage {
  const k = dpi / item.grid.dpi;
  const { width, height } = item.image;
  return {
    url: item.image.url,
    video: isVideo(item),
    width,
    height,
    transform:
      `translate(${item.position.x}px,${item.position.y}px) rotate(${item.rotation}deg) ` +
      `scale(${item.scale.x * k},${item.scale.y * k}) translate(${-item.grid.offset.x}px,${-item.grid.offset.y}px)`,
    corners: [
      imageToScene(item, dpi, 0, 0),
      imageToScene(item, dpi, width, 0),
      imageToScene(item, dpi, width, height),
      imageToScene(item, dpi, 0, height),
    ],
  };
}

function inRing(x: number, y: number, ring: Pair[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function inShape(x: number, y: number, shape: MultiPolygon): boolean {
  return shape.some((polygon) => inRing(x, y, polygon[0]) && !polygon.slice(1).some((hole) => inRing(x, y, hole)));
}

function closed(ring: Pair[]): Pair[] {
  return [...ring, ring[0]];
}

/** What the terrain is built from: the map images (where they are), the tokens when there's none to size it, the reliefs. */
function terrainKeyOf(items: Item[], tokenItems: Image[], dpi: number, terrainOff: boolean, sight: Sight | null, reliefKey: string): string {
  const images = items.filter((item): item is Image => isImage(item) && item.layer === "MAP");
  const sized = images.some((item) => item.visible) ? [] : tokenItems.map((token) => token.position);
  const mapItems = images.map((item) => [item.id, item.position, item.rotation, item.scale, item.visible, item.zIndex, item.image, item.grid]);
  return JSON.stringify([dpi, terrainOff, mapItems, sized, sight?.key ?? null, reliefKey]);
}

/**
 * The scene as the Vistazo draws it. With `previous`, its terrain is kept
 * when nothing it's built from changed: only the tokens are read again.
 */
export function buildScene(
  metadata: Record<string, unknown>,
  items: Item[],
  dpi: number,
  scale: GridScale,
  gridType: GridType,
  previous?: VistazoScene,
  hexCenter: { x: number; y: number } | null = null,
  playerView = false,
  sight: Sight | null = null,
  reliefs: Reliefs = { byImage: new Map(), key: "" }
): VistazoScene {
  const settings = globalSettingsFromMetadata(metadata);
  const terrainOff = !terrainOn(settings, gridType);
  const altitude = settings.enableAltitude ?? true;
  // Characters, and mounts with them (a horse is a creature too).
  const tokenItems = items.filter((item): item is Image => isImage(item) && (item.layer === "CHARACTER" || item.layer === "MOUNT"));
  const key = terrainKeyOf(items, tokenItems, dpi, terrainOff, sight, `${reliefs.key}${reliefs.surfaced ? "+surfaced" : ""}`);
  const terrain = previous && previous.terrainKey === key ? previous : buildTerrain(key, items, tokenItems, dpi, terrainOff, sight, reliefs.byImage, !!reliefs.surfaced);
  const { measuredAt } = terrain;

  const bandSet = onGrid(bandSetFromMetadata(metadata), gridType);
  const own = altitude ? tokenHeightsFromMarkers(items.filter(isTokenHeightMarker), bandSet) : new Map<string, number>();
  const heights = new Map<string, number>();
  const tokens: Token[] = tokenItems.map((item) => {
    const floor = onFloor(item);
    const [x, y] = imageToScene(floor, dpi, floor.image.width / 2, floor.image.height / 2);
    const k = dpi / floor.grid.dpi;
    const token: Token = {
      id: item.id,
      name: tokenName(item),
      url: item.image.url,
      video: isVideo(item),
      x,
      y,
      size: Math.max(floor.image.width * Math.abs(floor.scale.x), floor.image.height * Math.abs(floor.scale.y)) * k,
      radius: getTokenRadius(floor, dpi, 0) * dpi,
      terrain: measuredAt(x, y),
      own: own.get(item.id) ?? 0,
      rotation: item.rotation,
      flipX: item.scale.x < 0,
      flipY: item.scale.y < 0,
      hidden: !item.visible,
      item,
      base: getVistazoBase(item),
    };
    // Raised exactly to a bridge's top over it: standing on the bridge.
    const total = token.terrain + token.own;
    const bridge = token.own > 0 ? terrain.bridges.find((b) => Math.abs(bridgeTop(b, x, y) - total) < 1e-3 && inShape(x, y, b.shape)) : undefined;
    if (bridge) {
      token.bridge = bridgeTop(bridge, x, y);
    }
    heights.set(item.id, total);
    return token;
  });

  const props: Prop[] = items
    .filter((item): item is Image => isImage(item) && item.layer === "PROP" && item.visible)
    .sort((a, b) => a.zIndex - b.zIndex)
    .map((item) => propOf(item, dpi, measuredAt, own.get(item.id) ?? 0));

  return {
    terrainKey: terrain.terrainKey,
    maps: terrain.maps,
    world: terrain.world,
    bounds: terrain.bounds,
    pieces: terrain.pieces,
    heightAt: terrain.heightAt,
    pieceAt: terrain.pieceAt,
    measuredAt,
    terrainOff: terrain.terrainOff,
    bridges: terrain.bridges,
    unfilled: terrain.unfilled,
    dpi,
    scale,
    squareGrid: gridType === "SQUARE",
    hexGrid:
      hexCenter && (gridType === "HEX_HORIZONTAL" || gridType === "HEX_VERTICAL")
        ? { shape: gridType === "HEX_HORIZONTAL" ? "hexHorizontal" : "hexVertical", center: hexCenter }
        : null,
    tokens,
    props,
    heights,
    // Hidden from the players, its weather is too.
    weather: items
      .filter((item) => item.visible || !playerView)
      .map((item) => weatherOf(item, isImage(item) ? mapImage(item, dpi).corners : itemOutline(item).flat()))
      .filter((weather): weather is Weather => weather !== null),
  };
}

/** The reliefs the Vistazo draws: each map image's (by id), and a key that changes with any of them. */
export type Reliefs = {
  byImage: Map<string, Relief>;
  key: string;
  /** Being edited: every piece with its surface (see reliefTerrain). */
  surfaced?: boolean;
};

/**
 * The scene's terrain: the map images' reliefs (see relief/vistazo.ts),
 * each one's pieces and bridges over its image, and the rest of the map
 * plain ground at 0. With no map image, ground in a box round the tokens.
 */
function buildTerrain(
  terrainKey: string,
  items: Item[],
  tokenItems: Image[],
  dpi: number,
  terrainOff: boolean,
  sight: Sight | null,
  reliefs: Map<string, Relief>,
  surfaced: boolean
): Terrain {
  const mapItems = items.filter((item): item is Image => isImage(item) && item.layer === "MAP" && item.visible).sort((a, b) => a.zIndex - b.zIndex);
  const maps = mapItems.map((item) => mapImage(item, dpi));
  // Where the map is. With no map image, a box around the tokens, a few cells wide.
  let world: MultiPolygon;
  if (maps.length > 0) {
    const outlines = maps.map((map): MultiPolygon => [[closed(map.corners)]]);
    world = outlines.length === 1 ? outlines[0] : polygonClipping.union(outlines[0], ...outlines.slice(1));
  } else {
    const points: Pair[] = tokenItems.map((token): Pair => [token.position.x, token.position.y]);
    if (points.length === 0) {
      points.push([0, 0]);
    }
    const margin = dpi * 3;
    const x0 = Math.min(...points.map((p) => p[0])) - margin;
    const y0 = Math.min(...points.map((p) => p[1])) - margin;
    const x1 = Math.max(...points.map((p) => p[0])) + margin;
    const y1 = Math.max(...points.map((p) => p[1])) + margin;
    world = [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]];
  }
  const withRelief = terrainOff ? [] : mapItems.filter((item) => reliefs.has(item.id));
  const clear = sight ? sight.clear(world) : null;
  const parts = withRelief.map((item) => time("scene.reliefTerrain", () => reliefTerrain(reliefs.get(item.id)!, anchorOf(item), dpi, clear, surfaced)));
  const pieces: Piece[] = parts.flatMap((part) => part.pieces);
  // The map round the reliefs: plain ground.
  try {
    const rest = parts.length > 0 ? time("scene.groundRound", () => polygonClipping.difference(world, ...parts.map((part) => part.area))) : world;
    if (rest.length > 0) {
      pieces.unshift({ height: 0, shape: rest });
    }
  } catch (error) {
    console.error("Rising Ranges: Vistazo couldn't lay the ground round the reliefs", error);
  }
  const xs = world.flatMap((polygon) => polygon[0].map((p) => p[0]));
  const ys = world.flatMap((polygon) => polygon[0].map((p) => p[1]));
  const bounds = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  const inWorld = (x: number, y: number) => x >= bounds.x0 && x <= bounds.x1 && y >= bounds.y0 && y <= bounds.y1 && inShape(x, y, world);
  const heightAt = (x: number, y: number): number | undefined => {
    if (!inWorld(x, y)) {
      return undefined;
    }
    // The top image's relief (the last drawn), if it's over the point.
    for (let i = parts.length - 1; i >= 0; i--) {
      const h = parts[i].heightAt(x, y);
      if (h !== undefined) {
        return h;
      }
    }
    return 0;
  };
  // For asking which piece a point is in: each ring with its box (a big piece, the ground round
  // everything, has a hole for each shape: only those whose box has the point are asked), the pieces
  // kept by the squares of a coarse grid their boxes reach (only those of the point's square are asked).
  const boxOf = (ring: Pair[]) => {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of ring) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return { x0, y0, x1, y1 };
  };
  const within = (b: { x0: number; y0: number; x1: number; y1: number }, x: number, y: number) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  const boxed = pieces.map((piece) => {
    const polygons = piece.shape.map((polygon) => ({ outer: polygon[0], box: boxOf(polygon[0]), holes: polygon.slice(1).map((ring) => ({ ring, box: boxOf(ring) })) }));
    const box = { x0: Math.min(...polygons.map((p) => p.box.x0)), y0: Math.min(...polygons.map((p) => p.box.y0)), x1: Math.max(...polygons.map((p) => p.box.x1)), y1: Math.max(...polygons.map((p) => p.box.y1)) };
    const has = (x: number, y: number) =>
      polygons.some((p) => within(p.box, x, y) && inRing(x, y, p.outer) && !p.holes.some((hole) => within(hole.box, x, y) && inRing(x, y, hole.ring)));
    return { piece, box, has };
  });
  const square = dpi * 4;
  const columns = Math.max(1, Math.ceil((bounds.x1 - bounds.x0) / square));
  const rows = Math.max(1, Math.ceil((bounds.y1 - bounds.y0) / square));
  const squares: number[][] = Array.from({ length: columns * rows }, () => []);
  const column = (x: number) => Math.max(0, Math.min(columns - 1, Math.floor((x - bounds.x0) / square)));
  const row = (y: number) => Math.max(0, Math.min(rows - 1, Math.floor((y - bounds.y0) / square)));
  boxed.forEach(({ box }, i) => {
    for (let r = row(box.y0); r <= row(box.y1); r++) {
      for (let c = column(box.x0); c <= column(box.x1); c++) {
        squares[r * columns + c].push(i);
      }
    }
  });
  const pieceAt = (x: number, y: number): Piece | undefined => {
    if (!inWorld(x, y)) {
      return undefined;
    }
    // The topmost first (the last drawn).
    const list = squares[row(y) * columns + column(x)];
    for (let k = list.length - 1; k >= 0; k--) {
      const b = boxed[list[k]];
      if (within(b.box, x, y) && b.has(x, y)) {
        return b.piece;
      }
    }
    return undefined;
  };
  return {
    terrainKey,
    maps,
    world,
    bounds,
    pieces,
    heightAt,
    pieceAt,
    measuredAt: (x, y) => heightAt(x, y) ?? 0,
    terrainOff,
    bridges: parts.flatMap((part) => part.bridges),
    unfilled: parts.flatMap((part) => part.unfilled),
  };
}
