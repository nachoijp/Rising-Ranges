import { inShape } from "./geom";
import { Relief } from "./relief";
import { DOOR_H } from "./trace/doors";
import type { Door, Pt, ReliefData, Shape } from "./types";

// A relief's doors cut through its walls (see types.ts Door): the wall runs
// on over a door, as drawn; worked out for the scene (the Vistazo, the
// heights measured), never kept, the wall over each open doorway is taken
// down to its floor as far as the opening's height, and what's left over it
// (the lintel) is a slab of the wall's own look. Its jambs, its lintel's
// faces and underside, its level lines: the wall's, drawn as any are. A
// door left shut (a secret one, to a player) isn't cut: it's the wall.

/** How far across a door (cells) a wall is looked for, the steps it's looked in, and a drop that's its face. */
const REACH = 2;
const STEP = 0.02;
const DROP = 0.25;
/** A hair more than the wall's faces (cells), so nothing of them is left in the doorway. */
const MARGIN = 0.02;

/** A door's opening, worked out from the wall it's in: its outline (cells), its floor, its top and the wall's (grid units), the wall's shape; where its map is read (see Doorway). */
export type DoorOpening = { ring: Pt[]; floor: number; top: number; wallTop: number; wall: Shape | undefined; doorway: Doorway };

/**
 * Where the map is read for a doorway (cells): the map there is its
 * threshold, not its wall, so what's in it (its jambs, its lintel, its
 * top) reads it all at one point (`read`), in the wall just past a jamb:
 * one colour, the wall's. It: `o` its hinge's end, `u` along it `len` long,
 * `n` across it, the wall's faces `p` and `m` away.
 */
export type Doorway = { o: Pt; u: Pt; n: Pt; len: number; p: number; m: number; read: Pt; top: number };

/** How far past a jamb (cells) a doorway's colour is read; how far off the wall's faces its walls read it (theirs a little out from them). */
const READ_PAST = 0.5;
const READ_OFF = 0.35;

/** Whether a point (cells) reads its doorway's colour: between its ends, and the wall's faces (a little more). */
function within(d: Doorway, x: number, y: number): boolean {
  const [dx, dy] = [x - d.o[0], y - d.o[1]];
  const along = dx * d.u[0] + dy * d.u[1];
  const across = dx * d.n[0] + dy * d.n[1];
  return along >= -1e-6 && along <= d.len + 1e-6 && across >= -d.m - READ_OFF && across <= d.p + READ_OFF;
}

/** The top of the wall a doorway's cut through, where a point (cells) is in one (between its ends and the wall's faces); none elsewhere. */
export function doorwayTop(doorways: Doorway[], x: number, y: number): number | undefined {
  for (const d of doorways) {
    const [dx, dy] = [x - d.o[0], y - d.o[1]];
    const along = dx * d.u[0] + dy * d.u[1];
    const across = dx * d.n[0] + dy * d.n[1];
    if (along >= 0 && along <= d.len && across >= -d.m && across <= d.p) return d.top;
  }
  return undefined;
}

/** Where the map's read for a point (cells): in a doorway, at its one point; elsewhere, where it is. */
export function readAt(doorways: Doorway[], x: number, y: number): Pt {
  const d = doorways.find((w) => within(w, x, y));
  return d ? d.read : [x, y];
}

