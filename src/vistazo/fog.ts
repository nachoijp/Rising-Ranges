import { isCurve, isLight, isPath, isShape, isWall, type Item, type Light, type Wall } from "@owlbear-rodeo/sdk";
import type { MultiPolygon } from "polygon-clipping";
import polygonClipping from "../terrain/clip";
import { itemOutline } from "../terrain/terrain";

// The fog as a player sees it, for the Vistazo's player view: Owlbear's
// own fog — shapes drawn on the Fog layer, or the whole scene when the fog
// is filled — less what the lights reveal, each light's reach cut short by
// the walls that block sight.
//
// The lights and walls are Owlbear's own items, in the scene (its Dynamic
// Fog) or local to this client: Smoke & Spectre! builds its per-player
// vision that way (local Light and Wall items, radius in scene px), so both
// are read alike. Explored areas (lights that have moved on) aren't kept.

/** Whether a scene point is under the fog. */
export type FogAt = (x: number, y: number) => boolean;

/**
 * The fog worked out: `at` to ask a point, and what to draw it with —
 * the whole scene (`filled`) or `shapes`, less the `lit` areas, in `color`.
 */
export type Fog = { at: FogAt; filled: boolean; shapes: Point[][]; lit: Point[][]; color: string };

const closed = (ring: Point[]): Point[] => [...ring, ring[0]];
const unionOf = (rings: Point[][]): MultiPolygon =>
  rings.length === 0 ? [] : polygonClipping.union([[closed(rings[0])]], ...rings.slice(1).map((ring): MultiPolygon => [[closed(ring)]]));

/**
 * What of `world` isn't under the fog (the lit areas, and outside the fog
 * shapes when it isn't filled): where the player view shows the terrain's
 * heights. null if it can't be worked out (then nothing's flattened).
 */
export function clearOf(fog: Fog, world: MultiPolygon): MultiPolygon | null {
  try {
    const lit = unionOf(fog.lit);
    if (fog.filled) {
      return lit.length > 0 ? polygonClipping.intersection(world, lit) : [];
    }
    const covered = unionOf(fog.shapes);
    const fogged = covered.length > 0 && lit.length > 0 ? polygonClipping.difference(covered, lit) : covered;
    return fogged.length > 0 ? polygonClipping.difference(world, fogged) : world;
  } catch (error) {
    console.error("Rising Ranges: Vistazo couldn't work out what the fog leaves clear", error);
    return null;
  }
}

type Point = [number, number];
type Segment = [number, number, number, number];

/** How many even directions every light's reach is drawn with, besides those toward walls' ends. */
const SWEEP = 96;

/** A point of an item's own coordinates where it is in the scene: position + R(rotation)·(scale·p). */
function toScene(item: Item, x: number, y: number): Point {
  const angle = (item.rotation * Math.PI) / 180;
  const sx = x * item.scale.x;
  const sy = y * item.scale.y;
  return [item.position.x + sx * Math.cos(angle) - sy * Math.sin(angle), item.position.y + sx * Math.sin(angle) + sy * Math.cos(angle)];
}

function inRing(x: number, y: number, ring: Point[]): boolean {
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

/** The walls that block sight, as segments in scene coordinates. */
function blockingSegments(walls: Wall[]): Segment[] {
  const segments: Segment[] = [];
  for (const wall of walls) {
    if (!wall.blocking || wall.points.length < 2) {
      continue;
    }
    const points = wall.points.map((p) => toScene(wall, p.x, p.y));
    for (let i = 0; i < points.length - 1; i++) {
      segments.push([points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]]);
    }
  }
  return segments;
}

/** How far along a ray (from c, direction d) it meets a segment, or Infinity. */
function hit(cx: number, cy: number, dx: number, dy: number, [ax, ay, bx, by]: Segment): number {
  const ex = bx - ax;
  const ey = by - ay;
  const denominator = dx * ey - dy * ex;
  if (Math.abs(denominator) < 1e-12) {
    return Infinity;
  }
  const t = ((ax - cx) * ey - (ay - cy) * ex) / denominator;
  const s = ((ax - cx) * dy - (ay - cy) * dx) / denominator;
  return t > 0 && s >= 0 && s <= 1 ? t : Infinity;
}

