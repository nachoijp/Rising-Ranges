import { isCurve, type Image, type Item } from "@owlbear-rodeo/sdk";
import { anchorOf, sceneToCell } from "../anchor";
import { itemOutline } from "../../terrain/terrain";
import type { DoorLink, Pt } from "../types";

// The plan of a map's walls read from the fog the room already has, in the
// relief's cells (see trace/uvtt.ts, which makes the relief of it):
//
//  - Smoke & Spectre!: its vision lines (curves on the Pointer layer, hidden),
//    the doors among them marked so. Lines, as a .uvtt's: walls and portals.
//  - Owlbear's own fog: shapes on the Fog layer. Its "Forecast" outlines each
//    room, the rooms fitting edge to edge along the walls' middles, so the
//    outlines are the walls' lines — but every edge, a wall or not: where
//    one room runs on into the next, the picture says (`openings`). Fog drawn
//    by hand is lines the same; what it covers may be rock (see solids.ts).
//    Doors put on a fog shape's edge (Owlbear's dynamic fog) are ways through.
//
// The edges along the map's own border are left out: they're its edge, not a wall.

export const SMOKE = "com.battle-system.smoke/";
const FORECAST = "rodeo.owlbear.forecast-item";
export const DOORS = "rodeo.owlbear.dynamic-fog/doors";

export type { PlanDoor } from "./doors";
import type { PlanDoor } from "./doors";

/**
 * A plan of lines (cells), and whether its edges may be open (to be told by
 * the picture); `rooms`: outlines that are rooms whatever the picture shows
 * (Owlbear's Forecast's); `doors`: its doors, each whole (the portals are
 * their pieces, as lines).
 */
export type FogPlan = { source: "smoke" | "obr"; walls: Pt[][]; portals: [Pt, Pt][]; openings: boolean; rooms: Pt[][]; doors: PlanDoor[] };

/** A point of the item's own coordinates where it's drawn: position + R(rotation)·(scale·local). */
function toScene(item: Item, p: { x: number; y: number }): [number, number] {
  const angle = (item.rotation * Math.PI) / 180;
  const x = p.x * item.scale.x, y = p.y * item.scale.y;
  return [item.position.x + x * Math.cos(angle) - y * Math.sin(angle), item.position.y + x * Math.sin(angle) + y * Math.cos(angle)];
}

