import { isImage, type GridScale, type GridType, type Image, type Item } from "@owlbear-rodeo/sdk";
import polygonClipping, { type MultiPolygon, type Pair } from "polygon-clipping";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import { onGrid } from "../engine/hex";
import { tokenName } from "../distances/rows";
import { globalSettingsFromMetadata, terrainOn } from "../settings/globalSettings";
import {
  getTerrainStand,
  getTerrainWall,
  slopeHeight,
  terrainShapes,
  type RampSlope,
  type TerrainStandEdge,
  type TerrainWallStyle,
} from "../terrain/terrain";
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
export type Piece = {
  height: number;
  shape: MultiPolygon;
  stand?: StandEdge;
  standBase?: number;
  /**
   * A standing zone drawn as four points (a wall seen in perspective):
   * unfolded on its own edges rather than its box — `base` the edge it
   * stands on, `top` the one across (each from the base's own ends' side),
   * `out` the way its front faces (scene, unit), `rise` how tall it stands
   * (grid units: up to the zone's own height).
   */
  unfold?: { base: [Pair, Pair]; top: [Pair, Pair]; out: Pair; rise: number };
  /** Its zone's own wall style, if it has one. */
  walls?: TerrainWallStyle;
  /** A ramp's slope: then `height` is its high end. */
  slope?: RampSlope;
};

