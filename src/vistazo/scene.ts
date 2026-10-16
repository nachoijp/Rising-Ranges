import { isImage, type GridScale, type GridType, type Image, type Item } from "@owlbear-rodeo/sdk";
import polygonClipping, { type MultiPolygon, type Pair } from "polygon-clipping";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import { onGrid } from "../engine/hex";
import { tokenName } from "../distances/rows";
import { globalSettingsFromMetadata, terrainOn } from "../settings/globalSettings";
import { getTerrainStand, terrainShapes, type TerrainStandEdge } from "../terrain/terrain";
import { terrainLayers } from "../terrain/terrainLayers";
import { isTokenHeightMarker, tokenHeightsFromMarkers } from "../tokenHeight/markers";
import { onFloor } from "../tokenHeight/lift";

// What the Vistazo draws, read from the scene: the map images where they
// lie, the terrain as non-overlapping pieces (terrainLayers: where zones
// overlap the smallest wins, as it's measured), and the tokens with their
// height above the ground and the terrain under them. All in scene px;
// heights in grid units.

/** An image of the Map layer: drawn as an <img> of its own size under `transform`. */
export type MapImage = { url: string; width: number; height: number; transform: string; corners: Pair[] };

/** The edge a standing zone turns up on: the one nearest the map's middle. */
export type StandEdge = "top" | "bottom" | "left" | "right";

/**
 * A piece of terrain at its height. A standing one (see getTerrainStand) is
 * drawn upright on `stand`, from `height` — the ground beside that edge —
 * and its own footprint is floor at that height.
 */
export type Piece = { height: number; shape: MultiPolygon; stand?: StandEdge; standBase?: number };

export type Token = {
  id: string;
  name: string;
  url: string;
  x: number;
  y: number;
  /** Its footprint across, in scene px. */
  size: number;
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
};

/** An image of the Props layer, where it lies, to draw flat on the ground or standing. */
export type Prop = { id: string; url: string; x: number; y: number; size: number; width: number; height: number; transform: string; rotation: number; terrain: number };

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
  /** Height at a scene point as measured (a standing zone at its own height). */
  measuredAt: (x: number, y: number) => number;
  /** Terrain is off for this scene (turned off, heights off, or an axonometric grid). */
  terrainOff: boolean;
};

export type VistazoScene = Terrain & {
  dpi: number;
  scale: GridScale;
  /** The grid is square: its cells can be drawn on the ground. */
  squareGrid: boolean;
  tokens: Token[];
  props: Prop[];
  /** Each token's height above the ground, terrain under it included (as the Distancias panel has it). */
  heights: Map<string, number>;
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

/** What the terrain is built from: the Map layer's items (bar their edit stamps), and the tokens when there's no map to size it. */
function terrainKeyOf(items: Item[], tokenItems: Image[], dpi: number, terrainOff: boolean): string {
  const onMap = items.filter((item) => item.layer === "MAP");
  const sized = onMap.some((item) => isImage(item) && item.visible) ? [] : tokenItems.map((token) => token.position);
  const mapItems = onMap.map(({ lastModified: _l, lastModifiedUserId: _u, ...item }) => item);
  return JSON.stringify([dpi, terrainOff, mapItems, sized]);
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
  previous?: VistazoScene
): VistazoScene {
  const settings = globalSettingsFromMetadata(metadata);
  const terrainOff = !terrainOn(settings, gridType);
  const altitude = settings.enableAltitude ?? true;
  const tokenItems = items.filter((item): item is Image => isImage(item) && item.layer === "CHARACTER");
  const key = terrainKeyOf(items, tokenItems, dpi, terrainOff);
  const terrain = previous && previous.terrainKey === key ? previous : buildTerrain(key, items, tokenItems, dpi, terrainOff);
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
      x,
      y,
      size: Math.max(floor.image.width * Math.abs(floor.scale.x), floor.image.height * Math.abs(floor.scale.y)) * k,
      terrain: measuredAt(x, y),
      own: own.get(item.id) ?? 0,
      rotation: item.rotation,
      flipX: item.scale.x < 0,
      flipY: item.scale.y < 0,
      hidden: !item.visible,
      item,
    };
    heights.set(item.id, token.terrain + token.own);
    return token;
  });

  const props: Prop[] = items
    .filter((item): item is Image => isImage(item) && item.layer === "PROP" && item.visible)
    .sort((a, b) => a.zIndex - b.zIndex)
    .map((item) => {
      const [x, y] = imageToScene(item, dpi, item.image.width / 2, item.image.height / 2);
      const k = dpi / item.grid.dpi;
      const map = mapImage(item, dpi);
      return {
        id: item.id,
        url: item.image.url,
        x,
        y,
        size: Math.max(item.image.width * Math.abs(item.scale.x), item.image.height * Math.abs(item.scale.y)) * k,
        width: item.image.width,
        height: item.image.height,
        transform: map.transform,
        rotation: item.rotation,
        terrain: measuredAt(x, y),
      };
    });

  return {
    terrainKey: terrain.terrainKey,
    maps: terrain.maps,
    world: terrain.world,
    bounds: terrain.bounds,
    pieces: terrain.pieces,
    heightAt: terrain.heightAt,
    measuredAt,
    terrainOff: terrain.terrainOff,
    dpi,
    scale,
    squareGrid: gridType === "SQUARE",
    tokens,
    props,
    heights,
  };
}

