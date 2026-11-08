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
    // The shapes' part, the same while only lights move (often: a token dragged): kept.
    const key = `${fog.filled}|${fog.layers.map(({ ring, cut }) => `${cut ? "-" : "+"}${ring.join(" ")}`).join("|")}`;
    if (shapesFogged?.key !== key || shapesFogged.world !== world) {
      let fogged: MultiPolygon = fog.filled ? world : [];
      for (const { ring, cut } of fog.layers) {
        const shape: MultiPolygon = [[closed(ring)]];
        if (cut) {
          fogged = fogged.length > 0 ? polygonClipping.difference(fogged, shape) : fogged;
        } else {
          fogged = fogged.length > 0 ? polygonClipping.union(fogged, shape) : shape;
        }
      }
      shapesFogged = { key, world, fogged: fogged.length > 0 ? polygonClipping.intersection(fogged, world) : [] };
    }
    const fogged = shapesFogged.fogged;
    if (fogged.length === 0 || fog.lit.length === 0) {
      return fogged;
    }
    const lit: MultiPolygon = polygonClipping.union([fog.lit[0].rings.map(closed)], ...fog.lit.slice(1).map((area): MultiPolygon => [area.rings.map(closed)]));
    return lit.length > 0 ? polygonClipping.difference(fogged, lit) : fogged;
  } catch (error) {
    console.error("Rising Ranges: 3D Glance couldn't work out what the fog covers", error);
    return null;
  }
}

/** The last fog shapes' part of foggedOf, for the world it was worked out in. */
let shapesFogged: { key: string; world: MultiPolygon; fogged: MultiPolygon } | null = null;

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

type Box = [number, number, number, number];

function boxOf(ring: Point[]): Box {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

const inBox = (x: number, y: number, [x0, y0, x1, y1]: Box) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

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
  // Many walls: each ray asks only those on the cells it crosses, nearest first (see SegmentGrid).
  const grid = near.length > GRID_FROM ? new SegmentGrid(near, cx, cy) : null;
  for (const a of sorted) {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let reach = radius;
    if (grid) {
      reach = grid.cast(cx, cy, dx, dy, radius);
    } else {
      for (const segment of near) {
        reach = Math.min(reach, hit(cx, cy, dx, dy, segment));
      }
    }
    area.push([cx + dx * reach, cy + dy * reach]);
  }
  return area;
}

/** How many walls in reach before a light's rays go by a grid (see SegmentGrid): fewer, each ray asks them all. */
const GRID_FROM = 48;

/**
 * Walls on a grid of squares (each in every square it crosses), for rays from a point: a ray walks the
 * squares it crosses from there, nearest first, asking only their walls, and stops once the nearest it
 * met is before the square's far side (nothing further can be nearer).
 */
class SegmentGrid {
  private readonly x0: number;
  private readonly y0: number;
  private readonly size: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: number[][];
  /** Which ray last asked each wall (one asked once a ray, however many squares it's in). */
  private readonly asked: Uint32Array;
  private ray = 0;

