import clip from "../../terrain/clip";
import { area, bbox, centroid, closed, inRing, open } from "../geom";
import { compose, quarter, type Layer, type SlabLayer } from "../relief";
import { corners, standDepth, standSide } from "../stand";
import type { Pt, Ramp, Shape, ShapeKind, Skin } from "../types";
import type { ReliefEditor } from "./editor";

// What the editor does to shapes, apart from the pointer: making them,
// cutting them, putting them together, painting them, and what their
// vertices, layers and types become. Each leaves the relief worked out
// again (the editor's `changed` tells the page).

/** A shape's whole set of vertices (its outline's, then its holes'). */
export const vertsOf = (s: Shape): number[] => (s.holes?.length ? [...s.ring, ...s.holes.flat()] : s.ring);
/** Its outlines: its own, then its holes'. */
export const loopsOf = (s: Shape): number[][] => (s.holes?.length ? [s.ring, ...s.holes] : [s.ring]);

const newKin = () => Math.random().toString(36).slice(2, 8);

/** A copy of a shape that shares nothing with it but its vertices (its arrow and relief its own). */
function copyOf(s: Shape, ring: number[], holes?: number[][]): Shape {
  return {
    ...s,
    ring,
    holes: holes && holes.length > 0 ? holes : undefined,
    ramp: s.ramp ? { ...s.ramp, a: [...s.ramp.a], b: [...s.ramp.b] } : s.ramp,
    detail: s.detail ? { m: [...s.detail.m], v: new Map(s.detail.v) } : undefined,
  };
}

/** A layer (terrain or slab) of a shape, if it's worked out. */
export function layerOf(ed: ReliefEditor, si: number): Layer | SlabLayer | undefined {
  return ed.relief.layers.find((l) => l.si === si) ?? ed.relief.slabLayers.find((l) => l.si === si);
}

// ---------- Making shapes ----------

/** A new shape from an outline of points (its own vertices): flat, a level over what's under it, picked. */
export function addShape(ed: ReliefEditor, points: Pt[], raise = 1): boolean {
  const ring = open(points);
  if (ring.length < 3 || Math.abs(area(ring)) < 0.05) {
    return false;
  }
  const start = ed.data.verts.length;
  for (const [x, y] of ring) {
    ed.data.verts.push({ x, y, h: quarter(ed.heightAt(x, y) ?? 0) });
  }
  ed.data.shapes.push({ ring: ring.map((_, k) => start + k), kind: "flat", rel: true, h: raise, soft: ed.settings.lastSoft || undefined });
  ed.sel = { kind: "shape", i: ed.data.shapes.length - 1 };
  return true;
}

/** New vertices for an outline's points (an inclined shape's at its surface there; others' at the terrain's). */
export function newVerts(ed: ReliefEditor, loop: Pt[], layer: Layer | SlabLayer | null = null): number[] {
  const verts = ed.data.verts;
  const start = verts.length;
  for (const [x, y] of loop) {
    const slope = layer && ed.data.shapes[layer.si]?.kind === "slope";
    verts.push({ x, y, h: slope ? ed.relief.surface(layer, x, y, true) : quarter(ed.heightAt(x, y) ?? 0) });
  }
  return loop.map((_, k) => start + k);
}

/** A shape as polygon-clipping has it: its outline, then its holes, each closed. */
export function polygonOf(ed: ReliefEditor, s: Shape): Pt[][][] {
  const [ring, holes] = ed.relief.coordsOf(s);
  return [[closed(ring), ...holes.map(closed)]];
}

/** Snapped to what's near (none with `free`): a vertex of an outline, or a point on one of its sides. */
export type Snap = { vertex: number; x: number; y: number } | { edge: [number, number]; x: number; y: number };

