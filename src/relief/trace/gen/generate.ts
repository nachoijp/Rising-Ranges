// "Generar relieve": a whole relief from the map's picture, with a plan of its
// walls (.uvtt) if there's one. Every step's own module says how it works:
//
//  1. walls      the plan's walls, their thickness measured on the picture (../uvtt.ts)
//  2. cut        the picture in small cells of one colour, off the walls (regions.ts: SLIC)
//  3. join       neighbours that look alike joined into regions, never across a room's wall
//  4. look       what each region is: water, foliage or ground (heights.ts)
//  5. shade      which side of each border is lower, from the shading the artist painted
//  6. solve      the heights that best keep every clue
//  7. stairs     stairs found by their repeating steps, climbing between the heights round them
//  8. shapes     levels, water, trees and hedges, walls and stairs as the editor's shapes
//
// Nothing here guesses what isn't in the picture: what has no clue stays at
// the ground's height. All in cells of the map (x right, y down).

import type { Group, Pt, ReliefData, Shape } from "../../types";
import { findStairs, planOf, uvttRelief, type Picture, type Stair, type Uvtt, type UvttNames, type UvttPlan } from "../uvtt";
import { lookOf, settle, shadeClues, solveHeights, type Clue, type Look } from "./heights";
import { bordersOf, mergeRegions, prepareImg, slic, type Region } from "./regions";
import { cliffClues, isRock } from "./cliffs";
import { crownRing, findPlants, type Plants } from "./plants";
import { loopsOf, paintRings, ringArea, type Loop } from "./vector";

export type GenStage = "walls" | "cut" | "join" | "look" | "shade" | "solve" | "stairs" | "shapes";
export const GEN_STAGES: GenStage[] = ["walls", "cut", "join", "look", "shade", "solve", "stairs", "shapes"];

export type GenNames = UvttNames & { top: string; cliffs: string; cliff: (n: number) => string; levels: string; water: string; plants: string; level: (h: number) => string; pond: (n: number) => string; tree: (n: number) => string; bush: (n: number) => string };

export type GenOptions = {
  wallH?: number;
  /** Levels a cell of cast shadow is worth. */
  shadeK?: number;
  /** How alike neighbours must look to be joined (higher: fewer, bigger regions). */
  join?: number;
  /**
   * Guides: rough shapes with their heights (the ones already drawn). Each region mostly under one
   * takes its height; the rest take the height of the guide they're nearest to, walking over the
   * picture's regions (crossing rock is slow: a cliff parts two heights).
   */
  seeds?: { rings: Pt[][]; h: number }[];
  /** With no guides: guess steps from the shading and the cliffs (unsure; off, the ground's all level). */
  guess?: boolean;
};

export type GenCounts = { rooms: number; cliffs: number; levels: number; water: number; trees: number; bushes: number; walls: number; hedges: number; objects: number; stairs: number; regions: number };

/** What the bench draws: every step's own result. */
export type GenDebug = {
  labels: Int32Array;
  regions: Region[];
  looks: Look[];
  heights: Float64Array;
  clues: Clue[];
  shadeDir: [number, number];
  shadeStrength: number;
  stairs: Stair[];
  plan: UvttPlan | null;
  plants: Plants;
  rock: boolean[];
  ms: Record<string, number>;
};

/** Pixels a cell the picture is worked at. */
export const GEN_PX = 16;

const r2 = (v: number) => Math.round(v * 100) / 100;
const newId = () => Math.random().toString(36).slice(2, 8);

/**
 * The relief, added on top of `base` (in a group of its own). `pic`: the map's
 * picture, GEN_PX a cell, as big as `base` (cells); `uvtt`: its plan, if any
 * (stretched onto the map if its size differs).
 */
