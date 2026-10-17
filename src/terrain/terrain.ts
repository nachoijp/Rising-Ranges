import { Command, isCurve, isPath, isShape, type Curve, type Item, type Vector2 } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";

// Terrain with a height: an ordinary Owlbear shape — rectangle, circle,
// polygon or closed freehand drawing — tagged from its context menu with how
// high the ground is there (cells, like a token's height; negative for a
// pit). A token standing in it (its anchor, its feet once aligned) is that
// much higher: every stored height stays above the ground it's on, and the
// terrain is added where a distance is worked out (see terrainAt).
//
// Only shapes on the Map layer: terrain is part of the map, and a drawing
// on any other layer is just a drawing (moved off the Map layer, a zone keeps
// its height, ignored, until it's moved back).
//
// Where zones overlap, the smallest one wins: a pit, a courtyard or a
// balcony inside something bigger is the ground there. Not the one drawn on
// top — Owlbear puts whatever was moved last on top of its layer — and not
// the highest. Two of the same size: the higher one.
//
// A zone can be a ramp: rising across its box (in its own frame, so a turned
// rectangle rises along its own side) from the ground just past its low edge
// up to its own height at the far edge. A point on it is as high as how far
// up the slope it is (see rampOf); everything measured goes through
// terrainAt, so a ramp measures everywhere at once.

const METADATA_KEY = getPluginId("terrain");

/** A shape that can be terrain: on the Map layer, and one whose inside is known (see contains). */
export function canBeTerrain(item: Item): boolean {
  if (item.layer !== "MAP") {
    return false;
  }
  if (isShape(item)) {
    return item.shapeType === "RECTANGLE" || item.shapeType === "CIRCLE";
  }
  if (isCurve(item)) {
    // Taken as closed, from its last point back to its first: Owlbear's own
    // polygons are stored with `closed: false` (seen live), so the flag
    // can't tell them from an open line.
    return item.points.length >= 3;
  }
  return isPath(item);
}

/** The zone's ground height in cells, if the item is a terrain zone. */
export function getTerrainHeight(item: Item): number | undefined {
  const stored = item.metadata[METADATA_KEY];
  return typeof stored === "number" && Number.isFinite(stored) ? stored : undefined;
}

/** Tags a draft as terrain at `height` cells (undefined: it isn't terrain any more). */
export function setTerrainHeight(item: Item, height: number | undefined) {
  if (height === undefined) {
    delete item.metadata[METADATA_KEY];
  } else {
    item.metadata[METADATA_KEY] = height;
  }
}

const STAND_KEY = getPluginId("terrainStand");

/** The edge a standing zone stands on in the Vistazo 3D, or "auto": the one facing the map's middle. */
export type TerrainStandEdge = "auto" | "top" | "bottom" | "left" | "right";

const STAND_EDGES: readonly TerrainStandEdge[] = ["top", "bottom", "left", "right"];

/**
 * Whether the Vistazo 3D stands the zone up, and on which edge: a part of
 * the map drawn as if upright (a statue, a wall seen from the front) is
 * turned up on that edge. Stored as true (auto) or the edge's name. Only
 * how it's drawn there; it measures as usual.
 */
export function getTerrainStand(item: Item): TerrainStandEdge | undefined {
  const stored = item.metadata[STAND_KEY];
  if (stored === true) {
    return "auto";
  }
  return STAND_EDGES.includes(stored as TerrainStandEdge) ? (stored as TerrainStandEdge) : undefined;
}

export function setTerrainStand(item: Item, stand: TerrainStandEdge | undefined) {
  if (stand === "auto") {
    item.metadata[STAND_KEY] = true;
  } else if (stand) {
    item.metadata[STAND_KEY] = stand;
  } else {
    delete item.metadata[STAND_KEY];
  }
}

/** What a zone's walls show in the Vistazo 3D (see vistazo/render.ts WallStyle). */
export type TerrainWallStyle = "flat" | "stretch" | "fold" | "stone" | "earth" | "wood";

const WALL_KEY = getPluginId("terrainWall");
const WALL_STYLES: readonly TerrainWallStyle[] = ["flat", "stretch", "fold", "stone", "earth", "wood"];

/** The zone's own wall style, if it has one (otherwise the Vistazo's own choice applies). */
export function getTerrainWall(item: Item): TerrainWallStyle | undefined {
  const stored = item.metadata[WALL_KEY];
  return WALL_STYLES.includes(stored as TerrainWallStyle) ? (stored as TerrainWallStyle) : undefined;
}