/**
 * What a light reveals: rays from it every way (and either side of each
 * wall end in reach), each stopped at the first wall or at its radius; a
 * cone, if it has one (`outerAngle` under 360°, turned with the light,
 * 0° pointing up the map), with the light itself as a corner.
 */
function litArea(light: Light, segments: Segment[]): Point[] {
  const cx = light.position.x;
  const cy = light.position.y;
  const radius = light.attenuationRadius;
  const near = segments.filter(([ax, ay, bx, by]) => {
    // Its distance from the light, against the radius.
    const ex = bx - ax;
    const ey = by - ay;
    const length = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((cx - ax) * ex + (cy - ay) * ey) / length));
    return Math.hypot(ax + ex * t - cx, ay + ey * t - cy) <= radius;
  });
  const cone = light.outerAngle > 0 && light.outerAngle < 360;
  // Angles from straight right, clockwise on screen (y down); the cone's middle is the light's turn, from up.
  const middle = ((light.rotation - 90) * Math.PI) / 180;
  const half = (light.outerAngle * Math.PI) / 360;
  const within = (a: number) => {
    if (!cone) {
      return true;
    }
    const off = Math.atan2(Math.sin(a - middle), Math.cos(a - middle));
    return Math.abs(off) <= half;
  };
  const angles: number[] = [];
  for (let i = 0; i < SWEEP; i++) {
    angles.push(cone ? middle - half + (2 * half * i) / (SWEEP - 1) : (i / SWEEP) * Math.PI * 2);
  }
  for (const [ax, ay, bx, by] of near) {
    for (const [x, y] of [[ax, ay], [bx, by]]) {
      const a = Math.atan2(y - cy, x - cx);
      for (const e of [-1e-4, 0, 1e-4]) {
        if (within(a + e)) {
          angles.push(a + e);
        }
      }
    }
  }
  const sorted = (cone ? angles.map((a) => middle + Math.atan2(Math.sin(a - middle), Math.cos(a - middle))) : angles.map((a) => (a + Math.PI * 4) % (Math.PI * 2))).sort((a, b) => a - b);
  const area: Point[] = cone ? [[cx, cy]] : [];
  for (const a of sorted) {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let reach = radius;
    for (const segment of near) {
      reach = Math.min(reach, hit(cx, cy, dx, dy, segment));
    }
    area.push([cx + dx * reach, cy + dy * reach]);
  }
  return area;
}

/**
 * The fog over the scene now: `filled` (Owlbear's fog setting), the
 * scene's items and this client's local ones. Hidden fog shapes (the GM's
 * reveal) and hidden lights don't count.
 */
export function fogOver(filled: boolean, items: Item[], local: Item[], color = "#222222"): Fog {
  const all = [...items, ...local];
  const shapes = items
    .filter((item) => item.layer === "FOG" && item.visible && (isShape(item) || isCurve(item) || isPath(item)))
    .flatMap((item) => itemOutline(item));
  const segments = blockingSegments(all.filter(isWall));
  const lights = all
    .filter(isLight)
    .filter((light) => light.visible && light.attenuationRadius > 0)
    .map((light) => ({ x: light.position.x, y: light.position.y, radius: light.attenuationRadius, area: litArea(light, segments) }));
  const at: FogAt = (x, y) => {
    const covered = filled || shapes.some((ring) => inRing(x, y, ring));
    if (!covered) {
      return false;
    }
    return !lights.some((light) => Math.hypot(x - light.x, y - light.y) <= light.radius && inRing(x, y, light.area));
  };
  return { at, filled, shapes, lit: lights.map((light) => light.area), color };
}