/** How high a piece is at a scene point: along its slope, if it's a ramp. */
export function pieceHeight(piece: Piece, x: number, y: number): number {
  return piece.slope ? slopeHeight(piece.slope, piece.height, { x, y }) : piece.height;
}

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
  /** The piece at a scene point, if it's on the map. */
  pieceAt: (x: number, y: number) => Piece | undefined;
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
  /** A hex grid: its orientation and one cell's center (for drawing its cells on the ground). */
  hexGrid: { shape: "hexHorizontal" | "hexVertical"; center: { x: number; y: number } } | null;
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
  previous?: VistazoScene,
  hexCenter: { x: number; y: number } | null = null
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
    pieceAt: terrain.pieceAt,
    measuredAt,
    terrainOff: terrain.terrainOff,
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
  const slopes = new Map(shapes.filter((shape) => shape.slope).map((shape) => [shape.id, shape.slope as RampSlope]));
  // A zone of exactly four points, for unfolding it standing (see Piece.unfold).
  const quads = new Map<string, [number, number][]>();
  for (const shape of shapes) {
    const corners = shape.rings.length === 1 ? cornersOf(shape.rings[0]) : [];
    if (corners.length === 4) {
      quads.set(shape.id, corners);
    }
  }
  const zoneOf = new Map<Piece, string>();
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
        const zone = layer.zoneId ? items.find((item) => item.id === layer.zoneId) : undefined;
        const piece: Piece = {
          height: layer.height,
          shape,
          walls: zone ? getTerrainWall(zone) : undefined,
          slope: layer.zoneId ? slopes.get(layer.zoneId) : undefined,
        };
        const edge = layer.zoneId ? standing.get(layer.zoneId) : undefined;
        if (edge) {
          piece.stand = "bottom";
          asked.set(piece, edge);
          zoneOf.set(piece, layer.zoneId!);
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

  /** The piece at a scene point, if it's on the map. */
  const pieceAt = (x: number, y: number): Piece | undefined => {
    if (!inShape(x, y, world)) {
      return undefined;
    }
    return pieces.find((piece) => inShape(x, y, piece.shape));
  };
  const heightAt = (x: number, y: number): number | undefined => {
    if (!inShape(x, y, world)) {
      return undefined;
    }
    for (const piece of pieces) {
      if (inShape(x, y, piece.shape)) {
        return pieceHeight(piece, x, y);
      }
    }
    return 0;
  };
  // The heights as measured, before standing zones become blocks (for the tokens).
  const measured = pieces.map((piece) => ({ ...piece }));
  const measuredAt = (x: number, y: number): number => {
    const index = pieces.findIndex((piece) => inShape(x, y, piece.shape));
    return index < 0 ? 0 : pieceHeight(measured[index], x, y);
  };

  // A standing zone turns up on the edge of its box that faces the map's middle, from the ground just past it.
  const middle = { x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2 };
  const probe = dpi * 0.1;
  for (const piece of pieces) {
    if (!piece.stand) {
      continue;
    }
    const quad = quads.get(zoneOf.get(piece) ?? "");
    if (quad) {
      unfoldQuad(piece, quad, asked.get(piece) ?? "auto", middle, (x, y) => heightAt(x, y) ?? 0, probe);
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
    // A block as deep as the picture is tall, its front the picture standing up (flat on top, if it was a ramp).
    piece.stand = edge;
    piece.slope = undefined;
    piece.standBase = heightAt(beside[0], beside[1]) ?? 0;
    piece.height = piece.standBase + (edge === "top" || edge === "bottom" ? py1 - py0 : px1 - px0) / dpi;
  }

  return { terrainKey, maps, world, bounds, pieces, heightAt, pieceAt, measuredAt, terrainOff };
}

/** Which way each named edge faces, for picking a four-point zone's edge (see unfoldQuad). */
const FACES: Record<"top" | "bottom" | "left" | "right", Pair> = { bottom: [0, 1], top: [0, -1], right: [1, 0], left: [-1, 0] };

/**
 * A standing four-point zone, unfolded on its own edges: it stands on the
 * edge asked for (the one whose front faces that way most) or, on auto, the
 * one nearest the map's middle, from the ground just past it, up to its own
 * height (as it measures). Its block behind is flat at that height.
 */
function unfoldQuad(piece: Piece, quad: [number, number][], wanted: TerrainStandEdge, middle: { x: number; y: number }, groundAt: (x: number, y: number) => number, probe: number) {
  const cx = quad.reduce((sum, p) => sum + p[0], 0) / 4;
  const cy = quad.reduce((sum, p) => sum + p[1], 0) / 4;
  const edges = quad.map((a, i) => {
    const b = quad[(i + 1) % 4];
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let out: Pair = [(b[1] - a[1]) / length, -(b[0] - a[0]) / length];
    // Pointing away from the middle of the four points.
    if (out[0] * (mx - cx) + out[1] * (my - cy) < 0) {
      out = [-out[0], -out[1]];
    }
    return { i, mx, my, out };
  });
  const pick =
    wanted === "auto"
      ? edges.reduce((best, e) => (Math.hypot(e.mx - middle.x, e.my - middle.y) < Math.hypot(best.mx - middle.x, best.my - middle.y) ? e : best))
      : edges.reduce((best, e) => {
          const face = FACES[wanted];
          return e.out[0] * face[0] + e.out[1] * face[1] > best.out[0] * face[0] + best.out[1] * face[1] ? e : best;
        });
  const at = (k: number) => quad[(pick.i + k) % 4];
  const base: [Pair, Pair] = [at(0), at(1)];
  // Across from it, each end on its own side: the point after the base's end, then the one before its start.
  const top: [Pair, Pair] = [at(3), at(2)];
  const standBase = groundAt(pick.mx + pick.out[0] * probe, pick.my + pick.out[1] * probe);
  piece.stand = "bottom";
  piece.slope = undefined;
  piece.standBase = standBase;
  // As tall as the zone measures (at least half a cell, so it's there).
  piece.height = Math.max(piece.height, standBase + 0.5);
  piece.unfold = { base, top, out: pick.out, rise: piece.height - standBase };
}

/**
 * A drawn outline's real corners: without points repeated (Owlbear's
 * polygon can end on its first one again) or lying on the line between
 * their neighbours (a click along a side), so four clicked corners count as four.
 */
function cornersOf(ring: [number, number][]): [number, number][] {
  const size = Math.max(...ring.map((p) => Math.abs(p[0])), ...ring.map((p) => Math.abs(p[1])), 1);
  let points = ring.filter((p, i) => {
    const q = ring[(i + 1) % ring.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > size * 1e-6;
  });
  // Drop the straightest point while any is nearly straight (its turn under ~8°).
  for (;;) {
    if (points.length <= 3) {
      return points;
    }
    let straightest = -1;
    let least = Infinity;
    points.forEach((p, i) => {
      const a = points[(i - 1 + points.length) % points.length];
      const b = points[(i + 1) % points.length];
      const ux = p[0] - a[0];
      const uy = p[1] - a[1];
      const vx = b[0] - p[0];
      const vy = b[1] - p[1];
      const turn = Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
      if (turn < least) {
        least = turn;
        straightest = i;
      }
    });
    if (least > 0.15) {
      return points;
    }
    points = points.filter((_, i) => i !== straightest);
  }
}