export function snap(ed: ReliefEditor, p: { x: number; y: number }, free: boolean): Snap | null {
  if (free) {
    return null;
  }
  const reach = ed.host.snapReach();
  const verts = ed.data.verts;
  const used = new Set([...ed.data.shapes.flatMap(vertsOf), ...(ed.drawing ?? [])]);
  let best: Snap | null = null;
  let d = reach;
  verts.forEach((v, i) => {
    const e = Math.hypot(v.x - p.x, v.y - p.y);
    if (e < d && used.has(i)) {
      d = e;
      best = { vertex: i, x: v.x, y: v.y };
    }
  });
  if (best) {
    return best;
  }
  for (const loop of ed.data.shapes.flatMap(loopsOf)) {
    for (let k = 0; k < loop.length; k++) {
      const a = verts[loop[k]];
      const b = verts[loop[(k + 1) % loop.length]];
      const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      if (len2 < 1e-9) {
        continue;
      }
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2));
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const e = Math.hypot(x - p.x, y - p.y);
      if (e < d && t > 0.001 && t < 0.999) {
        d = e;
        best = { edge: [loop[k], loop[(k + 1) % loop.length]], x, y };
      }
    }
  }
  return best;
}

/** A vertex at a snapped point: the existing one, or a new one (splitting the side it's on, in every shape). */
export function vertexAt(ed: ReliefEditor, p: { x: number; y: number }, at: Snap | null): number {
  if (at && "vertex" in at) {
    return at.vertex;
  }
  const x = at?.x ?? p.x;
  const y = at?.y ?? p.y;
  const i = ed.data.verts.length;
  ed.data.verts.push({ x, y, h: quarter(ed.heightAt(x, y) ?? 0) });
  if (at && "edge" in at) {
    const [a, b] = at.edge;
    for (const loop of ed.data.shapes.flatMap(loopsOf)) {
      for (let k = 0; k < loop.length; k++) {
        const u = loop[k];
        const v = loop[(k + 1) % loop.length];
        if ((u === a && v === b) || (u === b && v === a)) {
          loop.splice(k + 1, 0, i);
          break;
        }
      }
    }
  }
  return i;
}

/** The outline being drawn closed into a shape (too few points: dropped). */
export function finishPolygon(ed: ReliefEditor) {
  const drawing = ed.drawing;
  ed.drawing = null;
  if (!drawing || drawing.length < 3) {
    prune(ed);
    return;
  }
  ed.data.shapes.push({ ring: drawing, kind: "flat", rel: true, h: 1, soft: ed.settings.lastSoft || undefined });
  ed.sel = { kind: "shape", i: ed.data.shapes.length - 1 };
}

/** Vertices no shape (and no outline being drawn) uses: gone, the rest renumbered. Lets go of what's picked. */
export function prune(ed: ReliefEditor) {
  const data = ed.data;
  const used = new Set(data.shapes.flatMap(vertsOf));
  for (const i of ed.drawing ?? []) {
    used.add(i);
  }
  const map = new Map<number, number>();
  const kept: typeof data.verts = [];
  data.verts.forEach((v, i) => {
    if (used.has(i)) {
      map.set(i, kept.length);
      kept.push(v);
    }
  });
  data.verts = kept;
  for (const s of data.shapes) {
    s.ring = s.ring.map((i) => map.get(i)!);
    if (s.holes) {
      s.holes = s.holes.map((hole) => hole.map((i) => map.get(i)!));
    }
  }
  if (ed.drawing) {
    ed.drawing = ed.drawing.map((i) => map.get(i)!);
  }
  ed.sel = null;
}

/** `f` run without losing the shape picked (prune lets go of it). */
export function keepPick(ed: ReliefEditor, f: () => void) {
  const sel = ed.sel;
  f();
  if (sel?.kind === "shape" && sel.i < ed.data.shapes.length) {
    ed.sel = sel;
  }
}

/** A vertex out of every outline it's in (keeping three at least; a hole of three goes). */
export function removeVertex(ed: ReliefEditor, vi: number) {
  for (const s of ed.data.shapes) {
    if (s.ring.length > 3) {
      s.ring = s.ring.filter((i) => i !== vi);
    }
    if (s.holes) {
      s.holes = s.holes.filter((hole) => !(hole.includes(vi) && hole.length <= 3)).map((hole) => hole.filter((i) => i !== vi));
      if (s.holes.length === 0) {
        s.holes = undefined;
      }
    }
  }
  keepPick(ed, () => prune(ed));
}

// ---------- A shape's surface and type ----------

/**
 * A ramp's first arrow: along the shape's longer side, through its middle,
 * from its height now (or the surface's at its foot) up a level.
 */