export function setTerrainWall(item: Item, style: TerrainWallStyle | undefined) {
  if (style) {
    item.metadata[WALL_KEY] = style;
  } else {
    delete item.metadata[WALL_KEY];
  }
}

/** Which way a ramp zone rises, in its own frame: toward its top, bottom, left or right side. */
export type TerrainRamp = "up" | "down" | "left" | "right";

const RAMP_KEY = getPluginId("terrainRamp");
const RAMPS: readonly TerrainRamp[] = ["up", "down", "left", "right"];

export function getTerrainRamp(item: Item): TerrainRamp | undefined {
  const stored = item.metadata[RAMP_KEY];
  return RAMPS.includes(stored as TerrainRamp) ? (stored as TerrainRamp) : undefined;
}

export function setTerrainRamp(item: Item, ramp: TerrainRamp | undefined) {
  if (ramp) {
    item.metadata[RAMP_KEY] = ramp;
  } else {
    delete item.metadata[RAMP_KEY];
  }
}

/**
 * A ramp worked out: its low end (cells), and its slope in scene
 * coordinates — `origin` the middle of its low edge, `axis` from there to
 * the middle of its high edge — so a point's way up it is
 * t = (p − origin)·axis / |axis|², 0 to 1.
 */
export type RampSlope = { low: number; origin: Vector2; axis: Vector2 };

/** A zone, ready to be asked whether a point is in it. */
export type TerrainZone = {
  id: string;
  height: number;
  /** Its area in scene px², to tell which of two overlapping zones is smaller. */
  area: number;
  contains: (point: Vector2) => boolean;
  /** A ramp's slope (its height then is the high end's). */
  slope?: RampSlope;
};

/** How high a ramp is at a point: from its low end to `height`, by how far up it the point is. */
export function slopeHeight(slope: RampSlope, height: number, point: Vector2): number {
  const { origin, axis } = slope;
  const length = axis.x * axis.x + axis.y * axis.y;
  const t = length > 0 ? ((point.x - origin.x) * axis.x + (point.y - origin.y) * axis.y) / length : 1;
  return slope.low + (height - slope.low) * Math.max(0, Math.min(1, t));
}

/** A point in the item's own coordinates: the item is drawn at position + R(rotation)·(scale·local). */
function toLocal(item: Item, point: Vector2): Vector2 {
  const angle = (-item.rotation * Math.PI) / 180;
  const dx = point.x - item.position.x;
  const dy = point.y - item.position.y;
  const x = dx * Math.cos(angle) - dy * Math.sin(angle);
  const y = dx * Math.sin(angle) + dy * Math.cos(angle);
  return { x: x / (item.scale.x || 1), y: y / (item.scale.y || 1) };
}

/** Even-odd: inside if a ray from it crosses the outlines an odd number of times. */
function inPolygons(polygons: Vector2[][], point: Vector2): boolean {
  let inside = false;
  for (const polygon of polygons) {
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i];
      const b = polygon[j];
      if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** A path's outlines, its curves taken by their end points (close enough for where a token stands). */
function pathPolygons(commands: number[][]): Vector2[][] {
  const polygons: Vector2[][] = [];
  let current: Vector2[] = [];
  for (const command of commands) {
    const type = command[0];
    if (type === Command.MOVE) {
      if (current.length >= 3) {
        polygons.push(current);
      }
      current = [{ x: command[1], y: command[2] }];
    } else if (type === Command.CLOSE) {
      if (current.length >= 3) {
        polygons.push(current);
      }
      current = [];
    } else {
      // LINE x y · QUAD x1 y1 x y · CONIC x1 y1 x y w · CUBIC x1 y1 x2 y2 x y
      const end = type === Command.CONIC ? 3 : command.length - 2;
      current.push({ x: command[end], y: command[end + 1] });
    }
  }
  if (current.length >= 3) {
    polygons.push(current);
  }
  return polygons;
}

/** The shoelace area of the outlines (unsigned, holes not subtracted: close enough to compare). */
function polygonsArea(polygons: Vector2[][]): number {
  let total = 0;
  for (const polygon of polygons) {
    let sum = 0;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      sum += polygon[j].x * polygon[i].y - polygon[i].x * polygon[j].y;
    }
    total += Math.abs(sum) / 2;
  }
  return total;
}

