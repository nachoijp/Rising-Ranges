// Geometry for the relief: points are [x, y] (cells, y down) or [x, y, h].
// Earcut alone from three (its own file, no other import): the background
// script measures with this and mustn't pull three in.
import { Earcut } from "three/src/extras/Earcut.js";
import type { Pt } from "./types";

export type Box = { x0: number; y0: number; x1: number; y1: number };
export type HPt = [number, number, number];

export function inRing(x: number, y: number, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[j];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) {
      inside = !inside;
    }
  }
  return inside;
}

/** Whether (x, y) is in an outline but in none of its holes. */
export function inShape(x: number, y: number, ring: Pt[], holes?: Pt[][]): boolean {
  return inRing(x, y, ring) && !(holes && holes.length > 0 && holes.some((hole) => inRing(x, y, hole)));
}

const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

export const open = (ring: Pt[]): Pt[] => (ring.length > 1 && same(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring);

export function closed(ring: Pt[]): Pt[] {
  const r = open(ring);
  return [...r, r[0]];
}

export function bbox(ring: Pt[]): Box {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const [x, y] of ring) {
    box.x0 = Math.min(box.x0, x);
    box.y0 = Math.min(box.y0, y);
    box.x1 = Math.max(box.x1, x);
    box.y1 = Math.max(box.y1, y);
  }
  return box;
}

export const inBox = (box: Box, x: number, y: number) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;

export function area(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

export function centroid(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}

/** Triangles of a polygon ([outer, ...holes], open rings): its points in order, and index triples. */
export function triangulate(polygon: Pt[][]): { pts: Pt[]; tris: [number, number, number][] } {
  const pts = polygon.flat();
  const holes: number[] = [];
  let at = 0;
  for (const ring of polygon) {
    if (at > 0) {
      holes.push(at);
    }
    at += ring.length;
  }
  const flat = Earcut.triangulate(pts.flat(), holes);
  const tris: [number, number, number][] = [];
  for (let k = 0; k + 2 < flat.length; k += 3) {
    tris.push([flat[k], flat[k + 1], flat[k + 2]]);
  }
  return { pts, tris };
}

const cross = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Every triangle turned the same way (counter-clockwise with y up, i.e. positive cross). */
export function ccw(pts: number[][], tris: number[][]) {
  for (const t of tris) {
    if (cross(pts[t[0]], pts[t[1]], pts[t[2]]) < 0) {
      [t[1], t[2]] = [t[2], t[1]];
    }
  }
}

function barycentric(a: number[], b: number[], c: number[], x: number, y: number): [number, number, number] | null {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < 1e-12) {
    return null;
  }
  const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
  const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
  return [u, v, 1 - u - v];
}

/** The height at (x, y) on a triangulation of [x, y, h] points, or undefined outside it. */
export function locate(pts: HPt[], tris: number[][], x: number, y: number): number | undefined {
  for (const t of tris) {
    const w = barycentric(pts[t[0]], pts[t[1]], pts[t[2]], x, y);
    if (w && w[0] >= -1e-7 && w[1] >= -1e-7 && w[2] >= -1e-7) {
      return w[0] * pts[t[0]][2] + w[1] * pts[t[1]][2] + w[2] * pts[t[2]][2];
    }
  }
  return undefined;
}

/**
 * The height at (x, y) from the triangle it's least outside of (a point a
 * hair past the outline: on its side there, not at a corner far off),
 * clamped onto it; undefined with no triangles.
 */
export function nearestOnTris(pts: HPt[], tris: number[][], x: number, y: number): number | undefined {
  let best: [number, number, number] | null = null;
  let at: number[] = [];
  let score = -Infinity;
  for (const t of tris) {
    const w = barycentric(pts[t[0]], pts[t[1]], pts[t[2]], x, y);
    if (w && Math.min(...w) > score) {
      score = Math.min(...w);
      best = w;
      at = t;
    }
  }
  if (!best) {
    return undefined;
  }
  const w = best.map((v) => Math.max(0, v));
  const sum = w[0] + w[1] + w[2] || 1;
  return (w[0] * pts[at[0]][2] + w[1] * pts[at[1]][2] + w[2] * pts[at[2]][2]) / sum;
}

export function nearestH(pts: HPt[], x: number, y: number): number {
  let best = 0;
  let d = Infinity;
  for (const p of pts) {
    const e = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (e < d) {
      d = e;
      best = p[2];
    }
  }
  return best;
}

const hasEdge = (t: number[], a: number, b: number) => (t[0] === a && t[1] === b) || (t[1] === a && t[2] === b) || (t[2] === a && t[0] === b);

