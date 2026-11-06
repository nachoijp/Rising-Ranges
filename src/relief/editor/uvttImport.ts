import { planOf, readUvtt, uvttRelief, type Picture } from "../trace/uvtt";
import type { ReliefData } from "../types";
import type { T } from "./panel";

// The editor's side of a Universal VTT import (see trace/uvtt.ts): the
// file's own picture drawn small enough to measure the walls on, the plan
// stretched onto this map if its size differs, and what came of it said.

/** Pixels per cell the walls are measured at, and the most pixels the picture may take. */
const PX = 32;
const MAX_PIXELS = 8e6;

async function pictureOf(base64: string, w: number, h: number): Promise<Picture | null> {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const px = Math.max(8, Math.min(PX, Math.floor(Math.sqrt(MAX_PIXELS / (w * h)))));
    const cw = Math.round(w * px), ch = Math.round(h * px);
    const canvas = new OffscreenCanvas(cw, ch);
    const g = canvas.getContext("2d");
    if (!g) return null;
    g.imageSmoothingQuality = "high";
    g.drawImage(bitmap, 0, 0, cw, ch);
    bitmap.close();
    return { w: cw, h: ch, px, data: g.getImageData(0, 0, cw, ch).data };
  } catch {
    return null;
  }
}

/** The plan's shapes added on top of `base`; null if it isn't a plan; `empty` if it has no walls. */
export async function importUvtt(json: unknown, base: ReliefData, t: T): Promise<{ data: ReliefData; empty: boolean; notes: string[] } | null> {
  const u = readUvtt(json);
  if (!u) return null;
  if (u.walls.length === 0) return { data: base, empty: true, notes: [] };
  const notes: string[] = [];
  const sx = base.w / u.w, sy = base.h / u.h;
  if (Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01) {
    notes.push(t("relief.uvttSize", { fw: u.w, fh: u.h, w: base.w, h: base.h }));
  }
  // The picture as the plan's own cells (measured before it's stretched: the plan and its picture agree).
  const pic = u.image ? await pictureOf(u.image, u.w, u.h) : null;
  const plan = planOf(u, pic);
  if (sx !== 1 || sy !== 1) {
    const st = (ring: [number, number][]) => ring.map(([x, y]): [number, number] => [x * sx, y * sy]);
    plan.rooms = plan.rooms.map(st);
    for (const r of plan.runs) r.rings = r.rings.map(st);
    plan.stairs = plan.stairs.map((s) => ({ ...s, x0: s.x0 * sx, x1: s.x1 * sx, y0: s.y0 * sy, y1: s.y1 * sy }));
  }
  const { data, counts } = uvttRelief(plan, base, {
    group: t("relief.uvtt.group"),
    rooms: t("relief.uvtt.rooms"),
    walls: t("relief.uvtt.walls"),
    hedges: t("relief.uvtt.hedges"),
    objects: t("relief.uvtt.objects"),
    room: (n) => t("relief.uvtt.room", { n }),
    wall: (n) => t("relief.uvtt.wall", { n }),
    hedge: (n) => t("relief.uvtt.hedge", { n }),
    object: (n) => t("relief.uvtt.object", { n }),
    stairs: t("relief.uvtt.stairs"),
    stair: (n) => t("relief.uvtt.stair", { n }),
    solids: t("relief.gen.solids"),
    solid: (n) => t("relief.gen.solid", { n }),
  });
  notes.unshift(t("relief.uvttDone", { rooms: counts.rooms, walls: counts.walls, hedges: counts.hedges, objects: counts.objects }));
  if (counts.stairs) notes.push(t("relief.uvttStairs", { stairs: counts.stairs }));
  return { data, empty: false, notes };
}
