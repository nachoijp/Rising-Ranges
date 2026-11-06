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
//
// As Owlbear has it: the fog shapes one over another, the topmost winning —
// a shape covers, a cut one (hidden: the GM's reveal) takes the fog under it
// away — over the whole scene covered (filled) or nothing.

/** Whether a scene point is under the fog. */
export type FogAt = (x: number, y: number) => boolean;

/** A fog shape's outline, and whether it's cut (takes the fog under it away) rather than covering. */
export type FogLayer = { ring: Point[]; cut: boolean };

/**
 * What a light clears of the fog: its outline and holes (`rings`, scene
 * px), and the light, for its soft edge (see VistazoView.drawFog): where
 * it is, its reach, the part of it that fades out (`soft`: 0 sharp, 1 from
 * its middle), and its cone if it has one (its middle, and the half-angles
 * it's whole within and fades out by, radians; angles from straight right,
 * clockwise on screen).
 */
export type LitArea = {
  rings: Point[][];
  light: { x: number; y: number; radius: number; soft: number; cone: { middle: number; inner: number; outer: number } | null };
};

/**
 * The fog worked out: `at` to ask a point, and what to draw it with — the
 * whole scene (`filled`) or nothing, then `layers` bottom to top, less the
 * `lit` areas, in `color`.
 */
export type Fog = { at: FogAt; filled: boolean; layers: FogLayer[]; lit: LitArea[]; color: string };

const closed = (ring: Point[]): Point[] => [...ring, ring[0]];
const unionOf = (rings: Point[][]): MultiPolygon =>
  rings.length === 0 ? [] : polygonClipping.union([[closed(rings[0])]], ...rings.slice(1).map((ring): MultiPolygon => [[closed(ring)]]));

/** What of `world` is under the fog (for its curtains: see VistazoView.buildFogFloor). null if it can't be worked out. */
export function foggedOf(fog: Pick<Fog, "filled" | "layers" | "lit">, world: MultiPolygon): MultiPolygon | null {
  try {
    let fogged: MultiPolygon = fog.filled ? world : [];
    for (const { ring, cut } of fog.layers) {
      const shape: MultiPolygon = [[closed(ring)]];
      if (cut) {
        fogged = fogged.length > 0 ? polygonClipping.difference(fogged, shape) : fogged;
      } else {
        fogged = fogged.length > 0 ? polygonClipping.union(fogged, shape) : shape;
      }
    }
    const lit: MultiPolygon =
      fog.lit.length === 0 ? [] : polygonClipping.union([fog.lit[0].rings.map(closed)], ...fog.lit.slice(1).map((area): MultiPolygon => [area.rings.map(closed)]));
    if (fogged.length > 0 && lit.length > 0) {
      fogged = polygonClipping.difference(fogged, lit);
    }
    return fogged.length > 0 ? polygonClipping.intersection(fogged, world) : [];
  } catch (error) {
    console.error("Rising Ranges: 3D Glance couldn't work out what the fog covers", error);
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

/**
 * A token moved from `from` toward `to` as Owlbear's dynamic fog lets it: up to
 * the first wall in the way that blocks (a closed door does; an open one, no),
 * `gap` (scene px) short of it. The walls: the scene's and this client's own.
 */
export function stopAtWalls(from: { x: number; y: number }, to: { x: number; y: number }, items: Item[], local: Item[], gap: number): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) {
    return to;
  }
  const walls = [...items, ...local].filter(isWall);
  if (walls.length === 0) {
    return to;
  }
  let first = Infinity;
  for (const segment of blockingSegments(walls)) {
    first = Math.min(first, hit(from.x, from.y, dx / length, dy / length, segment));
  }
  if (first > length) {
    return to;
  }
  const reach = Math.max(0, first - gap);
  return { x: from.x + (dx / length) * reach, y: from.y + (dy / length) * reach };
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
 * scene's items and this client's local ones. A hidden fog shape is a cut
 * one (the GM's reveal); hidden lights don't count.
 */
export function fogOver(filled: boolean, items: Item[], local: Item[], color = "#222222"): Fog {
  const all = [...items, ...local];
  const layers: FogLayer[] = items
    .filter((item) => item.layer === "FOG" && (isShape(item) || isCurve(item) || isPath(item)))
    .sort((a, b) => a.zIndex - b.zIndex)
    .flatMap((item) => itemOutline(item).map((ring) => ({ ring, cut: !item.visible })));
  const segments = blockingSegments(all.filter(isWall));
  const lights = all.filter(isLight).filter((light) => light.visible && light.attenuationRadius > 0);
  const lit: LitArea[] = [];
  // Primary and auxiliary lights clear what they light, as far as the walls let them.
  for (const light of lights) {
    if (light.lightType !== "SECONDARY") {
      lit.push({ rings: [litArea(light, segments)], light: lightOf(light) });
    }
  }
  // A secondary one (a campfire) only what of that a primary light sees: in its line of sight (its
  // cone's, if it's one), however far (not an auxiliary's).
  const secondary = lights.filter((light) => light.lightType === "SECONDARY");
  const seers = lights.filter((light) => light.lightType !== "SECONDARY" && light.lightType !== "AUXILIARY");
  if (secondary.length > 0 && seers.length > 0) {
    try {
      const seen = unionOf(seers.map((light) => litArea({ ...light, attenuationRadius: SIGHT }, segments)));
      for (const light of secondary) {
        const own: MultiPolygon = [[closed(litArea(light, segments))]];
        for (const polygon of seen.length > 0 ? polygonClipping.intersection(own, seen) : []) {
          lit.push({ rings: polygon.map((ring) => ring.slice(0, -1)), light: lightOf(light) });
        }
      }
    } catch (error) {
      console.error("Rising Ranges: 3D Glance couldn't work out what the secondary lights clear", error);
    }
  }
  const at: FogAt = (x, y) => {
    // The topmost shape over the point says; none, the fill.
    let covered = filled;
    for (let i = layers.length - 1; i >= 0; i--) {
      if (inRing(x, y, layers[i].ring)) {
        covered = !layers[i].cut;
        break;
      }
    }
    if (!covered) {
      return false;
    }
    return !lit.some((area) => inRing(x, y, area.rings[0]) && !area.rings.slice(1).some((hole) => inRing(x, y, hole)));
  };
  return { at, filled, layers, lit, color };
}

/** The share of a light's reach each unit of its falloff fades (see lightOf). */
const FALLOFF_REACH = 0.25;

/** How far (scene px) a primary light's line of sight reaches, for the secondary lights it sees: past any map. */
const SIGHT = 1e6;

/**
 * A light's soft edge, as Owlbear's falloff draws it: the part of its reach that fades out (0 sharp, at
 * most all of it) — a quarter of it for each unit of falloff, as its map shows (falloff 1 fades the
 * last quarter, 1.5 the last three eighths; measured against Owlbear's own drawing, 2026-11); its cone's
 * half-angles, whole within the inner one, faded out by the outer.
 */
function lightOf(light: Light): LitArea["light"] {
  const cone = light.outerAngle > 0 && light.outerAngle < 360;
  return {
    x: light.position.x,
    y: light.position.y,
    radius: light.attenuationRadius,
    soft: Math.max(0, Math.min(1, light.falloff * FALLOFF_REACH)),
    cone: cone
      ? { middle: ((light.rotation - 90) * Math.PI) / 180, inner: (Math.min(light.innerAngle, light.outerAngle) * Math.PI) / 360, outer: (light.outerAngle * Math.PI) / 360 }
      : null,
  };
}