/** The zone's area in its own coordinates, before its scale. */
function localArea(item: Item): number {
  if (isShape(item)) {
    return item.shapeType === "CIRCLE" ? (Math.PI * item.width * item.height) / 4 : item.width * item.height;
  }
  if (isCurve(item)) {
    return polygonsArea([curveOutline(item)]);
  }
  if (isPath(item)) {
    return polygonsArea(pathPolygons(item.commands as number[][]));
  }
  return 0;
}

/** Points each smoothed side of a curve zone is drawn and measured with. */
const CURVE_STEPS = 12;

/**
 * A curve zone's outline as Owlbear draws it, closed: smoothed through its
 * points by its tension (0 = straight sides) — a cardinal spline, each side
 * a cubic Bézier whose handles follow the neighbouring points.
 */
function curveOutline(item: Curve): Vector2[] {
  const points = item.points;
  const tension = item.style.tension ?? 0;
  if (tension <= 0 || points.length < 3) {
    return points;
  }
  const n = points.length;
  const at = (i: number) => points[(i + n) % n];
  /** The handles either side of point i: before it, and after it. */
  const handles = (i: number) => {
    const [p0, p1, p2] = [at(i - 1), at(i), at(i + 1)];
    const d01 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const sum = d01 + d12 || 1;
    const fa = (tension * d01) / sum;
    const fb = (tension * d12) / sum;
    return {
      before: { x: p1.x - fa * (p2.x - p0.x), y: p1.y - fa * (p2.y - p0.y) },
      after: { x: p1.x + fb * (p2.x - p0.x), y: p1.y + fb * (p2.y - p0.y) },
    };
  };
  const all = points.map((_, i) => handles(i));
  const out: Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const [a, b] = [at(i), at(i + 1)];
    const [c1, c2] = [all[i].after, all[(i + 1) % n].before];
    for (let s = 0; s < CURVE_STEPS; s++) {
      const t = s / CURVE_STEPS;
      const u = 1 - t;
      out.push({
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      });
    }
  }
  return out;
}

function containsFor(item: Item): ((local: Vector2) => boolean) | null {
  if (isShape(item)) {
    const { width, height } = item;
    if (item.shapeType === "RECTANGLE") {
      // Drawn from its corner.
      return (p) => p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height;
    }
    if (item.shapeType === "CIRCLE") {
      // Drawn from its center.
      const rx = width / 2;
      const ry = height / 2;
      return (p) => rx > 0 && ry > 0 && (p.x / rx) ** 2 + (p.y / ry) ** 2 <= 1;
    }
    return null;
  }
  if (isCurve(item)) {
    const polygon = curveOutline(item);
    return (p) => inPolygons([polygon], p);
  }
  if (isPath(item)) {
    const polygons = pathPolygons(item.commands as number[][]);
    return (p) => inPolygons(polygons, p);
  }
  return null;
}

/**
 * A ramp's low and high edges, in scene coordinates: the middles of the
 * sides of its own box it rises from and to, and a point just past the low
 * one (where the ground it starts from is read).
 */
function rampEnds(item: Item, ramp: TerrainRamp): { low: Vector2; high: Vector2; beyond: Vector2 } | null {
  const points = localRings(item).flat();
  if (points.length < 3) {
    return null;
  }
  const x0 = Math.min(...points.map((p) => p.x));
  const x1 = Math.max(...points.map((p) => p.x));
  const y0 = Math.min(...points.map((p) => p.y));
  const y1 = Math.max(...points.map((p) => p.y));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  // A little past the low edge: 2% of the way across, at least a unit.
  const ex = Math.max(1, (x1 - x0) * 0.02);
  const ey = Math.max(1, (y1 - y0) * 0.02);
  const ends: Record<TerrainRamp, [Vector2, Vector2, Vector2]> = {
    up: [{ x: cx, y: y1 }, { x: cx, y: y0 }, { x: cx, y: y1 + ey }],
    down: [{ x: cx, y: y0 }, { x: cx, y: y1 }, { x: cx, y: y0 - ey }],
    left: [{ x: x1, y: cy }, { x: x0, y: cy }, { x: x1 + ex, y: cy }],
    right: [{ x: x0, y: cy }, { x: x1, y: cy }, { x: x0 - ex, y: cy }],
  };
  const [low, high, beyond] = ends[ramp].map((p) => {
    const [x, y] = toScene(item, p);
    return { x, y };
  });
  return { low, high, beyond };
}