function buildTerrain(terrainKey: string, items: Item[], tokenItems: Image[], dpi: number, terrainOff: boolean): Terrain {
  const maps = items
    .filter((item): item is Image => isImage(item) && item.layer === "MAP" && item.visible)
    .sort((a, b) => a.zIndex - b.zIndex)
    .map((item) => mapImage(item, dpi));

  const shapes = terrainOff ? [] : terrainShapes(items);
  const zones: MultiPolygon = [];
  for (const shape of shapes) {
    for (const ring of shape.rings) {
      zones.push([closed(ring)]);
    }
  }

  // Where the map is. With no map image, a box around the terrain and the tokens, a few cells wide.
  let world: MultiPolygon;
  if (maps.length > 0) {
    const outlines = maps.map((map): MultiPolygon => [[closed(map.corners)]]);
    world = outlines.length === 1 ? outlines[0] : polygonClipping.union(outlines[0], ...outlines.slice(1));
  } else {
    const points: Pair[] = [
      ...zones.flatMap((polygon) => polygon[0]),
      ...tokenItems.map((token): Pair => [token.position.x, token.position.y]),
    ];
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

  // The pieces: each zone's visible part, within the map, and the bare ground around them.
  // polygon-clipping can throw on awkward outlines: a zone that fails is
  // left out, and if the bare ground fails, the whole map is drawn at 0
  // under everything instead (the zones above it still cover it).
  const pieces: Piece[] = [];
  const standing = new Map<string, TerrainStandEdge>();
  for (const item of items) {
    const edge = getTerrainStand(item);
    if (edge) {
      standing.set(item.id, edge);
    }
  }
  const asked = new Map<Piece, TerrainStandEdge>();
  let layers: ReturnType<typeof terrainLayers> = [];
  try {
    layers = terrainLayers(shapes);
  } catch (error) {
    console.error("Rising Ranges: Vistazo couldn't lay out the terrain", error);
  }
  for (const layer of layers) {
    if (layer.rim) {
      continue;
    }
    try {
      const shape = polygonClipping.intersection(layer.shape, world);
      if (shape.length > 0) {
        const piece: Piece = { height: layer.height, shape };
        const edge = layer.zoneId ? standing.get(layer.zoneId) : undefined;
        if (edge) {
          piece.stand = "bottom";
          asked.set(piece, edge);
        }
        pieces.push(piece);
      }
    } catch (error) {
      console.error("Rising Ranges: Vistazo left out a terrain zone", layer.zoneId, error);
    }
  }
  // The ground is what no zone's piece took: a path's inner outline is a
  // hole in it (as terrainLayers has it), so what's inside is still ground.
  let ground: MultiPolygon = world;
  try {
    const taken = pieces.map((piece) => piece.shape);
    const covered = taken.length > 0 ? polygonClipping.union(taken[0], ...taken.slice(1)) : [];
    ground = covered.length > 0 ? polygonClipping.difference(world, covered) : world;
  } catch (error) {
    console.error("Rising Ranges: Vistazo couldn't cut the ground, drawing the whole map", error);
  }
  if (ground.length > 0) {
    pieces.unshift({ height: 0, shape: ground });
  }

  const xs = world.flatMap((polygon) => polygon[0].map((p) => p[0]));
  const ys = world.flatMap((polygon) => polygon[0].map((p) => p[1]));
  const bounds = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };

  const heightAt = (x: number, y: number): number | undefined => {
    if (!inShape(x, y, world)) {
      return undefined;
    }
    for (const piece of pieces) {
      if (inShape(x, y, piece.shape)) {
        return piece.height;
      }
    }
    return 0;
  };
  // The heights as measured, before standing zones become blocks (for the tokens).
  const measured = pieces.map((piece) => piece.height);
  const measuredAt = (x: number, y: number): number => {
    const index = pieces.findIndex((piece) => inShape(x, y, piece.shape));
    return index < 0 ? 0 : measured[index];
  };

  // A standing zone turns up on the edge of its box that faces the map's middle, from the ground just past it.
  const middle = { x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2 };
  const probe = dpi * 0.1;
  for (const piece of pieces) {
    if (!piece.stand) {
      continue;
    }
    const outline = piece.shape.flatMap((polygon) => polygon[0]);
    const px0 = Math.min(...outline.map((p) => p[0]));
    const py0 = Math.min(...outline.map((p) => p[1]));
    const px1 = Math.max(...outline.map((p) => p[0]));
    const py1 = Math.max(...outline.map((p) => p[1]));
    const dx = middle.x - (px0 + px1) / 2;
    const dy = middle.y - (py0 + py1) / 2;
    const cx = (px0 + px1) / 2;
    const cy = (py0 + py1) / 2;
    // The edge asked for, or the one facing the middle.
    const wanted = asked.get(piece) ?? "auto";
    const edge: StandEdge =
      wanted !== "auto" ? wanted : Math.abs(dy) >= Math.abs(dx) ? (dy >= 0 ? "bottom" : "top") : dx >= 0 ? "right" : "left";
    const beside: Pair = { bottom: [cx, py1 + probe], top: [cx, py0 - probe], right: [px1 + probe, cy], left: [px0 - probe, cy] }[edge] as Pair;
    // A block as deep as the picture is tall, its front the picture standing up.
    piece.stand = edge;
    piece.standBase = heightAt(beside[0], beside[1]) ?? 0;
    piece.height = piece.standBase + (edge === "top" || edge === "bottom" ? py1 - py0 : px1 - px0) / dpi;
  }

  return { terrainKey, maps, world, bounds, pieces, heightAt, measuredAt, terrainOff };
}