export function defaultRamp(ed: ReliefEditor, s: Shape): Ramp {
  const [ring] = ed.relief.coordsOf(s);
  const { x0, y0, x1, y1 } = bbox(ring);
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const [w, h] = [x1 - x0, y1 - y0];
  // Wide: left to right; tall: from the bottom up.
  const [a, b]: [Pt, Pt] = w >= h ? [[x0 + w * 0.1, cy], [x1 - w * 0.1, cy]] : [[cx, y1 - h * 0.1], [cx, y0 + h * 0.1]];
  const layer = layerOf(ed, ed.data.shapes.indexOf(s));
  const from = s.kind === "flat" ? s.h : quarter(layer ? ed.relief.surface(layer, ...a, true) : 0);
  return { a, b, from, to: from + 1, steps: 0 };
}

/** A shape's heights told over what's under it, or fixed, kept where they are. */
export function setRel(ed: ReliefEditor, si: number, rel: boolean) {
  const s = ed.data.shapes[si];
  if (!!s.rel === rel || s.kind === "slope") {
    return;
  }
  const sign = rel ? -1 : 1;
  const below = (x: number, y: number) => quarter(ed.relief.evaluate(x, y, si, (layer) => !!s.kin && layer.kin === s.kin));
  if (s.kind === "flat") {
    s.h += sign * below(...centroid(ed.relief.coordsOf(s)[0]));
  } else if (s.ramp) {
    s.ramp.from += sign * below(...s.ramp.a);
    s.ramp.to += sign * below(...s.ramp.b);
  }
  s.rel = rel;
}

/** A shape's surface made `kind`: an inclined one's corners where its surface is now; a ramp with an arrow to start with. */
export function setKind(ed: ReliefEditor, si: number, kind: ShapeKind) {
  const s = ed.data.shapes[si];
  if (kind === "slope" && s.kind !== "slope") {
    const layer = layerOf(ed, si);
    for (const i of vertsOf(s)) {
      const v = ed.data.verts[i];
      v.h = quarter(layer ? ed.relief.surface(layer, v.x, v.y, true) : s.h);
    }
    s.rel = false;
  }
  if (kind === "ramp" && !s.ramp) {
    s.ramp = defaultRamp(ed, s);
  }
  s.kind = kind;
}

export type ShapeType = "terrain" | "slab" | "stand";

/**
 * A shape made terrain, a slab (where it is now, at a fixed height: what's
 * under it may change, a ravine under a bridge) or standing (a block as deep
 * as its picture is tall, over what's under it, flat on top).
 */
export function setType(ed: ReliefEditor, si: number, type: ShapeType) {
  const s = ed.data.shapes[si];
  s.slab = undefined;
  s.stand = undefined;
  if (type === "slab") {
    setRel(ed, si, false);
    s.slab = 0.5;
  } else if (type === "stand") {
    const [ring] = ed.relief.coordsOf(s);
    const box = bbox(ring);
    const depth = standDepth(standSide("auto", ring, box, ed.data.w, ed.data.h), box);
    s.stand = "auto";
    s.kind = "flat";
    s.ramp = undefined;
    s.soft = undefined;
    s.rel = true;
    s.h = Math.max(0.5, quarter(depth));
  }
}

// ---------- Cutting and putting together ----------

/** Parts of a shape over what's under it, measured at their own middles now: put back at `h`, where the whole was. */
export function keepHeights(ed: ReliefEditor, list: { si: number; h: number | undefined }[]) {
  let moved = false;
  for (const { si, h } of list) {
    const s = ed.data.shapes[si];
    const layer = layerOf(ed, si);
    if (s.kind === "flat" && s.rel && h !== undefined && layer) {
      const now = layer.pieces[0].h!;
      if (Math.abs(now - h) > 1e-9) {
        s.h += h - now;
        moved = true;
      }
    }
  }
  if (moved) {
    ed.relief.derive();
  }
}

/**
 * Shape `si`'s outline (and holes) made `polygons` (each [outline, ...holes],
 * open, the largest first): it takes the first; the rest are copies of it,
 * after it among the layers. How many copies there are.
 */
