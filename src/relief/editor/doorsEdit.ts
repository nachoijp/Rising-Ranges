import type { Door, Pt } from "../types";
import { DOOR_H, fogDoorNear, openingFor, sameLink } from "../trace/doors";
import type { Mods, ReliefEditor } from "./editor";

// The relief's doors in the editor (see types.ts Door): drawn with the door
// tool from hinge to end, picked and dragged (whole, or by an end) with any
// tool once picked, linked to the fog door they're drawn on. A door isn't
// terrain: changing one works nothing out again (see ReliefEditor.doorsChanged).

/** The shortest door (cells), and how far past its ends the wall round it is read (for its height). */
const DOOR_MIN = 0.3;
const WALL_PROBE = 0.3;
/** How far across a door (cells) the floor beside it is read. */
const FLOOR_PROBE = 0.75;
/** The turn a door drawn by hand swings by. */
const SWING = 90;

export const doorsOf = (ed: ReliefEditor): Door[] => ed.data.doors ?? [];

/** A point's distance (cells) to a segment. */
function segDist(p: { x: number; y: number }, a: Pt, b: Pt): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a[0] + dx * t), p.y - (a[1] + dy * t));
}

/** The door whose line is under a point (the picked one first); -1: none. */
export function doorAt(ed: ReliefEditor, p: { x: number; y: number }): number {
  const doors = doorsOf(ed);
  const reach = ed.host.snapReach();
  const picked = ed.sel?.kind === "door" ? ed.sel.i : -1;
  if (picked >= 0 && doors[picked] && segDist(p, doors[picked].a, doors[picked].b) < reach) {
    return picked;
  }
  let best = -1;
  let bestD = reach;
  doors.forEach((d, i) => {
    const dist = segDist(p, d.a, d.b);
    if (dist < bestD) {
      bestD = dist;
      best = i;
    }
  });
  return best;
}

/** The picked door's end under the pointer (its hinge `a`, or `b`), or null. */
export function doorEndAt(ed: ReliefEditor, p: { x: number; y: number }): "a" | "b" | null {
  const d = ed.sel?.kind === "door" ? doorsOf(ed)[ed.sel.i] : undefined;
  if (!d) {
    return null;
  }
  const reach = ed.host.snapReach() * 1.2;
  for (const end of ["b", "a"] as const) {
    if (Math.hypot(d[end][0] - p.x, d[end][1] - p.y) < reach) {
      return end;
    }
  }
  return null;
}

/** A point dragged to, on the grid; Shift: from `from` in steps of 15 degrees. */
export function doorPoint(ed: ReliefEditor, from: Pt, p: { x: number; y: number }, mods: Mods): Pt {
  const q = ed.gridded(p);
  if (!mods.shift) {
    return [q.x, q.y];
  }
  const step = Math.PI / 12;
  const [dx, dy] = [p.x - from[0], p.y - from[1]];
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const len = Math.hypot(dx, dy);
  return [from[0] + Math.cos(angle) * len, from[1] + Math.sin(angle) * len];
}

/** How high the wall a door's drawn on is (over the floor beside it, across it either way): none, no wall there. */
function wallHeight(ed: ReliefEditor, a: Pt, b: Pt): number | undefined {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const [ux, uy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const [nx, ny] = [-uy, ux];
  const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const at = (x: number, y: number) => ed.heightAt(x, y) ?? -Infinity;
  // Its top: in the doorway (the wall runs on over it), or just past its ends (a gap left in it).
  const top = Math.max(at(mx, my), at(a[0] - ux * WALL_PROBE, a[1] - uy * WALL_PROBE), at(b[0] + ux * WALL_PROBE, b[1] + uy * WALL_PROBE));
  const floor = Math.min(ed.heightAt(mx + nx * FLOOR_PROBE, my + ny * FLOOR_PROBE) ?? 0, ed.heightAt(mx - nx * FLOOR_PROBE, my - ny * FLOOR_PROBE) ?? 0);
  const h = top - floor;
  return Number.isFinite(h) && h >= 0.75 ? h : undefined;
}

/**
 * A door linked to the fog door it's on, if one's near that no other door
 * has: its ends put on the fog door's (its hinge the end nearest its own).
 * Whether one was.
 */
export function linkDoor(ed: ReliefEditor, door: Door): boolean {
  const others = doorsOf(ed).filter((d) => d !== door && d.link);
  const near = fogDoorNear(door, ed.host.fogDoors(), (link) => others.some((d) => sameLink(d.link!, link)));
  if (!near?.link) {
    return false;
  }
  door.a = [near.a[0], near.a[1]];
  door.b = [near.b[0], near.b[1]];
  door.link = near.link;
  return true;
}

/** A door drawn from `a` to `b` (too short: none), as tall as the wall round it, linked if it's on a fog door, picked. */
export function addDoor(ed: ReliefEditor, a: Pt, b: Pt): boolean {
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < DOOR_MIN) {
    return false;
  }
  ed.pushUndo();
  const door: Door = { a, b, side: 1, swing: SWING };
  linkDoor(ed, door);
  const wall = wallHeight(ed, door.a, door.b);
  const h = wall === undefined ? DOOR_H : openingFor(wall);
  if (h !== DOOR_H) {
    door.h = h;
  }
  const doors = (ed.data.doors ??= []);
  doors.push(door);
  ed.sel = { kind: "door", i: doors.length - 1 };
  return true;
}

/** The picked door, gone. */
export function removeDoor(ed: ReliefEditor, i: number) {
  const doors = doorsOf(ed);
  if (!doors[i]) {
    return;
  }
  ed.pushUndo();
  doors.splice(i, 1);
  if (doors.length === 0) {
    delete ed.data.doors;
  }
  ed.sel = null;
}

/** A copy of a door, a cell aside, unlinked (a fog door is one door's), picked. */
export function duplicateDoor(ed: ReliefEditor, i: number) {
  const d = doorsOf(ed)[i];
  if (!d) {
    return;
  }
  ed.pushUndo();
  const copy: Door = { ...d, a: [d.a[0] + 1, d.a[1] + 1], b: [d.b[0] + 1, d.b[1] + 1] };
  delete copy.link;
  ed.data.doors!.push(copy);
  ed.sel = { kind: "door", i: ed.data.doors!.length - 1 };
}
