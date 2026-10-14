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

/** A zone, ready to be asked whether a point is in it. */
export type TerrainZone = {
  id: string;
  height: number;
  /** Its area in scene px², to tell which of two overlapping zones is smaller. */
  area: number;
  contains: (point: Vector2) => boolean;
};

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

/** The scene's terrain zones, the one that wins first: smallest, then highest. */
export function terrainZones(items: Item[]): TerrainZone[] {
  const zones: TerrainZone[] = [];
  for (const item of items) {
    const height = getTerrainHeight(item);
    if (height === undefined || !canBeTerrain(item)) {
      continue;
    }
    const contains = containsFor(item);
    if (!contains) {
      continue;
    }
    zones.push({
      id: item.id,
      height,
      area: localArea(item) * Math.abs(item.scale.x * item.scale.y),
      contains: (point) => contains(toLocal(item, point)),
    });
  }
  return zones.sort((a, b) => a.area - b.area || b.height - a.height);
}

/** How high the ground is at a point, in cells: the winning zone it's in, or 0. */
export function terrainAt(zones: TerrainZone[], point: Vector2): number {
  for (const zone of zones) {
    if (zone.contains(point)) {
      return zone.height;
    }
  }
  return 0;
}

/** A zone's outline(s) in scene coordinates, for drawing it (see terrainView.ts). */
export type TerrainShape = { id: string; height: number; area: number; rings: [number, number][][] };

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
  for (const item of items) {
    const height = getTerrainHeight(item);
    if (height === undefined || !canBeTerrain(item)) {
      continue;
    }
    const rings = localRings(item)
      .filter((ring) => ring.length >= 3)
      .map((ring) => ring.map((p) => toScene(item, p)));
    if (rings.length > 0) {
      shapes.push({ id: item.id, height, area: localArea(item) * Math.abs(item.scale.x * item.scale.y), rings });
    }
  }
  return shapes.sort((a, b) => a.area - b.area || b.height - a.height);
}
