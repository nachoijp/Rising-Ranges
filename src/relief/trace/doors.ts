import type { Door, DoorLink, Pt } from "../types";

// The plan's doors made the relief's (see types.ts Door): where each hangs
// and which way it swings. Apart from fogPlan.ts so the worker can have it
// (fogPlan reads Owlbear's items, and the SDK has no place in a worker).

/** A door of the plan: from one end to the other (cells), and the fog door it is, if any. */
export type PlanDoor = { a: Pt; b: Pt; link?: DoorLink };

/** A door's opening's height (grid units) when it hasn't its own. */
export const DOOR_H = 2;

/** A doorway's height in a wall `wall` high: a lintel left over it, a quarter at least; no higher than DOOR_H. */
export function openingFor(wall: number): number {
  return Math.max(0.25, Math.round(Math.max(wall * 0.6, Math.min(DOOR_H, wall - 0.5)) * 4) / 4);
}

/** How near (cells) a door's middle is to swing toward a room it's in, and the turn it swings by. */
const SIDE_PROBE = 0.4;
const SWING = 90;

/**
 * The plan's doors as the relief's: each hinged at the end it doesn't share
 * with another door (a double door opens from its two jambs; else its first
 * end), swinging into the larger of the rooms on its two sides.
 */
export function placeDoors(doors: PlanDoor[], rooms: Pt[][]): Door[] {
  const same = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.05;
  const area = (ring: Pt[]) => {
    let s = 0;
    for (let i = 0; i < ring.length; i++) s += ring[i][0] * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * ring[i][1];
    return Math.abs(s / 2);
  };
  const inRing = (x: number, y: number, ring: Pt[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  /** The area of the smallest room a point is in (0: none). */
  const roomAt = (x: number, y: number) => {
    let best = 0;
    for (const r of rooms) if (inRing(x, y, r)) best = best ? Math.min(best, area(r)) : area(r);
    return best;
  };
  return doors.map((d, i) => {
    // Hinged at the end no other door shares.
    const sharedA = doors.some((o, j) => j !== i && (same(d.a, o.a) || same(d.a, o.b)));
    const [a, b] = sharedA ? [d.b, d.a] : [d.a, d.b];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const plus = roomAt(mx + nx * SIDE_PROBE, my + ny * SIDE_PROBE), minus = roomAt(mx - nx * SIDE_PROBE, my - ny * SIDE_PROBE);
    const door: Door = { a, b, side: minus > plus ? -1 : 1, swing: SWING };
    if (d.link) door.link = d.link;
    return door;
  });
}

/** How far (cells) a fog door's middle may be from a door's to be its, and how far off parallel (the cosine of the angle between them). */
const LINK_NEAR = 1;
const LINK_ALIGN = 0.8;

/**
 * The fog door a door drawn by hand is, if one is near (its middle within
 * LINK_NEAR or half the door's length, about as long, along it), the
 * nearest, but not one in `taken` (another door's): it, its ends put the
 * door's way round (the one nearest the door's hinge first).
 */
export function fogDoorNear(door: { a: Pt; b: Pt }, fog: PlanDoor[], taken: (link: DoorLink) => boolean = () => false): PlanDoor | null {
  const len = Math.hypot(door.b[0] - door.a[0], door.b[1] - door.a[1]);
  if (len < 1e-6) return null;
  const mx = (door.a[0] + door.b[0]) / 2, my = (door.a[1] + door.b[1]) / 2;
  let best: PlanDoor | null = null;
  let bestD = Math.max(LINK_NEAR, len / 2);
  for (const f of fog) {
    if (!f.link || taken(f.link)) continue;
    const fl = Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1]);
    if (fl < 1e-6 || fl > len * 2.5 || fl < len / 2.5) continue;
    const cos = Math.abs(((f.b[0] - f.a[0]) * (door.b[0] - door.a[0]) + (f.b[1] - f.a[1]) * (door.b[1] - door.a[1])) / (fl * len));
    if (cos < LINK_ALIGN) continue;
    const d = Math.hypot((f.a[0] + f.b[0]) / 2 - mx, (f.a[1] + f.b[1]) / 2 - my);
    if (d <= bestD) {
      bestD = d;
      best = f;
    }
  }
  if (!best) return null;
  const flip = Math.hypot(best.b[0] - door.a[0], best.b[1] - door.a[1]) < Math.hypot(best.a[0] - door.a[0], best.a[1] - door.a[1]);
  return flip ? { a: best.b, b: best.a, link: best.link } : best;
}

/** Whether two links are to the same fog door. */
export const sameLink = (x: DoorLink, y: DoorLink) => x.kind === y.kind && x.item === y.item && (x.kind !== "obr" || (y.kind === "obr" && x.index === y.index));