export function replaceWith(ed: ReliefEditor, si: number, polygons: Pt[][][]): number {
  const s = ed.data.shapes[si];
  const layer = layerOf(ed, si) ?? null;
  const shaped = polygons.map(([ring, ...holes]) => ({ ring: newVerts(ed, ring, layer), holes: holes.map((hole) => newVerts(ed, hole, layer)) }));
  s.ring = shaped[0].ring;
  s.holes = shaped[0].holes.length > 0 ? shaped[0].holes : undefined;
  const rest = shaped.slice(1).map(({ ring, holes }) => copyOf(s, ring, holes));
  ed.data.shapes.splice(si + 1, 0, ...rest);
  return rest.length;
}

export type Combine = "union" | "difference" | "intersection" | "xor";

/**
 * The shapes picked together, made one by `op` (union, difference: the first
 * less the others, intersection, exclusion: what just one of them covers).
 * The result is the first picked: what it was, where it was among the
 * layers; the others are gone. Apart, it's that many shapes; a hole stays a
 * hole. False if nothing came of it (they had nothing in common, or nothing's left).
 */
export function combine(ed: ReliefEditor, op: Combine): boolean {
  const sel = ed.sel;
  if (sel?.kind !== "shape" || !sel.more?.length) {
    return false;
  }
  const base = sel.i;
  const others = sel.more;
  let polygons: Pt[][][];
  try {
    const geometry = [polygonOf(ed, ed.data.shapes[base]), ...others.map((si) => polygonOf(ed, ed.data.shapes[si]))];
    polygons = cleanPolygons(clip[op](geometry[0], ...geometry.slice(1)) as Pt[][][]);
  } catch {
    return false;
  }
  if (polygons.length === 0) {
    return false;
  }
  ed.pushUndo();
  const was = layerOf(ed, base)?.pieces[0]?.h;
  const s = ed.data.shapes[base];
  if (polygons.length > 1) {
    s.kin = s.kin ?? newKin();
  }
  const extra = replaceWith(ed, base, polygons);
  // The others out, from the last (those after the result moved up by its parts).
  let at = base;
  for (const o of [...others].sort((a, b) => b - a)) {
    ed.data.shapes.splice(o > base ? o + extra : o, 1);
    if (o < base) {
      at--;
    }
  }
  prune(ed);
  ed.relief.derive();
  keepHeights(ed, polygons.map((_, k) => ({ si: at + k, h: was })));
  ed.sel = { kind: "shape", i: at };
  return true;
}

/** A shape added to the ones picked, or taken out of them (the first one stays first while there are others). */
export function togglePick(ed: ReliefEditor, si: number) {
  const sel = ed.sel?.kind === "shape" ? ed.sel : null;
  if (!sel) {
    ed.sel = { kind: "shape", i: si };
  } else if (sel.i === si) {
    ed.sel = sel.more?.length ? { kind: "shape", i: sel.more[0], more: sel.more.slice(1) } : null;
  } else if (sel.more?.includes(si)) {
    sel.more = sel.more.filter((i) => i !== si);
  } else {
    sel.more = [...(sel.more ?? []), si];
  }
}

type Hit = { vertex?: number; edge?: [number, number]; t?: number; x: number; y: number; along: number };

/**
 * The shapes the line from `a` to `b` goes across cut in two along it (only
 * shape `only`, if given): each stretch of the line inside a shape that the
 * drawn line reaches, from side to side, cuts it. The halves keep all the
 * shape had, and its place among the layers; a half's height stays where it
 * was. False if it cut nothing.
 */