function inCircle(a: number[], b: number[], c: number[], d: number[]): boolean {
  const [ax, ay] = [a[0] - d[0], a[1] - d[1]];
  const [bx, by] = [b[0] - d[0], b[1] - d[1]];
  const [cx, cy] = [c[0] - d[0], c[1] - d[1]];
  return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay) > 1e-12;
}

/**
 * A triangulation (counter-clockwise triangles) made Delaunay: the inside
 * edge of two triangles flipped while the far corner of one is inside the
 * other's circle (well inside: a tie, as a rectangle's two diagonals, keeps
 * the one it has) and the four make a convex quad. The outline's edges have
 * one triangle each, so they stay. No long thin triangles across a shape:
 * each joins the corners nearest it (an inclined shape's surface then
 * follows the heights beside it, not those far off).
 */
export function delaunay(pts: number[][], tris: number[][]) {
  const inside = (a: number[], b: number[], c: number[], d: number[]) => {
    const [ax, ay, bx, by, cx, cy] = [a[0] - d[0], a[1] - d[1], b[0] - d[0], b[1] - d[1], c[0] - d[0], c[1] - d[1]];
    const [la, lb, lc] = [ax * ax + ay * ay, bx * bx + by * by, cx * cx + cy * cy];
    const terms = [la * (bx * cy - cx * by), -lb * (ax * cy - cx * ay), lc * (ax * by - bx * ay)];
    const size = Math.abs(terms[0]) + Math.abs(terms[1]) + Math.abs(terms[2]);
    return terms[0] + terms[1] + terms[2] > 1e-9 * size;
  };
  for (let pass = 0, flipped = true; flipped && pass < 100; pass++) {
    flipped = false;
    for (let m = 0; m < tris.length; m++) {
      for (let e = 0; e < 3; e++) {
        const [u, v, c] = [tris[m][e], tris[m][(e + 1) % 3], tris[m][(e + 2) % 3]];
        const n = tris.findIndex((tr, k) => k !== m && hasEdge(tr, v, u));
        if (n < 0) {
          continue;
        }
        const w = tris[n].find((k) => k !== u && k !== v)!;
        if (inside(pts[u], pts[v], pts[c], pts[w]) && cross(pts[c], pts[w], pts[u]) * cross(pts[c], pts[w], pts[v]) < 0) {
          tris[m] = [u, w, c];
          tris[n] = [w, v, c];
          flipped = true;
          break;
        }
      }
    }
  }
}

/**
 * Points added inside a triangulation (counter-clockwise triangles): each
 * splits the triangle it's in (one on a side between two goes a hair into
 * one of them), then edges are flipped while a neighbour's corner is inside a
 * triangle's circle (Delaunay), never the outline's.
 */
export function insertPoints(pts: HPt[], tris: number[][], extra: HPt[]) {
  for (let p of extra) {
    const within = (tr: number[], e: number) => {
      const w = barycentric(pts[tr[0]], pts[tr[1]], pts[tr[2]], p[0], p[1]);
      return !!w && w[0] > e && w[1] > e && w[2] > e;
    };
    let t = tris.findIndex((tr) => within(tr, 1e-6));
    if (t < 0) {
      t = tris.findIndex((tr) => within(tr, -1e-9));
      if (t < 0) {
        continue;
      }
      const [a, b, c] = tris[t].map((k) => pts[k]);
      const [cx, cy] = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
      const len = Math.hypot(cx - p[0], cy - p[1]) || 1;
      p = [p[0] + ((cx - p[0]) / len) * 1e-4, p[1] + ((cy - p[1]) / len) * 1e-4, p[2]];
    }
    const i = pts.length;
    pts.push(p);
    const [a, b, c] = tris[t];
    tris.splice(t, 1, [a, b, i], [b, c, i], [c, a, i]);
    const stack: [number, number][] = [[a, b], [b, c], [c, a]];
    let guard = 0;
    while (stack.length > 0 && guard++ < 10000) {
      const [u, v] = stack.pop()!;
      const n = tris.findIndex((tr) => hasEdge(tr, v, u));
      if (n < 0) {
        continue;
      }
      const w = tris[n].find((k) => k !== u && k !== v)!;
      if (inCircle(pts[u], pts[v], pts[i], pts[w])) {
        const m = tris.findIndex((tr) => hasEdge(tr, u, v) && tr.includes(i));
        if (m < 0) {
          continue;
        }
        tris.splice(Math.max(m, n), 1);
        tris.splice(Math.min(m, n), 1);
        tris.push([u, w, i], [w, v, i]);
        stack.push([u, w], [w, v]);
      }
    }
  }
}
