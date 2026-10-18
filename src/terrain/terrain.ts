import { Command, isCurve, isPath, isShape, type Curve, type Item, type Vector2 } from "@owlbear-rodeo/sdk";
import polygonClipping, { type Pair, type Polygon } from "polygon-clipping";
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
export type TerrainWallStyle = "flat" | "stretch" | "fold" | "stone" | "rubble" | "earth" | "wood";

const WALL_KEY = getPluginId("terrainWall");
const WALL_STYLES: readonly TerrainWallStyle[] = ["flat", "stretch", "fold", "stone", "rubble", "earth", "wood"];

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

// A bridge or a balcony: a zone with an underside (its height, cells: up
// in the air, or below 0 for a bridge level with the ground over a ravine).
// It doesn't change the ground (what's under it is what's
// measured); a token on it stands at its height by its own (raised to it),
// and the Vistazo draws it as a floating slab.

const UNDER_KEY = getPluginId("terrainUnder");

/** The zone's underside, in cells (undefined, or 0: solid down to the ground). */
export function getTerrainUnder(item: Item): number | undefined {
  const stored = item.metadata[UNDER_KEY];
  return typeof stored === "number" && Number.isFinite(stored) && stored !== 0 ? stored : undefined;
}

export function setTerrainUnder(item: Item, cells: number | undefined) {
  if (cells !== undefined && cells !== 0) {
    item.metadata[UNDER_KEY] = cells;
  } else {
    delete item.metadata[UNDER_KEY];
  }
}