export function cut(ed: ReliefEditor, a: Pt, b: Pt, only: number | null = null): boolean {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 0.2) {
    return false;
  }
  const data = ed.data;
  const [ux, uy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const plans: { si: number; chords: [Hit, Hit][]; holed: boolean }[] = [];
  data.shapes.forEach((s, si) => {
    if (only !== null && si !== only) {
      return;
    }
    // Where its sides (round it and round its holes) go across the line (a corner on it counting as over it).
    const hits: Hit[] = [];
    for (const loop of loopsOf(s)) {
      const ring = loop.map((i): Pt => [data.verts[i].x, data.verts[i].y]);
      const side = ring.map(([x, y]) => {
        const d = (x - a[0]) * -uy + (y - a[1]) * ux;
        return Math.abs(d) < 1e-7 ? 0 : d;
      });
      for (let k = 0; k < ring.length; k++) {
        const n = (k + 1) % ring.length;
        if (side[k] >= 0 === side[n] >= 0) {
          continue;
        }
        const t = side[k] / (side[k] - side[n]);
        const at: Partial<Hit> = side[k] === 0 ? { vertex: loop[k] } : side[n] === 0 ? { vertex: loop[n] } : { edge: [loop[k], loop[n]], t };
        const [x, y] = side[k] === 0 ? ring[k] : side[n] === 0 ? ring[n] : [ring[k][0] + (ring[n][0] - ring[k][0]) * t, ring[k][1] + (ring[n][1] - ring[k][1]) * t];
        hits.push({ ...at, x, y, along: (x - a[0]) * ux + (y - a[1]) * uy });
      }
    }
    hits.sort((p, q) => p.along - q.along);
    const chords: [Hit, Hit][] = [];
    for (let k = 0; k + 1 < hits.length; k += 2) {
      const [p, q] = [hits[k], hits[k + 1]];
      if (q.along - p.along > 1e-6 && q.along > 0 && p.along < len) {
        chords.push([p, q]);
      }
    }
    if (chords.length > 0) {
      plans.push({ si, chords, holed: !!s.holes?.length });
    }
  });
  if (plans.length === 0) {
    return false;
  }
  ed.pushUndo();
  // Each shape's absolute height before, so a half stays there.
  const was = new Map(ed.relief.layers.map((layer) => [layer.si, layer.pieces[0]?.h]));
  const halves: { si: number; h: number | undefined }[] = [];
  // From the last, so the places of those still to cut don't move.
  for (const { si, chords, holed } of plans.reverse()) {
    const s = data.shapes[si];
    if (holed) {
      // With holes: a thin cut out along each stretch, its two sides then put back on the line.
      const w = 1e-4;
      const [nx, ny] = [-uy * w, ux * w];
      const knives = chords.map(([p, q]): Pt[][] => {
        const [px, py, qx, qy] = [p.x - ux * 1e-3, p.y - uy * 1e-3, q.x + ux * 1e-3, q.y + uy * 1e-3];
        return [closed([[px + nx, py + ny], [qx + nx, qy + ny], [qx - nx, qy - ny], [px - nx, py - ny]])];
      });
      let parts: Pt[][][] = [];
      try {
        parts = clip.difference(polygonOf(ed, s), ...knives) as Pt[][][];
      } catch {
        continue;
      }
      const onLine = ([x, y]: Pt): Pt => {
        const d = (x - a[0]) * -uy + (y - a[1]) * ux;
        return Math.abs(d) <= w * 1.5 ? [x + d * uy, y - d * ux] : [x, y];
      };
      const polygons = cleanPolygons(parts.map((polygon) => polygon.map((loop) => loop.map(onLine))));
      // Cut through, or a hole opened to the outside (one shape, a hole less).
      if (polygons.length === 0 || (polygons.length === 1 && polygons[0].length === loopsOf(s).length)) {
        continue;
      }
      s.kin = s.kin ?? newKin();
      const extra = replaceWith(ed, si, polygons);
      for (const half of halves) {
        half.si += half.si > si ? extra : 0;
      }
      for (let k = 0; k <= extra; k++) {
        halves.push({ si: si + k, h: was.get(si) });
      }
      continue;
    }
    // The cut's ends as vertices of the outline: new ones on a side split it in every shape that has it.
    const placed = new Map<Hit, number>();
    const vertexOf = (hit: Hit) => {
      if (hit.vertex !== undefined) {
        return hit.vertex;
      }
      const known = placed.get(hit);
      if (known !== undefined) {
        return known;
      }
      const [u, v] = hit.edge!;
      const i = data.verts.length;
      data.verts.push({ x: hit.x, y: hit.y, h: data.verts[u].h + (data.verts[v].h - data.verts[u].h) * hit.t! });
      placed.set(hit, i);
      return i;
    };
    const ends = chords.map(([p, q]) => [vertexOf(p), vertexOf(q)]);
    for (const [hit, i] of placed) {
      const [u, v] = hit.edge!;
      for (const loop of data.shapes.flatMap(loopsOf)) {
        for (let k = 0; k < loop.length; k++) {
          const [p, q] = [loop[k], loop[(k + 1) % loop.length]];
          if ((p === u && q === v) || (p === v && q === u)) {
            loop.splice(k + 1, 0, i);
            break;
          }
        }
      }
    }
    // The outline split chord by chord: each one inside one of the parts so far.
    const rings = [s.ring];
    for (const [p, q] of ends) {
      const [mx, my] = [(data.verts[p].x + data.verts[q].x) / 2, (data.verts[p].y + data.verts[q].y) / 2];
      const r = rings.findIndex((ring) => {
        const [ip, iq] = [ring.indexOf(p), ring.indexOf(q)];
        if (ip < 0 || iq < 0 || Math.abs(ip - iq) === 1 || Math.abs(ip - iq) === ring.length - 1) {
          return false;
        }
        return inRing(mx, my, ring.map((i): Pt => [data.verts[i].x, data.verts[i].y]));
      });
      if (r < 0) {
        continue;
      }
      const ring = rings[r];
      const [i0, i1] = [ring.indexOf(p), ring.indexOf(q)].sort((m, n) => m - n);
      rings.splice(r, 1, ring.slice(i0, i1 + 1), [...ring.slice(i1), ...ring.slice(0, i0 + 1)]);
    }
    if (rings.length < 2) {
      continue;
    }
    s.kin = s.kin ?? newKin();
    s.ring = rings[0];
    const rest = rings.slice(1).map((ring) => copyOf(s, ring));
    data.shapes.splice(si + 1, 0, ...rest);
    // Those after it moved up by as many.
    for (const half of halves) {
      half.si += half.si > si ? rest.length : 0;
    }
    for (let k = 0; k <= rest.length; k++) {
      halves.push({ si: si + k, h: was.get(si) });
    }
  }
  prune(ed);
  ed.relief.derive();
  keepHeights(ed, halves);
  ed.sel = only !== null ? { kind: "shape", i: only } : null;
  return true;
}