  constructor(private readonly segments: Segment[], cx: number, cy: number) {
    let [x0, y0, x1, y1] = [cx, cy, cx, cy];
    for (const [ax, ay, bx, by] of segments) {
      x0 = Math.min(x0, ax, bx);
      y0 = Math.min(y0, ay, by);
      x1 = Math.max(x1, ax, bx);
      y1 = Math.max(y1, ay, by);
    }
    const side = Math.max(1, Math.min(128, Math.ceil(Math.sqrt(segments.length) * 2)));
    this.size = Math.max(x1 - x0, y1 - y0, 1) / side;
    [this.x0, this.y0] = [x0, y0];
    this.cols = Math.max(1, Math.ceil((x1 - x0) / this.size) + 1);
    this.rows = Math.max(1, Math.ceil((y1 - y0) / this.size) + 1);
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
    this.asked = new Uint32Array(segments.length);
    segments.forEach(([ax, ay, bx, by], k) => {
      // Each square its box reaches (a few extra for a slanting wall: asked, never wrong).
      const [c0, c1] = [this.col(Math.min(ax, bx)), this.col(Math.max(ax, bx))];
      const [r0, r1] = [this.row(Math.min(ay, by)), this.row(Math.max(ay, by))];
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          this.cells[r * this.cols + c].push(k);
        }
      }
    });
  }

  private col(x: number) {
    return Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.x0) / this.size)));
  }

  private row(y: number) {
    return Math.max(0, Math.min(this.rows - 1, Math.floor((y - this.y0) / this.size)));
  }

  /** How far a ray from (cx, cy) going (dx, dy) gets before a wall, at most `radius`. */
  cast(cx: number, cy: number, dx: number, dy: number, radius: number): number {
    const ray = ++this.ray;
    let [c, r] = [this.col(cx), this.row(cy)];
    const [stepC, stepR] = [dx > 0 ? 1 : -1, dy > 0 ? 1 : -1];
    // How far along the ray to the next column's and row's line, and between lines.
    const nextX = this.x0 + (c + (dx > 0 ? 1 : 0)) * this.size;
    const nextY = this.y0 + (r + (dy > 0 ? 1 : 0)) * this.size;
    let tX = Math.abs(dx) < 1e-12 ? Infinity : (nextX - cx) / dx;
    let tY = Math.abs(dy) < 1e-12 ? Infinity : (nextY - cy) / dy;
    const [dtX, dtY] = [Math.abs(dx) < 1e-12 ? Infinity : this.size / Math.abs(dx), Math.abs(dy) < 1e-12 ? Infinity : this.size / Math.abs(dy)];
    let best = radius;
    for (;;) {
      for (const k of this.cells[r * this.cols + c]) {
        if (this.asked[k] !== ray) {
          this.asked[k] = ray;
          const t = hit(cx, cy, dx, dy, this.segments[k]);
          if (t < best) {
            best = t;
          }
        }
      }
      const out = Math.min(tX, tY);
      // The nearest wall met is before this square's far side, or the reach is: done.
      if (best <= out || out >= radius) {
        return best;
      }
      if (tX < tY) {
        c += stepC;
        tX += dtX;
      } else {
        r += stepR;
        tY += dtY;
      }
      if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) {
        return best;
      }
    }
  }
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
  const walls = wallsKey(segments);
  const lights = all.filter(isLight).filter((light) => light.visible && light.attenuationRadius > 0);
  const lit: LitArea[] = [];
  // Primary and auxiliary lights clear what they light, as far as the walls let them.
  for (const light of lights) {
    if (light.lightType !== "SECONDARY") {
      lit.push({ rings: [litKept(light, segments, walls)], light: lightOf(light) });
    }
  }
  // A secondary one (a campfire) only what of that a primary light sees: in its line of sight (its
  // cone's, if it's one), however far (not an auxiliary's).
  const secondary = lights.filter((light) => light.lightType === "SECONDARY");
  const seers = lights.filter((light) => light.lightType !== "SECONDARY" && light.lightType !== "AUXILIARY");
  if (secondary.length > 0 && seers.length > 0) {
    try {
      // What the primary lights see, kept while they and the walls stay (see kept).
      const seenKey = `seen|${seers.map((light) => lightKey(light, SIGHT)).join(";")}|${walls}`;
      const seen = kept(seenKey, () => unionOf(seers.map((light) => litKept({ ...light, attenuationRadius: SIGHT }, segments, walls))));
      for (const light of secondary) {
        const parts = kept(`part|${lightKey(light)}|${seenKey}`, () => {
          const own: MultiPolygon = [[closed(litKept(light, segments, walls))]];
          return seen.length > 0 ? polygonClipping.intersection(own, seen) : [];
        });
        for (const polygon of parts) {
          lit.push({ rings: polygon.map((ring) => ring.slice(0, -1)), light: lightOf(light) });
        }
      }
    } catch (error) {
      console.error("Rising Ranges: 3D Glance couldn't work out what the secondary lights clear", error);
    }
  }
  // Each outline with its box: most points asked are nowhere near most outlines (asked often: the curtains).
  const layerBoxes = layers.map((layer) => boxOf(layer.ring));
  const litBoxes = lit.map((area) => area.rings.map(boxOf));
  const at: FogAt = (x, y) => {
    // The topmost shape over the point says; none, the fill.
    let covered = filled;
    for (let i = layers.length - 1; i >= 0; i--) {
      if (inBox(x, y, layerBoxes[i]) && inRing(x, y, layers[i].ring)) {
        covered = !layers[i].cut;
        break;
      }
    }
    if (!covered) {
      return false;
    }
    for (let k = 0; k < lit.length; k++) {
      const [boxes, rings] = [litBoxes[k], lit[k].rings];
      if (inBox(x, y, boxes[0]) && inRing(x, y, rings[0])) {
        let hole = false;
        for (let h = 1; h < rings.length && !hole; h++) {
          hole = inBox(x, y, boxes[h]) && inRing(x, y, rings[h]);
        }
        if (!hole) {
          return false;
        }
      }
    }
    return true;
  };
  return { at, filled, layers, lit, color };
}

/**
 * What's been worked out for the fog's lights, by what it depends on (see litKept): asked again for
 * every light whenever anything the fog depends on changes, and for every frame of a lit token's drag,
 * though only one light moved. The most recent few hundred kept.
 */
const keptLight = new Map<string, unknown>();

function kept<T>(key: string, make: () => T): T {
  if (keptLight.has(key)) {
    const value = keptLight.get(key) as T;
    // Most recent last (what's dropped is the oldest).
    keptLight.delete(key);
    keptLight.set(key, value);
    return value;
  }
  const value = make();
  keptLight.set(key, value);
  if (keptLight.size > KEPT_LIGHTS) {
    keptLight.delete(keptLight.keys().next().value!);
  }
  return value;
}

const KEPT_LIGHTS = 300;

/** A light as what its lit area depends on (where, how far, which way, how wide). */
function lightKey(light: Light, radius = light.attenuationRadius): string {
  return `${light.lightType}|${light.position.x},${light.position.y}|${radius}|${light.rotation}|${light.innerAngle}|${light.outerAngle}`;
}

/** The walls that block sight as a short key (a hash of their ends): the same walls, the same key. */
function wallsKey(segments: Segment[]): string {
  let h = 2166136261;
  for (const segment of segments) {
    for (const v of segment) {
      h = Math.imul(h ^ Math.round(v * 16), 16777619);
    }
  }
  return `${segments.length}:${(h >>> 0).toString(36)}`;
}

/** A light's lit area (see litArea), kept while it and the walls stay. */
function litKept(light: Light, segments: Segment[], walls: string): Point[] {
  return kept(`lit|${lightKey(light)}|${walls}`, () => litArea(light, segments));
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