/** Whether a terrain item is a bridge: an underside of its own, below its top. */
function isBridge(item: Item, height: number): boolean {
  const under = getTerrainUnder(item);
  return under !== undefined && under < height;
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
  /** A cloth's surface (see clothSurface): its height at each point, from the terrain round it. */
  surface?: (point: Vector2) => number;
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

/** A path's outlines, its curves followed along (see the curve commands below). */
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
      // LINE x y · QUAD x1 y1 x y · CONIC x1 y1 x y w · CUBIC x1 y1 x2 y2 x y. Curves followed along
      // (CURVE_STEPS points each), not cut short to their ends: a circle drawn as a path is four
      // curves between four nodes, and by its ends alone it'd be a square.
      const from = current[current.length - 1];
      const end = type === Command.CONIC ? 3 : command.length - 2;
      const to = { x: command[end], y: command[end + 1] };
      if (from && (type === Command.QUAD || type === Command.CONIC || type === Command.CUBIC)) {
        for (let step = 1; step < CURVE_STEPS; step++) {
          const t = step / CURVE_STEPS;
          const u = 1 - t;
          if (type === Command.CUBIC) {
            const [c1, c2] = [{ x: command[1], y: command[2] }, { x: command[3], y: command[4] }];
            current.push({
              x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
              y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
            });
          } else {
            // A quadratic; a conic is one weighted at its control point (w = 1: the same quadratic).
            const c = { x: command[1], y: command[2] };
            const w = type === Command.CONIC ? command[5] : 1;
            const [a0, a1, a2] = [u * u, 2 * u * t * w, t * t];
            const sum = a0 + a1 + a2;
            current.push({ x: (a0 * from.x + a1 * c.x + a2 * to.x) / sum, y: (a0 * from.y + a1 * c.y + a2 * to.y) / sum });
          }
        }
      }
      current.push(to);
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
    // A bridge isn't ground: what's under it is.
    if (height === undefined || !canBeTerrain(item) || isBridge(item, height)) {
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
  // Cloths last: stretched over the terrain round them (which is read without them).
  const solid = [...zones];
  // The solid zones' outlines, for what of a cloth they cover (see clothSurface).
  const solidIds = new Set(solid.map((zone) => zone.id));
  const solidOutlines: Pair[][] = items
    .filter((item) => solidIds.has(item.id))
    .flatMap((item) => localRings(item).filter((ring) => ring.length >= 3).map((ring) => ring.map((p) => toScene(item, p) as Pair)));
  for (const item of items) {
    if (!getTerrainCloth(item) || !canBeTerrain(item)) {
      continue;
    }
    const contains = containsFor(item);
    const cloth = contains && clothSurface(item, solid, solidOutlines);
    if (cloth) {
      // A little past its outline too (thin gaps to the shapes beside it closed); last of all, so
      // where that overlaps any other zone, the zone wins.
      zones.push({
        id: item.id,
        height: cloth.height,
        area: Number.MAX_VALUE,
        contains: (point) => contains(toLocal(item, point)) || nearRings(cloth.rings, point, CLOTH_GAP),
        surface: cloth.at,
      });
    }
  }
  return zones;
}

/** How high the ground is at a point, in cells: the winning zone it's in (along its slope, if it's a ramp), or 0. */
export function terrainAt(zones: TerrainZone[], point: Vector2): number {
  for (const zone of zones) {
    if (zone.contains(point)) {
      return zone.surface ? zone.surface(point) : zone.slope ? slopeHeight(zone.slope, zone.height, point) : zone.height;
    }
  }
  return 0;
}

/** A zone's outline(s) in scene coordinates, for drawing it (see terrainView.ts); a ramp's slope as terrainZones has it. */
export type TerrainShape = { id: string; height: number; area: number; rings: [number, number][][]; slope?: RampSlope; surface?: (point: Vector2) => number };

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

/** Any shape, curve or path's outline(s) in scene coordinates (a fog shape's too: see vistazo/fog.ts). */
export function itemOutline(item: Item): [number, number][][] {
  return localRings(item)
    .filter((ring) => ring.length >= 3)
    .map((ring) => ring.map((p) => toScene(item, p)));
}

/** The scene's terrain zones with their outlines, the one that wins first (smallest, then highest), as terrainZones. */
export function terrainShapes(items: Item[]): TerrainShape[] {
  const shapes: TerrainShape[] = [];
  const zones = terrainZones(items);
  const slopes = new Map(zones.filter((zone) => zone.slope).map((zone) => [zone.id, zone.slope]));
  // A cloth: drawn with its surface (and, for what's coloured by height, the middle of its heights).
  const cloths = new Map(zones.filter((zone) => zone.surface).map((zone) => [zone.id, zone]));
  for (const item of items) {
    const cloth = cloths.get(item.id);
    if (cloth) {
      const rings = localRings(item)
        .filter((ring) => ring.length >= 3)
        .map((ring) => ring.map((p) => toScene(item, p)));
      // Drawn a little past its outline too (see terrainZones), last of all.
      const grown = growRings(rings, CLOTH_GAP);
      if (grown.length > 0) {
        shapes.push({ id: item.id, height: cloth.height, area: cloth.area, rings: grown, surface: cloth.surface });
      }
      continue;
    }
    const height = getTerrainHeight(item);
    if (height === undefined || !canBeTerrain(item) || isBridge(item, height)) {
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

/** A bridge or balcony (see getTerrainUnder): its outline in the scene, its top and underside (cells), its wall style. */
/**
 * A bridge's own box in the scene (px): its middle, its length's way and
 * its width's (unit vectors), and half of each — what's painted under it
 * on the map is filled from beside its long sides (see the Vistazo).
 */
export type BridgeFrame = { center: Vector2; along: Vector2; across: Vector2; halfAlong: number; halfAcross: number };

export type TerrainBridge = { id: string; top: number; bottom: number; rings: [number, number][][]; walls?: TerrainWallStyle; skin?: TerrainSkin; frame: BridgeFrame };

/**
 * The tightest box round an item's outline in the scene, at whatever angle
 * (a bridge drawn along the map, not only one turned as an item): of the
 * boxes lined up with each side of its convex hull, the smallest. Its
 * length is its longer side.
 */
function bridgeFrame(item: Item): BridgeFrame {
  const points = localRings(item)
    .flat()
    .map((p) => {
      const [x, y] = toScene(item, p);
      return { x, y };
    });
  const hull = convexHull(points);
  let best: BridgeFrame | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-9) {
      continue;
    }
    const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    const v = { x: -u.y, y: u.x };
    let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const p of hull) {
      const pu = p.x * u.x + p.y * u.y;
      const pv = p.x * v.x + p.y * v.y;
      [u0, u1, v0, v1] = [Math.min(u0, pu), Math.max(u1, pu), Math.min(v0, pv), Math.max(v1, pv)];
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < bestArea) {
      bestArea = area;
      const [mu, mv] = [(u0 + u1) / 2, (v0 + v1) / 2];
      const center = { x: u.x * mu + v.x * mv, y: u.y * mu + v.y * mv };
      const [lu, lv] = [u1 - u0, v1 - v0];
      best = lu >= lv ? { center, along: u, across: v, halfAlong: lu / 2, halfAcross: lv / 2 } : { center, along: v, across: u, halfAlong: lv / 2, halfAcross: lu / 2 };
    }
  }
  return best ?? { center: points[0] ?? { x: 0, y: 0 }, along: { x: 1, y: 0 }, across: { x: 0, y: 1 }, halfAlong: 0, halfAcross: 0 };
}

/** The convex hull of some points (monotone chain), counterclockwise. */
function convexHull(points: Vector2[]): Vector2[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) {
    return sorted;
  }
  const cross = (o: Vector2, a: Vector2, b: Vector2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vector2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Vector2[] = [];
  for (const p of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The scene's bridges and balconies, for drawing them (they're not ground: see terrainZones). */
export function terrainBridges(items: Item[]): TerrainBridge[] {
  const bridges: TerrainBridge[] = [];
  for (const item of items) {
    const height = getTerrainHeight(item);
    if (height === undefined || !canBeTerrain(item) || !isBridge(item, height)) {
      continue;
    }
    const rings = localRings(item)
      .filter((ring) => ring.length >= 3)
      .map((ring) => ring.map((p) => toScene(item, p)));
    if (rings.length > 0) {
      bridges.push({ id: item.id, top: height, bottom: getTerrainUnder(item)!, rings, walls: getTerrainWall(item), skin: terrainSkin(item, items), frame: bridgeFrame(item) });
    }
  }
  return bridges;
}

// A zone's walls (and a bridge's underside) can take their picture from
// another part of the map: a rectangle drawn over something painted lying
// down, seen from above (a column, a tree). The zone keeps the rectangle's
// id; the rectangle's long side becomes the walls' height, from its end
// nearest the zone (the foot) to the far one, and its width goes round.

const SKIN_KEY = getPluginId("terrainSkin");

export function getTerrainSkin(item: Item): string | undefined {
  const stored = item.metadata[SKIN_KEY];
  return typeof stored === "string" && stored.length > 0 ? stored : undefined;
}

export function setTerrainSkin(item: Item, sourceId: string | undefined) {
  if (sourceId) {
    item.metadata[SKIN_KEY] = sourceId;
  } else {
    delete item.metadata[SKIN_KEY];
  }
}

/**
 * Where a zone's picture is on the map (scene px): `base` the rectangle's
 * short edge nearest the zone (its foot), `top` the other, each listed
 * from the same long side; and the zone's middle, which the picture goes
 * round.
 */
export type TerrainSkin = { base: [Vector2, Vector2]; top: [Vector2, Vector2]; center: Vector2 };

/** A zone's picture from the map, if it's linked to a rectangle that's still there. */
export function terrainSkin(zone: Item, items: Item[]): TerrainSkin | undefined {
  const id = getTerrainSkin(zone);
  const source = id ? items.find((item) => item.id === id) : undefined;
  const zonePoints = localRings(zone).flat();
  const points = source ? localRings(source).flat() : [];
  if (!source || points.length < 3 || zonePoints.length < 3) {
    return undefined;
  }
  const scene = (p: Vector2) => {
    const [x, y] = toScene(zone, p);
    return { x, y };
  };
  const zx = zonePoints.map((p) => p.x);
  const zy = zonePoints.map((p) => p.y);
  const center = scene({ x: (Math.min(...zx) + Math.max(...zx)) / 2, y: (Math.min(...zy) + Math.max(...zy)) / 2 });
  // The rectangle's corners: its own box, turned as it is.
  const x0 = Math.min(...points.map((p) => p.x));
  const x1 = Math.max(...points.map((p) => p.x));
  const y0 = Math.min(...points.map((p) => p.y));
  const y1 = Math.max(...points.map((p) => p.y));
  const corner = (x: number, y: number) => {
    const [sx, sy] = toScene(source, { x, y });
    return { x: sx, y: sy };
  };
  const [c00, c10, c11, c01] = [corner(x0, y0), corner(x1, y0), corner(x1, y1), corner(x0, y1)];
  const wide = Math.hypot(c10.x - c00.x, c10.y - c00.y) >= Math.hypot(c01.x - c00.x, c01.y - c00.y);
  // Its short edges, each from the same long side.
  const ends: [[Vector2, Vector2], [Vector2, Vector2]] = wide
    ? [
        [c00, c01],
        [c10, c11],
      ]
    : [
        [c00, c10],
        [c01, c11],
      ];
  const far = (edge: [Vector2, Vector2]) => Math.hypot((edge[0].x + edge[1].x) / 2 - center.x, (edge[0].y + edge[1].y) / 2 - center.y);
  const [base, top] = far(ends[0]) <= far(ends[1]) ? ends : [ends[1], ends[0]];
  return { base, top, center };
}

// Water in a zone, for the Vistazo 3D: how deep (cells) over the zone's own
// height, its floor. Only drawn: the zone still measures at its floor.

const WATER_KEY = getPluginId("terrainWater");

export function getTerrainWater(item: Item): number | undefined {
  const stored = item.metadata[WATER_KEY];
  return typeof stored === "number" && Number.isFinite(stored) && stored > 0 ? stored : undefined;
}

export function setTerrainWater(item: Item, cells: number | undefined) {
  if (cells !== undefined && cells > 0) {
    item.metadata[WATER_KEY] = cells;
  } else {
    delete item.metadata[WATER_KEY];
  }
}

// A cloth: a shape with no height of its own, stretched between the terrain
// round it like a cloth (a ravine's painted cliff between the rim and the
// river). Each point of it is as high as the ground just past its outline,
// the nearer parts of the outline counting far more. It's measured so too.

const CLOTH_KEY = getPluginId("terrainCloth");

export function getTerrainCloth(item: Item): boolean {
  return item.metadata[CLOTH_KEY] === true;
}

export function setTerrainCloth(item: Item, cloth: boolean) {
  if (cloth) {
    item.metadata[CLOTH_KEY] = true;
  } else {
    delete item.metadata[CLOTH_KEY];
  }
}

/** The most points a cloth's outline is read at (spread along it). */
const CLOTH_SAMPLES = 160;

/**
 * How far past its outline a cloth reaches (scene px, about a tenth of a
 * cell on a usual map): thin gaps to the shapes beside it, drawn by hand,
 * are closed; and how far out its outline looks for the terrain it's
 * stretched to (twice that), past such a gap.
 */
const CLOTH_GAP = 16;

/** Whether a point is within `reach` of some outline's sides. */
function nearRings(rings: Vector2[][], point: Vector2, reach: number): boolean {
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length2 = dx * dx + dy * dy;
      const t = length2 > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2)) : 0;
      if (Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)) <= reach) {
        return true;
      }
    }
  }
  return false;
}