/**
 * A stroke of the shape brush made a shape: what it covers, its outline
 * simplified (painted round, it has a hole). Touching the shape picked, it's
 * added to it instead (with `erase`, taken from it: a hole, if it's inside);
 * a part a shape's cut into by that is its own shape, as it was.
 */
export function paintShape(ed: ReliefEditor, pts: Pt[], erase: boolean) {
  const r = ed.settings.shapeRadius;
  const circle = ([x, y]: Pt) => Array.from({ length: 24 }, (_, k): Pt => [x + Math.cos((k / 24) * Math.PI * 2) * r, y + Math.sin((k / 24) * Math.PI * 2) * r]);
  const parts = pts.length === 1 ? [circle(pts[0])] : pts.slice(1).map((b, k) => hull([...circle(pts[k]), ...circle(b)]));
  let blob: Pt[][][] = [];
  try {
    const each = parts.map((part): Pt[][] => [closed(part)]);
    blob = clip.union(each[0], ...each.slice(1)) as Pt[][][];
    blob = clip.intersection(blob, [[closed([[0, 0], [ed.data.w, 0], [ed.data.w, ed.data.h], [0, ed.data.h]])]]) as Pt[][][];
  } catch {
    return;
  }
  if (blob.length === 0) {
    return;
  }
  const tolerance = Math.min(0.08, r * 0.03);
  const si = ed.sel?.kind === "shape" ? ed.sel.i : -1;
  const own = si >= 0 ? polygonOf(ed, ed.data.shapes[si]) : null;
  let touches = false;
  if (own) {
    try {
      touches = clip.intersection(own, blob).length > 0;
    } catch {
      touches = false;
    }
  }
  if (erase && !touches) {
    return;
  }
  ed.pushUndo();
  if (!own || !touches) {
    for (const [ring, ...holes] of cleanPolygons(blob, tolerance)) {
      const n = ed.data.shapes.length;
      if (addShape(ed, ring) && holes.length > 0) {
        ed.data.shapes[n].holes = holes.map((hole) => newVerts(ed, hole));
      }
    }
    return;
  }
  let polygons: Pt[][][] = [];
  try {
    polygons = cleanPolygons((erase ? clip.difference(own, blob) : clip.union(own, blob)) as Pt[][][], tolerance);
  } catch {
    return;
  }
  if (polygons.length === 0) {
    // All of it rubbed out.
    ed.data.shapes.splice(si, 1);
    prune(ed);
    return;
  }
  replaceWith(ed, si, polygons);
  keepPick(ed, () => prune(ed));
}