/** What fog the scene has to make a plan of, each a plan (empty: none). */
export function fogPlans(items: Item[], image: Image, dpi: number, w: number, h: number): FogPlan[] {
  const anchor = anchorOf(image);
  const cell = (p: [number, number]): Pt => sceneToCell(anchor, dpi, p[0], p[1]);
  const plans: FogPlan[] = [];

  // Smoke & Spectre!'s lines.
  const walls: Pt[][] = [];
  const portals: [Pt, Pt][] = [];
  const smokeDoors: PlanDoor[] = [];
  for (const item of items) {
    if (!isCurve(item) || item.metadata[`${SMOKE}isVisionLine`] !== true || item.points.length < 2) continue;
    const line = item.points.map((p) => cell(toScene(item, p)));
    if (item.style.closed) line.push(line[0]);
    if (item.metadata[`${SMOKE}isDoor`] === true) {
      for (let i = 1; i < line.length; i++) portals.push([line[i - 1], line[i]]);
      smokeDoors.push({ a: line[0], b: line[line.length - 1], link: { kind: "smoke", item: item.id } });
    } else {
      walls.push(line);
    }
  }
  if (walls.length) plans.push({ source: "smoke", walls, portals, openings: false, rooms: [], doors: smokeDoors });

  // Owlbear's fog shapes: every edge of their outlines (round rooms' made arcs).
  const rings: Pt[][] = [];
  const forecast: Pt[][] = [];
  const doors: [Pt, Pt][] = [];
  const fogDoors: PlanDoor[] = [];
  for (const item of items) {
    if (item.layer !== "FOG" || !("style" in item)) continue;
    const outline = itemOutline(item);
    for (const ring of outline) {
      const pts = ring.map(cell);
      rings.push(pts);
      // Forecast's own (it marks what it made): a room. One drawn by hand may be rock: the picture tells.
      if (FORECAST in item.metadata) forecast.push(pts);
    }
    // Its doors: stretches of its outline, by distance along it from its first corner (the item's own px).
    const own = Math.sqrt(Math.abs(item.scale.x * item.scale.y)) || 1;
    for (const door of doorsOf(item.metadata[DOORS])) {
      const ring = outline[door.index];
      if (!ring) continue;
      const line = stretchOf(ring, door.from * own, door.to * own).map(cell);
      if (line.length < 2) continue;
      for (let i = 1; i < line.length; i++) doors.push([line[i - 1], line[i]]);
      fogDoors.push({ a: line[0], b: line[line.length - 1], link: { kind: "obr", item: item.id, index: door.at } });
    }
  }
  const circles = rings.map(roundFit).filter((c): c is Circle => !!c);
  // Every corner on a round room's circle put right on it: the straight edges that meet its arcs meet them exactly.
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const c = circles.find((c) => onCircle(ring[i], c));
      if (c) {
        const d = Math.hypot(ring[i][0] - c.x, ring[i][1] - c.y) || 1;
        ring[i] = [c.x + ((ring[i][0] - c.x) * c.r) / d, c.y + ((ring[i][1] - c.y) * c.r) / d];
      }
    }
  }
  const edges: Pt[][] = [];
  const onBorder = (a: Pt, b: Pt) => {
    const E = 0.1;
    return (
      (Math.abs(a[0]) < E && Math.abs(b[0]) < E) ||
      (Math.abs(a[1]) < E && Math.abs(b[1]) < E) ||
      (Math.abs(a[0] - w) < E && Math.abs(b[0] - w) < E) ||
      (Math.abs(a[1] - h) < E && Math.abs(b[1] - h) < E)
    );
  };
  for (const pts of rings) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6 && !onBorder(a, b)) edges.push(arcOf(a, b, circles));
    }
  }
  if (edges.length) plans.push({ source: "obr", walls: edges, portals: doors, openings: true, rooms: forecast, doors: fogDoors });
  return plans;
}

// ---------- Doors ----------

/** Owlbear's doors on a fog shape (its metadata), as stretches of one of its outlines (`index`): from, to (px along it); `at`: which door it is. */
function doorsOf(meta: unknown): { at: number; index: number; from: number; to: number }[] {
  if (!Array.isArray(meta)) return [];
  const out: { at: number; index: number; from: number; to: number }[] = [];
  (meta as { start?: { distance?: unknown; index?: unknown }; end?: { distance?: unknown } }[]).forEach((d, at) => {
    const a = d?.start?.distance, b = d?.end?.distance, index = d?.start?.index ?? 0;
    if (typeof a === "number" && typeof b === "number" && typeof index === "number" && Number.isFinite(a) && Number.isFinite(b)) {
      out.push({ at, index, from: Math.min(a, b), to: Math.max(a, b) });
    }
  });
  return out;
}

/** Whether a fog door is open: Owlbear's (its fog shape's doors) or Smoke & Spectre!'s (its line). Undefined: it isn't there. */
export function fogDoorOpen(link: DoorLink, items: Item[]): boolean | undefined {
  const item = items.find((i) => i.id === link.item);
  if (!item) return undefined;
  if (link.kind === "smoke") return item.metadata[`${SMOKE}doorOpen`] === true;
  const doors = item.metadata[DOORS];
  if (!Array.isArray(doors) || !doors[link.index]) return undefined;
  return (doors[link.index] as { open?: unknown }).open === true;
}