/** Outlines grown by `reach` on every side (each side widened to a band, joined), as outer rings. */
export function growRings(rings: [number, number][][], reach: number): [number, number][][] {
  const parts: Polygon[] = rings.map((ring) => [ring as Pair[]]);
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % ring.length];
      const length = Math.hypot(bx - ax, by - ay);
      if (length < 1e-9) {
        continue;
      }
      const [nx, ny] = [(-(by - ay) / length) * reach, ((bx - ax) / length) * reach];
      const [ux, uy] = [((bx - ax) / length) * reach, ((by - ay) / length) * reach];
      // The side as a band, a little past its ends so the corners close.
      parts.push([[[ax - ux + nx, ay - uy + ny], [bx + ux + nx, by + uy + ny], [bx + ux - nx, by + uy - ny], [ax - ux - nx, ay - uy - ny]]]);
    }
  }
  try {
    const grown = polygonClipping.union(parts[0], ...parts.slice(1));
    return grown.map((polygon) => polygon[0] as [number, number][]);
  } catch {
    return rings;
  }
}

/**
 * A cloth's surface: its outline read at points along it, each with the
 * height of the ground just outside there (`solid`: the terrain without
 * cloths); a point inside, those heights weighted by how near each is
 * (1/d³: the nearest part of the outline rules). Also the middle of its
 * heights (to sort and colour it by).
 */