/** The scene's terrain zones, the one that wins first: smallest, then highest. */
export function terrainZones(items: Item[]): TerrainZone[] {
  const zones: TerrainZone[] = [];
  const ramps: { zone: TerrainZone; ends: NonNullable<ReturnType<typeof rampEnds>> }[] = [];
  for (const item of items) {
    const height = getTerrainHeight(item);
    if (height === undefined || !canBeTerrain(item)) {
      continue;
    }
    const contains = containsFor(item);
    if (!contains) {
      continue;
    }
    const zone: TerrainZone = {
      id: item.id,
      height,
      area: localArea(item) * Math.abs(item.scale.x * item.scale.y),
      contains: (point) => contains(toLocal(item, point)),
    };
    zones.push(zone);
    const ramp = getTerrainRamp(item);
    const ends = ramp && rampEnds(item, ramp);
    if (ends) {
      ramps.push({ zone, ends });
    }
  }
  zones.sort((a, b) => a.area - b.area || b.height - a.height);
  // Each ramp's low end: the ground just past its low edge, without it (a
  // ramp read before this one counts as the ramp it is; one after, flat at its height).
  for (const { zone, ends } of ramps) {
    const others = zones.filter((other) => other !== zone);
    zone.slope = { low: terrainAt(others, ends.beyond), origin: ends.low, axis: { x: ends.high.x - ends.low.x, y: ends.high.y - ends.low.y } };
  }
  return zones;
}

/** How high the ground is at a point, in cells: the winning zone it's in (along its slope, if it's a ramp), or 0. */
export function terrainAt(zones: TerrainZone[], point: Vector2): number {
  for (const zone of zones) {
    if (zone.contains(point)) {
      return zone.slope ? slopeHeight(zone.slope, zone.height, point) : zone.height;
    }
  }
  return 0;
}

/** A zone's outline(s) in scene coordinates, for drawing it (see terrainView.ts); a ramp's slope as terrainZones has it. */
export type TerrainShape = { id: string; height: number; area: number; rings: [number, number][][]; slope?: RampSlope };

/** How many points a circle zone's outline is drawn with. */
const CIRCLE_POINTS = 48;

/** A zone's outline(s) in its own coordinates. */
function localRings(item: Item): Vector2[][] {
  if (isShape(item)) {
    const { width, height } = item;
    if (item.shapeType === "RECTANGLE") {
      return [[{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]];
    }
    return [
      Array.from({ length: CIRCLE_POINTS }, (_, i) => {
        const angle = (i / CIRCLE_POINTS) * Math.PI * 2;
        return { x: (Math.cos(angle) * width) / 2, y: (Math.sin(angle) * height) / 2 };
      }),
    ];
  }
  if (isCurve(item)) {
    return [curveOutline(item)];
  }
  if (isPath(item)) {
    return pathPolygons(item.commands as number[][]);
  }
  return [];
}

/** A point of the item's own coordinates where it's drawn: position + R(rotation)·(scale·local). */
function toScene(item: Item, p: Vector2): [number, number] {
  const angle = (item.rotation * Math.PI) / 180;
  const x = p.x * item.scale.x;
  const y = p.y * item.scale.y;
  return [item.position.x + x * Math.cos(angle) - y * Math.sin(angle), item.position.y + x * Math.sin(angle) + y * Math.cos(angle)];
}

/** The scene's terrain zones with their outlines, the one that wins first (smallest, then highest), as terrainZones. */
export function terrainShapes(items: Item[]): TerrainShape[] {
  const shapes: TerrainShape[] = [];
  const slopes = new Map(terrainZones(items).filter((zone) => zone.slope).map((zone) => [zone.id, zone.slope]));
  for (const item of items) {
    const height = getTerrainHeight(item);
    if (height === undefined || !canBeTerrain(item)) {
      continue;
    }
    const rings = localRings(item)
      .filter((ring) => ring.length >= 3)
      .map((ring) => ring.map((p) => toScene(item, p)));
    if (rings.length > 0) {
      shapes.push({ id: item.id, height, area: localArea(item) * Math.abs(item.scale.x * item.scale.y), rings, slope: slopes.get(item.id) });
    }
  }
  return shapes.sort((a, b) => a.area - b.area || b.height - a.height);
}