/** The stretch of a closed outline from `from` to `to` along it (from its first corner; past its length, round again). */
function stretchOf(ring: [number, number][], from: number, to: number): [number, number][] {
  const n = ring.length;
  const len = (i: number) => Math.hypot(ring[(i + 1) % n][0] - ring[i][0], ring[(i + 1) % n][1] - ring[i][1]);
  let total = 0;
  for (let i = 0; i < n; i++) total += len(i);
  if (total <= 0) return [];
  const at = (s: number): { p: [number, number]; i: number } => {
    let d = ((s % total) + total) % total;
    for (let i = 0; i < n; i++) {
      const l = len(i);
      if (d <= l || i === n - 1) {
        const t = l ? Math.min(1, d / l) : 0, a = ring[i], b = ring[(i + 1) % n];
        return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], i };
      }
      d -= l;
    }
    return { p: ring[0], i: 0 };
  };
  const start = at(from), end = at(to);
  const out: [number, number][] = [start.p];
  // The corners between, going round from the start's side to the end's.
  for (let i = start.i, guard = 0; i !== end.i && guard < n; i = (i + 1) % n, guard++) out.push(ring[(i + 1) % n]);
  out.push(end.p);
  return out;
}

// ---------- Round rooms ----------

/** A circle (cells). */
type Circle = { x: number; y: number; r: number };

/** How far off its circle (of its radius) a round room's outline may be, and its least corners. */
const ROUND_SPREAD = 0.08;
const ROUND_CORNERS = 7;
/** Degrees between an arc's points. */
const ARC_STEP = 7.5;

/** The circle an outline nearly is (a tower Forecast drew as an octagon or so), or null. */
export function roundFit(ring: Pt[]): Circle | null {
  if (ring.length < ROUND_CORNERS) return null;
  // Least squares (Kåsa): x² + y² + Dx + Ey + F = 0, about the mean for steadiness.
  const mx = ring.reduce((s, p) => s + p[0], 0) / ring.length, my = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const [px, py] of ring) {
    const u = px - mx, v = py - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-12) return null;
  const bu = (suuu + suvv) / 2, bv = (svvv + svuu) / 2;
  const uc = (bu * svv - bv * suv) / det, vc = (bv * suu - bu * suv) / det;
  const x = uc + mx, y = vc + my;
  const d = ring.map((p) => Math.hypot(p[0] - x, p[1] - y));
  const r = d.reduce((s, v) => s + v, 0) / d.length;
  const sd = Math.sqrt(d.reduce((s, v) => s + (v - r) ** 2, 0) / d.length);
  // Its corners all round it (not a few bunched on one side of a bigger outline).
  const turns = ring.map((p) => Math.atan2(p[1] - y, p[0] - x)).sort((a, b) => a - b);
  let gap = 2 * Math.PI - (turns[turns.length - 1] - turns[0]);
  for (let i = 1; i < turns.length; i++) gap = Math.max(gap, turns[i] - turns[i - 1]);
  return r > 0.4 && sd / r <= ROUND_SPREAD && gap < Math.PI / 2 ? { x, y, r } : null;
}

/** Whether a corner is on a circle (near enough). */
const onCircle = (p: Pt, c: Circle) => Math.abs(Math.hypot(p[0] - c.x, p[1] - c.y) - c.r) < 0.12 * c.r;

/**
 * An edge whose ends are both on a round room's circle, as that circle's arc
 * (the short way round); else the edge. The arc's points are at whole steps
 * of angle, so the room on its other side gets the very same points.
 */
function arcOf(a: Pt, b: Pt, circles: Circle[]): Pt[] {
  for (const c of circles) {
    if (!onCircle(a, c) || !onCircle(b, c)) continue;
    const step = (ARC_STEP * Math.PI) / 180;
    const ta = Math.atan2(a[1] - c.y, a[0] - c.x);
    let tb = Math.atan2(b[1] - c.y, b[0] - c.x);
    while (tb - ta > Math.PI) tb -= 2 * Math.PI;
    while (tb - ta < -Math.PI) tb += 2 * Math.PI;
    const at = (t: number): Pt => [c.x + c.r * Math.cos(t), c.y + c.r * Math.sin(t)];
    const out: Pt[] = [at(ta)];
    const lo = Math.min(ta, tb), hi = Math.max(ta, tb);
    const mid: Pt[] = [];
    for (let k = Math.floor(lo / step) + 1; k * step < hi - 1e-6; k++) mid.push(at(k * step));
    if (tb < ta) mid.reverse();
    out.push(...mid, at(tb));
    return out;
  }
  return [a, b];
}