function clothSurface(item: Item, solid: TerrainZone[], solidOutlines: Pair[][] = []): { at: (point: Vector2) => number; height: number; rings: Vector2[][] } | null {
  const contains = containsFor(item);
  const rings = localRings(item)
    .filter((ring) => ring.length >= 3)
    .map((ring) => ring.map((p) => {
      const [x, y] = toScene(item, p);
      return { x, y };
    }));
  if (!contains || rings.length === 0) {
    return null;
  }
  // What of it is left where other zones cover it (they win there): its outline is read along that,
  // so a high zone drawn over its edge (a cliff's top) gives that edge its height.
  const covered = (() => {
    const xs = rings.flat().map((p) => p.x);
    const ys = rings.flat().map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    // Only the zones whose box meets its box.
    const over = solidOutlines.filter((ring) => {
      const rx = ring.map(([x]) => x);
      const ry = ring.map(([, y]) => y);
      return Math.min(...rx) <= x1 && Math.max(...rx) >= x0 && Math.min(...ry) <= y1 && Math.max(...ry) >= y0;
    });
    if (over.length === 0) {
      return null;
    }
    try {
      const own = rings.map((ring) => [ring.map((p) => [p.x, p.y] as Pair)]);
      const left = polygonClipping.difference(own as Polygon[], ...over.map((ring) => [ring] as Polygon));
      return left.flatMap((polygon) => polygon.map((ring) => ring.slice(0, -1).map(([x, y]) => ({ x, y }))));
    } catch {
      return null;
    }
  })();
  const outline = covered && covered.length > 0 ? covered : rings;
  const perimeter = outline.reduce((sum, ring) => sum + ring.reduce((s, p, i) => s + Math.hypot(ring[(i + 1) % ring.length].x - p.x, ring[(i + 1) % ring.length].y - p.y), 0), 0);
  const step = Math.max(2, perimeter / CLOTH_SAMPLES);
  // Inside what's left of it (even-odd over its outline's rings).
  const inside = (p: Vector2) => inPolygons(outline, p);
  const samples: { x: number; y: number; h: number }[] = [];
  for (const ring of outline) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 1e-9) {
        continue;
      }
      let [nx, ny] = [(b.y - a.y) / length, -(b.x - a.x) / length];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // Pointing out of it.
      if (inside({ x: mid.x + nx * 1.5, y: mid.y + ny * 1.5 })) {
        [nx, ny] = [-nx, -ny];
      }
      const n = Math.max(1, Math.round(length / step));
      for (let j = 0; j < n; j++) {
        const t = (j + 0.5) / n;
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        // Outward to the first zone (past a thin gap to it), or else the ground just past it: from right
        // by its outline, in small steps, so a thin zone beside it (a cliff's narrow top) isn't stepped over.
        let h = terrainAt(solid, { x: p.x + nx * 2, y: p.y + ny * 2 });
        for (let d = 1; d <= CLOTH_GAP * 2; d += 2) {
          const out = { x: p.x + nx * d, y: p.y + ny * d };
          const zone = solid.find((z) => z.contains(out));
          if (zone) {
            h = terrainAt([zone], out);
            break;
          }
        }
        samples.push({ x: p.x, y: p.y, h });
      }
    }
  }
  if (samples.length === 0) {
    return null;
  }
  const heights = samples.map((s) => s.h);
  const height = (Math.min(...heights) + Math.max(...heights)) / 2;
  return {
    height,
    rings,
    at: (point) => {
      let sum = 0;
      let weight = 0;
      for (const s of samples) {
        const d2 = (point.x - s.x) ** 2 + (point.y - s.y) ** 2;
        if (d2 < 1e-6) {
          return s.h;
        }
        const w = 1 / (d2 * Math.sqrt(d2));
        sum += w * s.h;
        weight += w;
      }
      return sum / weight;
    },
  };
}