// ---------- Pictures, copies, layers ----------

/**
 * A picture for a shape's walls from four corners on the map (a rectangle
 * dragged, or another shape's outline): its two shorter sides are its ends,
 * the one nearest the shape its foot, the other its top, both listed from the
 * same long side; it goes round the shape's middle.
 */
export function skinFrom(ed: ReliefEditor, quad: Pt[], si: number): Skin {
  const [ring] = ed.relief.coordsOf(ed.data.shapes[si]);
  const b = bbox(ring);
  const center: Pt = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
  const side = (k: number) => Math.hypot(quad[(k + 1) % 4][0] - quad[k][0], quad[(k + 1) % 4][1] - quad[k][1]);
  // The ends: sides 0 and 2, or 1 and 3, whichever are shorter together.
  const first = side(0) + side(2) <= side(1) + side(3) ? 0 : 1;
  const at = (k: number) => quad[(first + k) % 4];
  const mid = (p: Pt, q: Pt): Pt => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const away = (pt: Pt) => Math.hypot(pt[0] - center[0], pt[1] - center[1]);
  // One end (corners 0, 1), the other (2, 3): corner 0 and 3 share a long side, as 1 and 2 do.
  const [e0, e1]: [[Pt, Pt], [Pt, Pt]] = [[at(0), at(1)], [at(3), at(2)]];
  const nearFirst = away(mid(...e0)) <= away(mid(...e1));
  return { base: nearFirst ? e0 : e1, top: nearFirst ? e1 : e0, center };
}

/** Four corners for a wall picture from another shape: its own, if it has four; else the smallest box round it, turned to fit. */
export function quadOf(ed: ReliefEditor, si: number): Pt[] {
  const [ring] = ed.relief.coordsOf(ed.data.shapes[si]);
  const own = corners(ring);
  return own.length === 4 ? own : turnedBox(ring);
}

/** A copy of the picked shape, a cell aside, picked instead: its own vertices, arrow and relief (moved with it), not kin. */
export function duplicate(ed: ReliefEditor) {
  if (ed.sel?.kind !== "shape") {
    return;
  }
  ed.pushUndo();
  const data = ed.data;
  const s = data.shapes[ed.sel.i];
  const moved = new Map<number, number>();
  const copyLoop = (loop: number[]) =>
    loop.map((i) => {
      if (!moved.has(i)) {
        moved.set(i, data.verts.length);
        data.verts.push({ ...data.verts[i], x: data.verts[i].x + 1, y: data.verts[i].y + 1 });
      }
      return moved.get(i)!;
    });
  const copy = copyOf(s, copyLoop(s.ring), s.holes?.map(copyLoop));
  copy.kin = undefined;
  if (s.ramp) {
    copy.ramp = { ...s.ramp, a: [s.ramp.a[0] + 1, s.ramp.a[1] + 1], b: [s.ramp.b[0] + 1, s.ramp.b[1] + 1] };
  }
  if (s.detail) {
    copy.detail = { m: compose([1, 0, 0, 1, 1, 1], s.detail.m), v: new Map(s.detail.v) };
  }
  data.shapes.push(copy);
  ed.sel = { kind: "shape", i: data.shapes.length - 1 };
}

/** Two layers' places swapped (the one picked stays picked). */
export function swap(ed: ReliefEditor, a: number, b: number) {
  const shapes = ed.data.shapes;
  if (a < 0 || b < 0 || a >= shapes.length || b >= shapes.length) {
    return;
  }
  ed.pushUndo();
  [shapes[a], shapes[b]] = [shapes[b], shapes[a]];
  if (ed.sel?.kind === "shape") {
    const moved = (i: number) => (i === a ? b : i === b ? a : i);
    ed.sel.i = moved(ed.sel.i);
    ed.sel.more = ed.sel.more?.map(moved);
  }
}