export function generate(
  pic: Picture,
  uvtt: Uvtt | null,
  base: ReliefData,
  names: GenNames,
  o: GenOptions = {},
  progress: (stage: GenStage) => void = () => {},
): { data: ReliefData; counts: GenCounts; debug: GenDebug } {
  const { wallH = 2, shadeK = 4, join = 9, guess = false } = o;
  // Thin guides are walls, not floors: the plan's walls stand for them; with no plan they're kept as they are.
  const widthOf = (ring: Pt[]) => {
    let per = 0;
    for (let i = 0; i < ring.length; i++) per += Math.hypot(ring[(i + 1) % ring.length][0] - ring[i][0], ring[(i + 1) % ring.length][1] - ring[i][1]);
    return per > 0 ? (2 * ringArea(ring)) / per : 0;
  };
  const seeds = (o.seeds ?? []).filter((sd) => sd.rings[0]?.length >= 3 && widthOf(sd.rings[0]) >= 0.6);
  const wallSeeds = uvtt ? [] : (o.seeds ?? []).filter((sd) => sd.rings[0]?.length >= 3 && widthOf(sd.rings[0]) < 0.6);
  const { w: W, h: H, px } = pic;
  const ms: Record<string, number> = {};
  let t = performance.now();
  const lap = (k: string) => {
    const now = performance.now();
    ms[k] = Math.round(now - t);
    t = now;
  };

  // 1. Walls.
  progress("walls");
  const blocked = new Uint8Array(W * H);
  let room: Int32Array | undefined;
  let plan: UvttPlan | null = null;
  if (uvtt) {
    // Measured on the map's own picture (the plan scaled onto it first).
    const scaled: Uvtt = { ...uvtt, w: base.w, h: base.h, walls: uvtt.walls.map((l) => l.map(([x, y]): Pt => [(x * base.w) / uvtt.w, (y * base.h) / uvtt.h])), portals: uvtt.portals.map(([a, b]) => [[(a[0] * base.w) / uvtt.w, (a[1] * base.h) / uvtt.h], [(b[0] * base.w) / uvtt.w, (b[1] * base.h) / uvtt.h]] as [Pt, Pt]) };
    plan = planOf(scaled, pic, [1, 1], false);
    for (const r of plan.runs) if (r.kind !== "object") paintRings(blocked, W, H, px, r.rings, 1);
    room = new Int32Array(W * H).fill(-1);
    plan.rooms
      .map((ring, i) => ({ ring, i }))
      .sort((a, b) => ringArea(b.ring) - ringArea(a.ring))
      .forEach(({ ring, i }) => paintRings(room!, W, H, px, [ring], i));
  }
  lap("walls");

  // 2–3. Regions.
  progress("cut");
  const img = prepareImg(pic.data, W, H, px);
  const sp = slic(img, Math.max(4, Math.round(px * 0.4)), blocked);
  lap("cut");
  progress("join");
  const { labels, regions } = mergeRegions(img, sp, join, 0.5 * px * px, room);
  const R = regions.length;
  const area = regions.map((r) => r.n / (px * px));
  lap("join");

  // 4. Looks: the grain that counts as coarse is the map's own (its upper third).
  progress("look");
  const grains = regions.map((r) => r.tex).sort((a, b) => a - b);
  const texHigh = Math.max(4, grains[Math.floor(grains.length * 0.66)] ?? 4);
  // The map's usual blue-yellow: its regions', by area, the middle one.
  const byB = regions.map((r) => [r.B, r.n]).sort((a, b) => a[0] - b[0]);
  let midB = 0;
  for (let k = 0, acc = 0, half = (W * H) / 2; k < byB.length; k++) if ((acc += byB[k][1]) >= half) {
    midB = byB[k][0];
    break;
  }
  const looks = regions.map((r) => lookOf(r, texHigh, midB));
  const borders = bordersOf(labels, W, H);
  // Water: water-coloured, and big and smooth (a lake, a river), never in a room; what's
  // water-coloured next to it, if not coarse, too. (Small dark-teal patches are shade under trees; a
  // blue carpet's in a room or has a pattern.)
  const roomOf = (reg: Region) => (room ? room[Math.floor(reg.y) * W + Math.floor(reg.x)] : -1);
  const isWater = new Array<boolean>(R).fill(false);
  const wet: number[] = [];
  regions.forEach((reg, r) => {
    if (looks[r].material === "water" && area[r] >= 6 && reg.tex <= 3.5 && roomOf(reg) < 0) {
      isWater[r] = true;
      wet.push(r);
    }
  });
  while (wet.length) {
    const r = wet.pop()!;
    for (const s of borders[r]?.keys() ?? []) {
      if (!isWater[s] && looks[s].material === "water" && regions[s].tex <= 7 && roomOf(regions[s]) < 0) {
        isWater[s] = true;
        wet.push(s);
      }
    }
  }
  looks.forEach((l, r) => {
    if (l.material === "water" && !isWater[r]) looks[r] = { material: "ground", why: "water-coloured, small or coarse" };
  });
  // Plants (trees, hedges), on what isn't wall or water; the plan's small loops as trunks.
  const skip = Uint8Array.from(blocked);
  for (let i = 0; i < W * H; i++) if (labels[i] >= 0 && isWater[labels[i]]) skip[i] = 1;
  const trunks: Pt[] = plan ? plan.runs.filter((r) => r.kind === "object").map((r) => [r.line.reduce((s, p) => s + p[0], 0) / r.line.length, r.line.reduce((s, p) => s + p[1], 0) / r.line.length]) : [];
  let indoor: Uint8Array | undefined;
  if (room) {
    indoor = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if (room[i] >= 0) indoor[i] = 1;
  }
  const plants = findPlants(img, skip, trunks, indoor);
  // A region mostly under leaves isn't ground to find a height for.
  const leafy = new Float64Array(R);
  for (let i = 0; i < W * H; i++) if (labels[i] >= 0 && plants.canopy[i]) leafy[labels[i]]++;
  looks.forEach((l, r) => {
    if (l.material !== "water") looks[r] = leafy[r] / regions[r].n > 0.5 ? { material: "foliage", why: "under leaves" } : { material: "ground", why: l.why };
  });
  lap("look");

  // 5–6. Heights.
  progress("shade");
  // Rooms' floors stay level (furniture's shading isn't a step): heights are looked for outdoors.
  const outdoors = regions.map((reg) => roomOf(reg) < 0);
  // Rock faces (cliffs) outdoors: neither ground to level nor solved; they slope between what they part.
  const rock = regions.map((reg, r) => looks[r].material === "ground" && outdoors[r] && isRock(reg));
  const solve = looks.map((l, r) => l.material === "ground" && outdoors[r] && !rock[r]);
  const ground = looks.map((l, r) => l.material === "ground" && !rock[r]);
  const shade = shadeClues(img, labels, regions, solve, shadeK);
  lap("shade");
  progress("solve");
  const fixed = new Map<number, number>();
  looks.forEach((l, r) => l.material === "water" && fixed.set(r, -1));
  const clues = shade.clues.filter((c) => solve[c.a] && solve[c.b]);
  // Water's neighbours: over it.
  borders.forEach((m, r) => {
    if (looks[r].material !== "water") return;
    for (const [s, len] of m) if (solve[s]) clues.push({ a: r, b: s, d: 1, w: Math.min(8, len / px), kind: "shade" });
  });
  const cliffs = cliffClues(regions, looks, rock, borders, px, outdoors);
  clues.push(...cliffs.clues);
  let heights: Float64Array;
  if (seeds.length) {
    heights = fromSeeds();
  } else if (guess) {
    // Whole levels (half ones were mostly the solver's noise).
    heights = settle(solveHeights(R, clues, fixed, area), area, ground, 1);
  } else {
    heights = Float64Array.from(looks, (l) => (l.material === "water" ? -1 : 0));
  }
  function fromSeeds(): Float64Array {
    const seedMap = new Int32Array(W * H).fill(-1);
    seeds.forEach((sd, k) => paintRings(seedMap, W, H, px, sd.rings, k));
    const cover = regions.map(() => new Map<number, number>());
    const seedSize = new Float64Array(seeds.length);
    for (let i = 0; i < W * H; i++) if (seedMap[i] >= 0) seedSize[seedMap[i]]++;
    for (let i = 0; i < W * H; i++) if (labels[i] >= 0 && seedMap[i] >= 0) cover[labels[i]].set(seedMap[i], (cover[labels[i]].get(seedMap[i]) ?? 0) + 1);
    const out = new Float64Array(R).fill(NaN);
    const dist = new Float64Array(R).fill(Infinity);
    const open: number[] = [];
    cover.forEach((m, r) => {
      let best = -1, most = 0;
      for (const [k, c] of m) if (c > most) [best, most] = [k, c];
      // Mostly under the guide, or the guide mostly in it (a small mark on a big floor).
      if (best >= 0 && (most / regions[r].n >= 0.3 || most / seedSize[best] >= 0.5)) {
        out[r] = seeds[best].h;
        dist[r] = 0;
        open.push(r);
      }
    });
    const done = new Uint8Array(R);
    for (;;) {
      let r = -1;
      for (const q of open) if (!done[q] && (r < 0 || dist[q] < dist[r])) r = q;
      if (r < 0) break;
      done[r] = 1;
      for (const t of borders[r]?.keys() ?? []) {
        if (done[t]) continue;
        const step = (Math.hypot(regions[r].x - regions[t].x, regions[r].y - regions[t].y) / px) * (rock[t] || rock[r] ? 7 : 1);
        if (dist[r] + step < dist[t]) {
          if (dist[t] === Infinity) open.push(t);
          dist[t] = dist[r] + step;
          out[t] = out[r];
        }
      }
    }
    return out.map((v, r) => (Number.isNaN(v) ? (looks[r].material === "water" ? -1 : 0) : looks[r].material === "water" && dist[r] > 0 ? Math.min(v, 0) - 1 : v));
  }
  lap("solve");

  // 7. Stairs: from their lower end to their higher (the heights just past each end).
  progress("stairs");
  const stairs = findStairs(pic);
  const heightAt = (x: number, y: number) => {
    const xi = Math.floor(x * px), yi = Math.floor(y * px);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return null;
    const r = labels[yi * W + xi];
    return r >= 0 ? heights[r] : null;
  };
  const sure: boolean[] = [];
  const stairEnds = stairs.map((s) => {
    const my = (s.y0 + s.y1) / 2, mx = (s.x0 + s.x1) / 2;
    const [a, b]: [Pt, Pt] = s.axis === "x" ? [[s.x0, my], [s.x1, my]] : [[mx, s.y0], [mx, s.y1]];
    const out = 0.6;
    const ha = s.axis === "x" ? heightAt(a[0] - out, a[1]) : heightAt(a[0], a[1] - out);
    const hb = s.axis === "x" ? heightAt(b[0] + out, b[1]) : heightAt(b[0], b[1] + out);
    // A step about a sixth of a level (a level's 5 ft, a step's 7–10 in).
    const rise = Math.max(0.5, Math.round((s.steps / 6) * 2) / 2);
    if (ha !== null && hb !== null && Math.abs(ha - hb) >= 0.5) {
      sure.push(true);
      return ha < hb ? { a, b, from: ha, to: hb } : { a: b, b: a, from: hb, to: ha };
    }
    sure.push(false);
    const at = ha ?? hb ?? 0;
    return { a, b, from: at, to: at + rise };
  });
  lap("stairs");

  // 8. Shapes.
  progress("shapes");
  const verts = [...base.verts];
  const shapes: Shape[] = [];
  const top: Group = { id: newId(), name: names.top };
  const groups: Group[] = [top];
  const sub = (name: string) => {
    const g: Group = { id: newId(), name, parent: top.id };
    groups.push(g);
    return g.id;
  };
  const indices = (ring: Pt[]) => ring.map(([x, y]) => verts.push({ x: r2(x), y: r2(y), h: 0 }) - 1);
  const add = (loop: Loop, shape: Omit<Shape, "ring" | "holes">) => {
    if (loop.ring.length < 3) return;
    const s: Shape = { ...shape, ring: indices(loop.ring) };
    if (loop.holes.length) s.holes = loop.holes.map(indices);
    shapes.push(s);
  };
  const counts: GenCounts = { rooms: 0, cliffs: 0, levels: 0, water: 0, trees: 0, bushes: 0, walls: 0, hedges: 0, objects: 0, stairs: 0, regions: R };
  const TOL = 0.12, MIN = 0.3;
  // Levels: every height but the ground's, as one mask each.
  const levels = [...new Set(regions.map((_, r) => (ground[r] ? heights[r] : 0)))].filter((v) => v !== 0).sort((a, b) => a - b);
  if (levels.length) {
    const g = sub(names.levels);
    for (const v of levels) {
      const mask = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) {
        const r = labels[i];
        if (r >= 0 && ground[r] && heights[r] === v) mask[i] = 1;
      }
      for (const loop of loopsOf(mask, W, H, px, TOL, MIN)) {
        add(loop, { kind: "flat", h: v, rel: false, name: names.level(v), group: g });
        counts.levels++;
      }
    }
  }
  // Cliffs: each band as high as the ground on its top, its soft edge sloping it down to its foot.
  const faces = cliffs.bands
    .map((b) => {
      let top = -Infinity, foot = Infinity;
      for (const r of b.regions)
        for (const t of borders[r]?.keys() ?? []) {
          if (rock[t] || !ground[t]) continue;
          top = Math.max(top, heights[t]);
          foot = Math.min(foot, heights[t]);
        }
      return { b, top, foot };
    })
    .filter((f) => Number.isFinite(f.top) && f.top - f.foot >= 0.5 && f.b.area >= 1);
  if (faces.length) {
    const g = sub(names.cliffs);
    for (const { b, top: h } of faces) {
      const mask = new Uint8Array(W * H);
      const mine = new Set(b.regions);
      for (let i = 0; i < W * H; i++) if (labels[i] >= 0 && mine.has(labels[i])) mask[i] = 1;
      for (const loop of loopsOf(mask, W, H, px, TOL, MIN)) {
        add(loop, { kind: "flat", h, rel: false, soft: Math.min(3, Math.max(0.5, Math.round(b.width * 4) / 4)), name: names.cliff(++counts.cliffs), group: g });
      }
    }
  }
  // Water.
  const waterMask = new Uint8Array(W * H);
  let anyWater = false;
  for (let i = 0; i < W * H; i++) {
    const r = labels[i];
    if (r >= 0 && looks[r].material === "water") {
      waterMask[i] = 1;
      anyWater = true;
    }
  }
  if (anyWater) {
    const g = sub(names.water);
    for (const loop of loopsOf(waterMask, W, H, px, TOL, 1)) add(loop, { kind: "flat", h: -1, rel: false, water: 0.6, name: names.pond(++counts.water), group: g });
  }
  // Plants: a crown a soft dome about as high as it's wide; a hedge low.
  if (plants.trees.length || plants.hedges.length) {
    const g = sub(names.plants);
    for (const t of plants.trees) {
      const h = Math.min(4, Math.max(1.5, Math.round(t.r * 1.6 * 2) / 2));
      add({ ring: crownRing(t), holes: [] }, { kind: "flat", h, rel: true, soft: Math.round(t.r * 0.6 * 4) / 4, name: names.tree(++counts.trees), group: g });
    }
    for (const loop of plants.hedges) add({ ring: loop.ring, holes: [] }, { kind: "flat", h: 1, rel: true, soft: 0.25, name: names.bush(++counts.bushes), group: g });
  }
  if (wallSeeds.length) {
    const g = sub(names.walls);
    wallSeeds.forEach((sd) => add({ ring: sd.rings[0], holes: sd.rings.slice(1) }, { kind: "flat", h: sd.h, rel: true, name: names.wall(++counts.walls), group: g }));
  }
  let data: ReliefData = { ...base, verts, shapes: [...base.shapes, ...shapes], groups: [...(base.groups ?? []), ...groups] };
  // Walls (on what's under them), from the plan; an object of the plan inside foliage is a tree's trunk: left to the tree.
  if (plan) {
    const inPlant = (ring: Pt[]) => {
      const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      const xi = Math.floor(cx * px), yi = Math.floor(cy * px);
      return xi >= 0 && yi >= 0 && xi < W && yi < H && plants.canopy[yi * W + xi] === 1;
    };
    const kept: UvttPlan = { ...plan, stairs: [], runs: plan.runs.filter((r) => r.kind !== "object" || !inPlant(r.line)) };
    const made = uvttRelief(kept, data, names, { wallH, rooms: true, parent: top.id });
    data = made.data;
    counts.rooms = made.counts.rooms;
    counts.walls = made.counts.walls;
    counts.hedges = made.counts.hedges;
    counts.objects = made.counts.objects;
  }
  // Stairs last: over everything, at their own heights.
  if (stairs.length) {
    const g: Group = { id: newId(), name: names.stairs, parent: top.id };
    data.groups = [...(data.groups ?? []), g];
    stairs.forEach((s, k) => {
      const e = stairEnds[k];
      const ring: Pt[] = [[s.x0, s.y0], [s.x1, s.y0], [s.x1, s.y1], [s.x0, s.y1]];
      data.shapes.push({
        ring: ring.map(([x, y]) => data.verts.push({ x: r2(x), y: r2(y), h: 0 }) - 1),
        kind: "ramp",
        h: Math.max(e.from, e.to),
        rel: false,
        ramp: { a: e.a, b: e.b, from: e.from, to: e.to, steps: s.steps },
        name: sure[k] ? names.stair(++counts.stairs) : `${names.stair(++counts.stairs)} (?)`,
        group: g.id,
      });
    });
  }
  lap("shapes");
  return { data, counts, debug: { labels, regions, looks, heights, clues, shadeDir: shade.dir, shadeStrength: shade.strength, stairs, plan, plants, rock, ms } };
}