/** Where a door cuts through its wall; none if there's no wall where it is (a doorway left in it already). */
export function doorOpening(relief: Relief, door: Door): DoorOpening | null {
  const [a, b] = [door.a, door.b];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 1e-6) {
    return null;
  }
  const [nx, ny] = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
  const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const wallTop = relief.heightAt(mx, my);
  if (wallTop === undefined) {
    return null;
  }
  // Each side: the wall's face (where it drops), and the floor past it.
  const side = (s: number): { face: number; floor: number } | null => {
    for (let d = STEP; d <= REACH; d += STEP) {
      const h = relief.heightAt(mx + nx * d * s, my + ny * d * s);
      if (h !== undefined && h < wallTop - DROP) {
        const past = relief.heightAt(mx + nx * (d + DROP) * s, my + ny * (d + DROP) * s) ?? h;
        return { face: d, floor: Math.min(h, past) };
      }
    }
    return null;
  };
  const [plus, minus] = [side(1), side(-1)];
  if (!plus || !minus) {
    return null;
  }
  const floor = Math.max(plus.floor, minus.floor);
  if (wallTop - floor < DROP) {
    return null;
  }
  const top = Math.min(wallTop, floor + (door.h ?? DOOR_H));
  const [p, m] = [plus.face + MARGIN, minus.face + MARGIN];
  const ring: Pt[] = [
    [a[0] + nx * p, a[1] + ny * p],
    [b[0] + nx * p, b[1] + ny * p],
    [b[0] - nx * m, b[1] - ny * m],
    [a[0] - nx * m, a[1] - ny * m],
  ];
  // The wall's own shape: the topmost (not a slab) there.
  const layer = [...relief.layers].reverse().find((l) => inShape(mx, my, l.ring, l.holes));
  // Its colour: the wall's, just past its hinge's jamb (or its other one, if the wall runs on there and not there), mid-thickness.
  const [ux, uy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const mid = (plus.face - minus.face) / 2;
  const past = (from: Pt, s: number): Pt => [from[0] + ux * READ_PAST * s + nx * mid, from[1] + uy * READ_PAST * s + ny * mid];
  const [ra, rb] = [past(a, -1), past(b, 1)];
  const off = (q: Pt) => Math.abs((relief.heightAt(q[0], q[1]) ?? -Infinity) - wallTop);
  const doorway: Doorway = { o: [a[0], a[1]], u: [ux, uy], n: [nx, ny], len, p, m, read: off(ra) <= off(rb) ? ra : rb, top: wallTop };
  return { ring, floor, top, wallTop, wall: layer ? relief.data.shapes[layer.si] : undefined, doorway };
}

/**
 * The relief with its doors cut (those `shut` says aren't left as wall), a
 * relief of its own; itself if none is. Its shapes are the relief's, the
 * cuts after them (so the relief's own are numbered as they are).
 */
export function cutDoors(relief: Relief, shut: (door: Door, i: number) => boolean = () => false): Relief {
  const doors = relief.data.doors ?? [];
  const openings = doors.map((door, i) => (shut(door, i) ? null : doorOpening(relief, door))).filter((o): o is DoorOpening => o !== null);
  if (openings.length === 0) {
    return relief;
  }
  const data = relief.data;
  const verts = [...data.verts];
  const shapes = [...data.shapes];
  const ringOf = (ring: Pt[]) =>
    ring.map(([x, y]) => {
      verts.push({ x, y, h: 0 });
      return verts.length - 1;
    });
  for (const o of openings) {
    shapes.push({ kind: "flat", h: o.floor, rel: false, ring: ringOf(o.ring) });
    if (o.wallTop - o.top > 0.01) {
      // Over the doorway, the rest of the wall: a slab with the wall's look.
      const w = o.wall;
      shapes.push({
        kind: "flat",
        h: o.wallTop,
        rel: false,
        slab: o.wallTop - o.top,
        ring: ringOf(o.ring),
        ...(w?.wall ? { wall: w.wall } : {}),
        ...(w?.skin ? { skin: w.skin } : {}),
      });
    }
  }
  // Sharing what the relief has worked out (its shapes' pieces, outlines): most shapes are the same.
  const cut = new Relief({ ...data, verts, shapes } as ReliefData, relief);
  doorways.set(cut, openings.map((o) => o.doorway));
  return cut;
}

const doorways = new WeakMap<Relief, Doorway[]>();

/** A relief's doorways cut (see cutDoors): none if it isn't one cut. */
export const doorwaysOf = (relief: Relief): Doorway[] => doorways.get(relief) ?? [];

/** A cut relief kept for each relief, while what it's cut by is the same. */
const kept = new WeakMap<Relief, { key: string; cut: Relief }>();

/** cutDoors, kept: worked out again only when the relief changes or which doors are shut does. */
export function cutDoorsKept(relief: Relief, shut: (door: Door, i: number) => boolean = () => false): Relief {
  if (!relief.data.doors?.length) {
    return relief;
  }
  const key = `${relief.version}|${JSON.stringify(relief.data.doors)}|${relief.data.doors.map((d, i) => (shut(d, i) ? 1 : 0)).join("")}`;
  const had = kept.get(relief);
  if (had?.key === key) {
    return had.cut;
  }
  const cut = cutDoors(relief, shut);
  kept.set(relief, { key, cut });
  return cut;
}