/** A layer taken from its place to another (what's picked stays picked). */
export function moveLayer(ed: ReliefEditor, from: number, to: number) {
  const shapes = ed.data.shapes;
  if (from === to || from < 0 || to < 0 || from >= shapes.length || to >= shapes.length) {
    return;
  }
  ed.pushUndo();
  const sel = ed.sel?.kind === "shape" ? ed.sel : null;
  const picked = sel ? { s: shapes[sel.i], more: (sel.more ?? []).map((i) => shapes[i]) } : null;
  const [s] = shapes.splice(from, 1);
  shapes.splice(to, 0, s);
  if (sel && picked) {
    sel.i = shapes.indexOf(picked.s);
    if (sel.more) {
      sel.more = picked.more.map((t) => shapes.indexOf(t));
    }
  }
}

// ---------- Outline helpers ----------

/** A hand-drawn line with fewer points: the ones it turns at (Ramer–Douglas–Peucker). */
export function simplify(points: Pt[], tolerance: number): Pt[] {
  if (points.length < 3) {
    return points;
  }
  const [a, b] = [points[0], points[points.length - 1]];
  let worst = 0;
  let at = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const d = Math.abs((b[0] - a[0]) * (a[1] - y) - (a[0] - x) * (b[1] - a[1])) / len;
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= tolerance) {
    return [a, b];
  }
  return [...simplify(points.slice(0, at + 1), tolerance).slice(0, -1), ...simplify(points.slice(at), tolerance)];
}

/** A closed outline with fewer points: the two halves from its first point to its farthest one, each simplified. */
function simplifyRing(ring: Pt[], tolerance: number): Pt[] {
  if (ring.length < 4) {
    return ring;
  }
  let far = 0;
  ring.forEach(([x, y], k) => {
    if (Math.hypot(x - ring[0][0], y - ring[0][1]) > Math.hypot(ring[far][0] - ring[0][0], ring[far][1] - ring[0][1])) {
      far = k;
    }
  });
  const a = simplify(ring.slice(0, far + 1), tolerance);
  const b = simplify([...ring.slice(far), ring[0]], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/**
 * A polygon-clipping result as polygons of open outlines ([outline, ...holes]),
 * each simplified with `tolerance` if given; specks and pinholes left out, the
 * largest first.
 */
export function cleanPolygons(multi: Pt[][][], tolerance = 0): Pt[][][] {
  const tidy = (loop: Pt[]) => {
    const ring = open(loop).filter((p, k, all) => k === 0 || Math.hypot(p[0] - all[k - 1][0], p[1] - all[k - 1][1]) > 1e-9);
    return tolerance > 0 ? simplifyRing(ring, tolerance) : ring;
  };
  const big = (ring: Pt[]) => ring.length >= 3 && Math.abs(area(ring)) >= 0.05;
  return multi
    .map((polygon) => polygon.map(tidy))
    .filter((polygon) => big(polygon[0]))
    .map(([ring, ...holes]) => [ring, ...holes.filter(big)])
    .sort((a, b) => Math.abs(area(b[0])) - Math.abs(area(a[0])));
}

/** The convex hull of some points (counter-clockwise; Andrew's monotone chain). */
export function hull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The smallest box round some points, turned along one of their hull's sides: its four corners. */
function turnedBox(points: Pt[]): Pt[] {
  const h = hull(points);
  let best: Pt[] | null = null;
  let least = Infinity;
  for (let k = 0; k < h.length; k++) {
    const [a, b] = [h[k], h[(k + 1) % h.length]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) {
      continue;
    }
    const [ux, uy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const along = h.map(([x, y]) => x * ux + y * uy);
    const across = h.map(([x, y]) => -x * uy + y * ux);
    const [s0, s1, t0, t1] = [Math.min(...along), Math.max(...along), Math.min(...across), Math.max(...across)];
    const size = (s1 - s0) * (t1 - t0);
    if (size < least) {
      least = size;
      const point = (sv: number, tv: number): Pt => [sv * ux - tv * uy, sv * uy + tv * ux];
      best = [point(s0, t0), point(s1, t0), point(s1, t1), point(s0, t1)];
    }
  }
  return best ?? points.slice(0, 4);
}
