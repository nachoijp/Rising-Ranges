// A relief from a Universal VTT file (.uvtt / .dd2vtt, made by Dungeondraft,
// Dungeon Alchemist and others): its walls and doors give the plan exactly,
// so nothing has to be guessed from the picture but what the file doesn't
// say. What it does:
//
// 1. The walls and doors as a planar graph (crossings and T-joints split,
//    ends that nearly meet joined). A door closes its gap, so every room is a
//    face of the graph: its outline comes from the plan, not the picture.
// 2. The walls as runs: chained through plain corners (an L is one run,
//    mitred), straight on through a crossing. A closed run that's round is
//    made a true circle.
// 3. Each run's thickness from the picture: the file has its middle line
//    only. Across the run, at stations along it, the colours are sampled and
//    their change summed with its sign: a face of the wall changes the same
//    way all along, so it adds up, while the stones, cracks and furniture
//    near it cancel out. The pair of faces (one to each side) that changes
//    most, nearest the line and most even, wins. A run the picture can't
//    tell gets the usual thickness of the others.
// 4. What a run is from its colour: green (a hedge) lower than a wall.
//    Small closed loops on their own (trees, statues, columns) are objects.
//
// All in cells of the map (x right, y down). The picture is optional: with
// none, every wall gets the usual thickness.

import type { Door, Group, Pt, ReliefData, Shape } from "../types";
import { openingFor } from "./doors";
import { solidAreas } from "./solids";
import type { Loop } from "./vector";

/** A map's picture: RGBA, `px` pixels per cell. */
export type Picture = { w: number; h: number; px: number; data: Uint8ClampedArray };

/** What's read from the file: in its own cells. */
export type Uvtt = {
  w: number;
  h: number;
  /** Its picture's pixels per cell. */
  ppg: number;
  walls: Pt[][];
  portals: [Pt, Pt][];
  /** Its picture, as base64 (png or webp), if it has one. */
  image?: string;
};

export type UvttNames = {
  group: string;
  rooms: string;
  walls: string;
  hedges: string;
  objects: string;
  stairs: string;
  room: (n: number) => string;
  wall: (n: number) => string;
  hedge: (n: number) => string;
  object: (n: number) => string;
  stair: (n: number) => string;
  solids: string;
  solid: (n: number) => string;
};

export type UvttOptions = {
  wallH?: number;
  hedgeH?: number;
  objectH?: number;
  /** Rooms as shapes of their own (at 0), to be given a height with a click. */
  rooms?: boolean;
  /** The group its own group goes in, if any. */
  parent?: string;
  /** Doors to add (see trace/fogPlan placeDoors). */
  doors?: Door[];
};

/** What was made, for the editor to say. */
export type UvttCounts = { rooms: number; walls: number; hedges: number; objects: number; stairs: number; solids: number; doors: number; measured: number; thickness: number };

type V = { x: number; y: number };

/** Ends nearer than this (cells) are one point. */
const TOL = 0.06;
/** Across a wall, how far either side is looked at (cells), and in what steps. */
const REACH = 0.8;
const STEP = 1 / 32;
/** Along a wall, cells between the stations looked across. */
const STATION = 0.2;
/** A closed loop on its own smaller than this (cells²) is an object, not a wall round a room. */
const OBJECT_AREA = 4;
/** The thickest a wall measured on the picture is believed (squares). */
const MAX_THICK = 0.9;
/** A face smaller than this (cells²) isn't a room. */
const ROOM_AREA = 1.5;

// ---------- Reading ----------

const isPt = (p: unknown): p is V => !!p && typeof (p as V).x === "number" && typeof (p as V).y === "number";

/** The file's walls and doors, or null if it isn't one. */
export function readUvtt(json: unknown): Uvtt | null {
  const j = json as {
    resolution?: { map_origin?: V; map_size?: V; pixels_per_grid?: number };
    line_of_sight?: unknown[];
    objects_line_of_sight?: unknown[];
    portals?: { bounds?: unknown[] }[];
    image?: string;
  };
  const size = j?.resolution?.map_size;
  if (!isPt(size) || !Array.isArray(j.line_of_sight)) {
    return null;
  }
  const o = isPt(j.resolution?.map_origin) ? j.resolution!.map_origin! : { x: 0, y: 0 };
  const pt = (p: V): Pt => [p.x - o.x, p.y - o.y];
  const lines = (list: unknown[] | undefined) =>
    (list ?? []).filter((l): l is V[] => Array.isArray(l) && l.length >= 2 && l.every(isPt)).map((l) => l.map(pt));
  const portals = (j.portals ?? [])
    .map((p) => p?.bounds)
    .filter((b): b is [V, V] => Array.isArray(b) && b.length >= 2 && isPt(b[0]) && isPt(b[1]))
    .map((b): [Pt, Pt] => [pt(b[0]), pt(b[1])]);
  return {
    w: size.x,
    h: size.y,
    ppg: j.resolution?.pixels_per_grid ?? 0,
    walls: [...lines(j.line_of_sight), ...lines(j.objects_line_of_sight)],
    portals,
    image: typeof j.image === "string" && j.image.length > 0 ? j.image : undefined,
  };
}

// ---------- The plan as a graph ----------

type Edge = { a: number; b: number; portal: boolean };
type Graph = { nodes: V[]; edges: Edge[] };

/** Walls and doors split where they meet, their ends joined; a wall over a door is a wall, unless `doorsWin` (Owlbear's fog: the room next door's edge runs over it). */
export function planGraph(walls: Pt[][], portals: [Pt, Pt][], doorsWin = false): Graph {
  const segs: { a: V; b: V; portal: boolean }[] = [];
  for (const line of walls) {
    for (let i = 1; i < line.length; i++) {
      segs.push({ a: { x: line[i - 1][0], y: line[i - 1][1] }, b: { x: line[i][0], y: line[i][1] }, portal: false });
    }
  }
  for (const [a, b] of portals) {
    segs.push({ a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] }, portal: true });
  }
  // Where each is cut (as fractions along it): by the others' ends on it, and where they cross.
  const cuts = segs.map(() => [0, 1]);
  const boxes = segs.map(({ a, b }) => [Math.min(a.x, b.x) - TOL, Math.min(a.y, b.y) - TOL, Math.max(a.x, b.x) + TOL, Math.max(a.y, b.y) + TOL]);
  for (let i = 0; i < segs.length; i++) {
    const { a, b } = segs[i];
    const rx = b.x - a.x, ry = b.y - a.y;
    const L2 = rx * rx + ry * ry;
    if (L2 < 1e-12) continue;
    for (let j = 0; j < segs.length; j++) {
      if (i === j) continue;
      const bi = boxes[i], bj = boxes[j];
      if (bj[0] > bi[2] || bj[2] < bi[0] || bj[1] > bi[3] || bj[3] < bi[1]) continue;
      const { a: c, b: d } = segs[j];
      for (const p of [c, d]) {
        const t = ((p.x - a.x) * rx + (p.y - a.y) * ry) / L2;
        if (t <= 0 || t >= 1) continue;
        if (Math.hypot(a.x + t * rx - p.x, a.y + t * ry - p.y) < TOL) cuts[i].push(t);
      }
      const sx = d.x - c.x, sy = d.y - c.y;
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
      const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
      if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) cuts[i].push(t);
    }
  }
  const nodes: V[] = [];
  const hash = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / TOL)},${Math.floor(y / TOL)}`;
  const node = (p: V) => {
    const gx = Math.floor(p.x / TOL), gy = Math.floor(p.y / TOL);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const k of hash.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (Math.hypot(nodes[k].x - p.x, nodes[k].y - p.y) < TOL) return k;
        }
    nodes.push({ x: p.x, y: p.y });
    const k = key(p.x, p.y);
    hash.set(k, [...(hash.get(k) ?? []), nodes.length - 1]);
    return nodes.length - 1;
  };
  const edges: Edge[] = [];
  const seen = new Map<string, number>();
  segs.forEach(({ a, b, portal }, i) => {
    const ts = [...new Set(cuts[i].map((t) => Math.round(t * 1e6) / 1e6))].sort((x, y) => x - y);
    for (let k = 1; k < ts.length; k++) {
      const at = (t: number) => ({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
      const n0 = node(at(ts[k - 1])), n1 = node(at(ts[k]));
      if (n0 === n1) continue;
      const id = n0 < n1 ? `${n0},${n1}` : `${n1},${n0}`;
      const had = seen.get(id);
      if (had === undefined) {
        seen.set(id, edges.push({ a: n0, b: n1, portal }) - 1);
      } else if (doorsWin) {
        edges[had].portal ||= portal;
      } else if (!portal) {
        // A wall over a door: a wall.
        edges[had].portal = false;
      }
    }
  });
  return { nodes, edges };
}

const signedArea = (ring: Pt[]) => {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
};

/** The bounded faces of the graph (dead ends left out): each an outline, clockwise on screen. */
export function faces(g: Graph): Pt[][] {
  const alive = g.edges.map(() => true);
  const degree = () => {
    const d = g.nodes.map(() => 0);
    g.edges.forEach((e, i) => {
      if (alive[i]) {
        d[e.a]++;
        d[e.b]++;
      }
    });
    return d;
  };
  for (;;) {
    const d = degree();
    let cut = false;
    g.edges.forEach((e, i) => {
      if (alive[i] && (d[e.a] === 1 || d[e.b] === 1)) {
        alive[i] = false;
        cut = true;
      }
    });
    if (!cut) break;
  }
  const adj: number[][] = g.nodes.map(() => []);
  g.edges.forEach((e, i) => {
    if (alive[i]) {
      adj[e.a].push(e.b);
      adj[e.b].push(e.a);
    }
  });
  const ang = (n: number, m: number) => Math.atan2(g.nodes[m].y - g.nodes[n].y, g.nodes[m].x - g.nodes[n].x);
  const used = new Set<string>();
  const out: Pt[][] = [];
  for (let s = 0; s < g.nodes.length; s++)
    for (const t of adj[s]) {
      if (used.has(`${s}>${t}`)) continue;
      const loop: number[] = [];
      let u = s, v = t, guard = 0;
      while (!used.has(`${u}>${v}`) && guard++ < 100000) {
        used.add(`${u}>${v}`);
        loop.push(u);
        // Next: the sharpest turn one way (so each face is walked round its inside).
        const back = ang(v, u);
        let best = -1, bestD = Infinity;
        for (const w of adj[v]) {
          if (w === u && adj[v].length > 1) continue;
          let d = back - ang(v, w);
          while (d <= 1e-9) d += 2 * Math.PI;
          if (d < bestD) {
            bestD = d;
            best = w;
          }
        }
        u = v;
        v = best;
      }
      const ring = loop.map((n): Pt => [g.nodes[n].x, g.nodes[n].y]);
      if (signedArea(ring) > 0) out.push(ring);
    }
  return out;
}

// ---------- Runs of wall ----------

/** A run: its middle line's nodes, whether it closes on itself, and how its ends meet other walls. */
export type Run = { nodes: number[]; closed: boolean; endsAtWall: [boolean, boolean] };

/** Turns (radians) a run is chained through at a plain corner, and straight on through a crossing. */
const CORNER = (100 * Math.PI) / 180;
const STRAIGHT = (12 * Math.PI) / 180;

export function wallRuns(g: Graph): Run[] {
  const walls = g.edges.map((_, i) => i).filter((i) => !g.edges[i].portal);
  const at: number[][] = g.nodes.map(() => []);
  for (const i of walls) {
    at[g.edges[i].a].push(i);
    at[g.edges[i].b].push(i);
  }
  const other = (i: number, n: number) => (g.edges[i].a === n ? g.edges[i].b : g.edges[i].a);
  const dir = (n: number, m: number) => Math.atan2(g.nodes[m].y - g.nodes[n].y, g.nodes[m].x - g.nodes[n].x);
  /** At each node, which edge goes on into which. */
  const pair = new Map<string, number>();
  g.nodes.forEach((_, n) => {
    const list = at[n];
    const turn = (i: number, j: number) => {
      let d = Math.abs(dir(n, other(i, n)) - dir(n, other(j, n)));
      if (d > Math.PI) d = 2 * Math.PI - d;
      return Math.PI - d;
    };
    if (list.length === 2) {
      if (turn(list[0], list[1]) < CORNER) {
        pair.set(`${n}:${list[0]}`, list[1]);
        pair.set(`${n}:${list[1]}`, list[0]);
      }
      return;
    }
    // A crossing: the straightest pairs go on, one at a time.
    const free = new Set(list);
    for (;;) {
      let best: [number, number] | null = null, bestT = STRAIGHT;
      for (const i of free)
        for (const j of free) {
          if (i < j && turn(i, j) < bestT) {
            bestT = turn(i, j);
            best = [i, j];
          }
        }
      if (!best) break;
      pair.set(`${n}:${best[0]}`, best[1]);
      pair.set(`${n}:${best[1]}`, best[0]);
      free.delete(best[0]);
      free.delete(best[1]);
    }
  });
  const done = new Set<number>();
  const runs: Run[] = [];
  const walk = (start: number, from: number): Run => {
    const nodes = [from];
    let e = start, n = from;
    for (;;) {
      done.add(e);
      n = other(e, n);
      nodes.push(n);
      const next = pair.get(`${n}:${e}`);
      if (next === undefined || done.has(next)) {
        const closed = next !== undefined && n === from;
        return { nodes: closed ? nodes.slice(0, -1) : nodes, closed, endsAtWall: [false, false] };
      }
      e = next;
    }
  };
  for (const i of walls) {
    if (done.has(i)) continue;
    // From an end of its chain: walk back first.
    let e = i, n = g.edges[i].a, guard = 0;
    for (;;) {
      const prev = pair.get(`${n}:${e}`);
      if (prev === undefined || prev === i || guard++ > walls.length) break;
      e = prev;
      n = other(prev, n);
    }
    const run = walk(e, n);
    runs.push(run);
  }
  for (const run of runs) {
    if (run.closed) continue;
    const ends = [run.nodes[0], run.nodes[run.nodes.length - 1]];
    run.endsAtWall = ends.map((n) => at[n].length >= 2) as [boolean, boolean];
  }
  return runs;
}

/** A line's points without those it only passes straight through. */
function straighten(pts: Pt[], closed: boolean): Pt[] {
  if (pts.length < 3) return pts;
  const keep: Pt[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) {
      keep.push(pts[i]);
      continue;
    }
    const p = pts[(i - 1 + n) % n], c = pts[i], q = pts[(i + 1) % n];
    const a1 = Math.atan2(c[1] - p[1], c[0] - p[0]), a2 = Math.atan2(q[1] - c[1], q[0] - c[0]);
    let d = Math.abs(a1 - a2);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > (2 * Math.PI) / 180) keep.push(c);
  }
  return keep.length >= (closed ? 3 : 2) ? keep : pts;
}

/** A closed loop that's nearly a circle, as a true one (else null). */
export function roundLoop(pts: Pt[]): Pt[] | null {
  if (pts.length < 8) return null;
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const r = pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy));
  const mean = r.reduce((s, v) => s + v, 0) / r.length;
  const sd = Math.sqrt(r.reduce((s, v) => s + (v - mean) ** 2, 0) / r.length);
  if (sd / mean > 0.06) return null;
  const n = Math.max(16, Math.min(48, Math.round(mean * 12)));
  return Array.from({ length: n }, (_, i): Pt => [cx + mean * Math.cos((2 * Math.PI * i) / n), cy + mean * Math.sin((2 * Math.PI * i) / n)]);
}

// ---------- Thickness from the picture ----------

/** CIE Lab of a picture, per pixel. */
export function labOf(pic: Picture): Float32Array {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const L = Float32Array.from({ length: 256 }, (_, i) => lin(i));
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const n = pic.w * pic.h;
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = L[pic.data[i * 4]], g = L[pic.data[i * 4 + 1]], b = L[pic.data[i * 4 + 2]];
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
    const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    lab[i * 3] = 116 * y - 16;
    lab[i * 3 + 1] = 500 * (x - y);
    lab[i * 3 + 2] = 200 * (y - z);
  }
  return lab;
}

/** A run measured: how far each face is from its line (left: negative side of its normal), how sure, its colour. */
export type Measure = { left: number; right: number; sure: boolean; lab: [number, number, number] | null; profile?: number[] };

/**
 * Its faces from the picture (see the top). `normals` per segment of the
 * line; stations where another wall's too near (its corners, its ends at a
 * joint) are skipped.
 */
export function measureRun(pic: Picture, lab: Float32Array, line: Pt[], closed: boolean, skipEnds: [boolean, boolean]): Measure {
  const K = Math.round((2 * REACH) / STEP) + 1;
  const sum = new Float64Array(K * 3); // the signed change, summed
  const abs = new Float64Array(K); // its size, summed
  const mean = new Float64Array(K * 3); // the colours, summed
  let count = 0;
  const sample = (x: number, y: number, out: number[]) => {
    const px = x * pic.px - 0.5, py = y * pic.px - 0.5;
    const x0 = Math.max(0, Math.min(pic.w - 2, Math.floor(px))), y0 = Math.max(0, Math.min(pic.h - 2, Math.floor(py)));
    const fx = Math.max(0, Math.min(1, px - x0)), fy = Math.max(0, Math.min(1, py - y0));
    for (let c = 0; c < 3; c++) {
      const i = (y0 * pic.w + x0) * 3 + c;
      const top = lab[i] * (1 - fx) + lab[i + 3] * fx;
      const bot = lab[i + pic.w * 3] * (1 - fx) + lab[i + pic.w * 3 + 3] * fx;
      out[c] = top * (1 - fy) + bot * fy;
    }
  };
  const n = line.length;
  const segs = closed ? n : n - 1;
  // The corners a station keeps away from.
  const corner: boolean[] = line.map((c, i) => {
    if (!closed && (i === 0 || i === n - 1)) return i === 0 ? skipEnds[0] : skipEnds[1];
    const p = line[(i - 1 + n) % n], q = line[(i + 1) % n];
    const a1 = Math.atan2(c[1] - p[1], c[0] - p[0]), a2 = Math.atan2(q[1] - c[1], q[0] - c[0]);
    let d = Math.abs(a1 - a2);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d > (20 * Math.PI) / 180;
  });
  const prof = Array.from({ length: K }, () => [0, 0, 0]);
  for (const margin of [0.6, 0.3]) {
    for (let s = 0; s < segs; s++) {
      const a = line[s], b = line[(s + 1) % n];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) continue;
      const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len;
      const nx = -dy, ny = dx;
      const from = corner[s] ? margin : 0.1, to = len - (corner[(s + 1) % n] ? margin : 0.1);
      for (let d = from + ((to - from) % STATION) / 2; d <= to + 1e-9; d += STATION) {
        const cx = a[0] + dx * d, cy = a[1] + dy * d;
        for (let k = 0; k < K; k++) {
          const o = -REACH + k * STEP;
          sample(cx + nx * o, cy + ny * o, prof[k]);
        }
        for (let k = 0; k < K; k++) {
          for (let c = 0; c < 3; c++) mean[k * 3 + c] += prof[k][c];
          if (k === 0 || k === K - 1) continue;
          let m = 0;
          for (let c = 0; c < 3; c++) {
            const dv = prof[k + 1][c] - prof[k - 1][c];
            sum[k * 3 + c] += dv;
            m += dv * dv;
          }
          abs[k] += Math.sqrt(m);
        }
        count++;
      }
    }
    if (count >= 3) break;
  }
  if (count < 3) return { left: 0, right: 0, sure: false, lab: null };
  const E = new Array<number>(K).fill(0);
  for (let k = 1; k < K - 1; k++) {
    const s = Math.hypot(sum[k * 3], sum[k * 3 + 1], sum[k * 3 + 2]) / count;
    E[k] = 0.65 * s + 0.35 * (abs[k] / count);
  }
  const top = Math.max(...E);
  if (top <= 0) return { left: 0, right: 0, sure: false, lab: null };
  const e = E.map((v) => v / top);
  const off = (k: number) => -REACH + k * STEP;
  const peaks = (side: -1 | 1) => {
    const out: number[] = [];
    for (let k = 2; k < K - 2; k++) {
      const o = off(k);
      if (o * side < 0.05) continue;
      if (e[k] >= e[k - 1] && e[k] >= e[k + 1] && e[k] > 0.15) out.push(k);
    }
    return out;
  };
  // The pair of faces: strong, near the line, even about it.
  let best: [number, number] | null = null, bestScore = -Infinity;
  for (const l of peaks(-1))
    for (const r of peaks(1)) {
      const a = -off(l), b = off(r);
      const score = e[l] + e[r] - 0.8 * Math.abs(a - b) - 0.35 * (a + b);
      if (score > bestScore) {
        bestScore = score;
        best = [l, r];
      }
    }
  const sorted = [...e.slice(1, -1)].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!best) return { left: 0, right: 0, sure: false, lab: null, profile: e };
  const [l, r] = best;
  const sure = (e[l] + e[r]) / 2 > Math.max(0.45, 2.2 * median);
  // The wall's own colour: between its faces.
  const col: [number, number, number] = [0, 0, 0];
  let m = 0;
  for (let k = l + 1; k < r; k++) {
    for (let c = 0; c < 3; c++) col[c] += mean[k * 3 + c] / count;
    m++;
  }
  return { left: -off(l), right: off(r), sure, lab: m ? (col.map((v) => v / m) as [number, number, number]) : null, profile: e };
}

/** A colour that's a hedge's (green, not dark). */
const greenish = (lab: [number, number, number] | null) => !!lab && lab[1] < -8 && lab[2] > 4 && lab[0] > 15;

// ---------- Stairs from the picture ----------

/** A stair found: its box (cells), which way it climbs (x or y), its steps. */
export type Stair = { x0: number; y0: number; x1: number; y1: number; axis: "x" | "y"; steps: number; score: number };

/** How stair-like a window must be, and the least a stair covers (cells²). */
const STAIR_SCORE = 0.3;
const STAIR_AREA = 1.5;
/** A stair's narrower side, and its step, at the least (cells): finer stripes are leaves, joints, weave. */
const STAIR_SIDE = 1.5;
const STAIR_STEP = 0.16;

/**
 * Stairs, which the plan doesn't have: a window of one cell, every quarter
 * cell, is folded across (its rows averaged) both ways. A stair's edges run
 * right across it, so the fold keeps them (a texture's don't line up, and
 * blur away), and they repeat: the fold correlates with itself one step and
 * two steps on. Windows like that, side by side, the same way, are a stair.
 */
export function findStairs(pic: Picture): Stair[] {
  const { w: W, h: H, px } = pic;
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = 0.3 * pic.data[i * 4] + 0.59 * pic.data[i * 4 + 1] + 0.11 * pic.data[i * 4 + 2];
  const S = px, step = Math.max(1, Math.round(px / 4));
  const nx = Math.floor((W - S) / step) + 1, ny = Math.floor((H - S) / step) + 1;
  const score = [new Float32Array(nx * ny), new Float32Array(nx * ny)];
  const period = [new Float32Array(nx * ny), new Float32Array(nx * ny)];
  const prof = new Float64Array(S);
  const lo = Math.max(2, Math.round(S * 0.12)), hi = Math.round(S * 0.5);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x0 = i * step, y0 = j * step;
      for (const axis of [0, 1]) {
        prof.fill(0);
        let rowVar = 0;
        for (let a = 0; a < S; a++) {
          let m = 0, m2 = 0;
          for (let b = 0; b < S; b++) {
            const v = axis ? L[(y0 + b) * W + x0 + a] : L[(y0 + a) * W + x0 + b];
            prof[b] += v;
            m += v;
            m2 += v * v;
          }
          m /= S;
          rowVar += m2 / S - m * m;
        }
        rowVar /= S;
        let pm = 0;
        for (let b = 0; b < S; b++) pm += (prof[b] /= S);
        pm /= S;
        let pv = 0;
        for (let b = 0; b < S; b++) {
          prof[b] -= pm;
          pv += prof[b] * prof[b];
        }
        pv /= S;
        if (rowVar <= 1 || pv <= 0) continue;
        const corr = (lag: number) => {
          let c = 0;
          for (let b = 0; b + lag < S; b++) c += prof[b] * prof[b + lag];
          return c / ((S - lag) * pv);
        };
        let best = 0, lag = 0;
        for (let l = lo; l <= hi; l++) {
          const c = corr(l);
          if (c > best) {
            best = c;
            lag = l;
          }
        }
        const twice = lag && 2 * lag < S ? corr(2 * lag) : 0;
        score[axis][j * nx + i] = (pv / rowVar) * best * Math.max(0, twice) * Math.min(1, Math.sqrt(pv) / 12);
        period[axis][j * nx + i] = lag / px;
      }
    }
  // Side by side, the same way: one stair.
  const seen = new Uint8Array(nx * ny);
  const out: Stair[] = [];
  for (const axis of [0, 1]) {
    seen.fill(0);
    for (let start = 0; start < nx * ny; start++) {
      if (seen[start] || score[axis][start] < STAIR_SCORE || score[axis][start] < score[1 - axis][start]) continue;
      const stack = [start];
      seen[start] = 1;
      const cells: number[] = [];
      while (stack.length) {
        const c = stack.pop()!;
        cells.push(c);
        const ci = c % nx, cj = (c - ci) / nx;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const i2 = ci + di, j2 = cj + dj;
          if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) continue;
          const k = j2 * nx + i2;
          if (seen[k] || score[axis][k] < STAIR_SCORE * 0.6 || score[axis][k] < score[1 - axis][k]) continue;
          seen[k] = 1;
          stack.push(k);
        }
      }
      const cell = (step / px) ** 2;
      if (cells.length * cell < STAIR_AREA) continue;
      // Its box: the windows' middles, and half a window round them less what's only partly stair.
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, sum = 0;
      const periods: number[] = [];
      for (const c of cells) {
        const ci = c % nx, cj = (c - ci) / nx;
        const cx = (ci * step + S / 2) / px, cy = (cj * step + S / 2) / px;
        x0 = Math.min(x0, cx);
        y0 = Math.min(y0, cy);
        x1 = Math.max(x1, cx);
        y1 = Math.max(y1, cy);
        sum += score[axis][c];
        periods.push(period[axis][c]);
      }
      periods.sort((a, b) => a - b);
      const p = periods[Math.floor(periods.length / 2)];
      const pad = 0.4;
      const box = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
      const len = axis ? box.y1 - box.y0 : box.x1 - box.x0;
      if (p < STAIR_STEP || Math.min(box.x1 - box.x0, box.y1 - box.y0) < STAIR_SIDE) continue;
      out.push({ ...box, axis: axis ? "y" : "x", steps: Math.max(2, Math.round(len / p)), score: sum / cells.length });
    }
  }
  return out;
}

// ---------- Walls or ways through, along a line ----------

/** Cells between the stations looked across, and the least stretch of a way through (a door) and of a wall. */
const OPEN_STATION = 0.125;
const OPEN_MIN = 0.6;
const WALL_MIN = 0.3;
/** A bit of wall with ways through on both sides, shorter than this, isn't one. */
const LONE_MIN = 1;
/** How near a door (squares) a wall's line is a way through. */
const DOOR_NEAR = 0.3;
/** How unlike the ground on both sides (Lab ΔE) a band must look to be a wall. */
const WALL_DE = 12;
/** Each half of a band this like its own side (ΔE): a border between two floors, not a wall. */
const BORDER_DE = 8;
/** How far off the line (cells) a wall's middle is looked for: the line may run along one of its faces. */
const SHIFT = 0.3;

/** How far a point is from a segment. */
function segDist(x: number, y: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
  return Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y);
}

/** A Lab colour of the picture at a point (cells), bilinear. */
function labAt(pic: Picture, lab: Float32Array, x: number, y: number, out: number[]) {
  const px = x * pic.px - 0.5, py = y * pic.px - 0.5;
  const x0 = Math.max(0, Math.min(pic.w - 2, Math.floor(px))), y0 = Math.max(0, Math.min(pic.h - 2, Math.floor(py)));
  const fx = Math.max(0, Math.min(1, px - x0)), fy = Math.max(0, Math.min(1, py - y0));
  for (let c = 0; c < 3; c++) {
    const i = (y0 * pic.w + x0) * 3 + c;
    const top = lab[i] * (1 - fx) + lab[i + 3] * fx;
    const bot = lab[i + pic.w * 3] * (1 - fx) + lab[i + pic.w * 3 + 3] * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
}

/** The part of a line from `s0` to `s1` along it (cells; a closed one's may start before 0, going round). */
function cutLine(line: Pt[], closed: boolean, s0: number, s1: number): Pt[] {
  // The line with its distances, twice round for a closed one.
  const pts: Pt[] = closed ? [...line, ...line, line[0]] : line;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = closed ? cum[line.length] : cum[cum.length - 1];
  if (closed && s0 < 0) {
    s0 += total;
    s1 += total;
  }
  const at = (s: number): Pt => {
    let i = 1;
    while (i < pts.length - 1 && cum[i] < s) i++;
    const span = cum[i] - cum[i - 1] || 1, t = Math.max(0, Math.min(1, (s - cum[i - 1]) / span));
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  };
  const out: Pt[] = [at(s0)];
  for (let i = 0; i < pts.length; i++) if (cum[i] > s0 + 1e-9 && cum[i] < s1 - 1e-9) out.push(pts[i]);
  out.push(at(s1));
  return out;
}

/**
 * The stations along a line, every eighth of a cell (`step` apart, `total`
 * long), for a wall `t` thick: at each, how unlike the ground on both sides
 * (ΔE) the band most like a wall near it is.
 */
export function stationsOf(pic: Picture, lab: Float32Array, line: Pt[], closed: boolean, t: number, open: (x: number, y: number) => boolean = () => false): { scores: Float32Array; step: number; total: number } {
  const n = line.length, segs = closed ? n : n - 1;
  const segLen = (i: number) => Math.hypot(line[(i + 1) % n][0] - line[i][0], line[(i + 1) % n][1] - line[i][1]);
  let total = 0;
  for (let i = 0; i < segs; i++) total += segLen(i);
  const count = Math.max(1, Math.round(total / OPEN_STATION));
  const step = total / count;
  const half = Math.max(0.06, t / 2);
  // Samples across, every 1/32 cell, far enough for the band anywhere in reach and its sides.
  const R = SHIFT + half + 0.45, K = Math.round(2 * R * 32) + 1;
  const px = [0, 0, 0];
  const cum = Array.from({ length: K + 1 }, () => [0, 0, 0]);
  const meanOf = (o0: number, o1: number) => {
    const k0 = Math.max(0, Math.round((o0 + R) * 32)), k1 = Math.min(K - 1, Math.round((o1 + R) * 32));
    const m = k1 - k0 + 1;
    return [0, 1, 2].map((c) => (cum[k1 + 1][c] - cum[k0][c]) / m);
  };
  const dE = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  // How unlike its sides a band (from o0 to o1) is: none when it splits into its two sides' grounds (a border between two floors).
  const apart = (o0: number, o1: number) => {
    const before = meanOf(o0 - 0.45, o0 - 0.12), after = meanOf(o1 + 0.12, o1 + 0.45);
    for (let m = o0 + 1 / 16; m < o1 - 1 / 32; m += 1 / 16) if (dE(meanOf(o0, m), before) < BORDER_DE && dE(meanOf(m, o1), after) < BORDER_DE) return 0;
    const band = meanOf(o0, o1);
    return Math.min(dE(band, before), dE(band, after));
  };
  const scores = new Float32Array(count);
  let seg = 0, segStart = 0;
  for (let k = 0; k < count; k++) {
    const s = (k + 0.5) * step;
    while (seg < segs - 1 && s > segStart + segLen(seg)) {
      segStart += segLen(seg);
      seg++;
    }
    const a = line[seg], b = line[(seg + 1) % n], len = segLen(seg) || 1;
    const f = (s - segStart) / len;
    const cx = a[0] + (b[0] - a[0]) * f, cy = a[1] + (b[1] - a[1]) * f;
    const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
    // A door there (its own, or the room next door's on an edge that doesn't quite meet it): wall, the door
    // cut through it in the scene (see doorCut.ts).
    if (open(cx, cy)) {
      scores[k] = Infinity;
      continue;
    }
    for (let i = 0; i < K; i++) {
      labAt(pic, lab, cx + nx * (-R + i / 32), cy + ny * (-R + i / 32), px);
      for (let c = 0; c < 3; c++) cum[i + 1][c] = cum[i][c] + px[c];
    }
    // The band's middle, anywhere within reach of the line: the line may run along a face.
    for (let c = -SHIFT; c <= SHIFT + 1e-9; c += 1 / 16) scores[k] = Math.max(scores[k], apart(c - half, c + half));
  }
  return { scores, step, total };
}

/**
 * Where along a line the picture has a wall and where the ground runs on
 * across it: a door, an arch, one room into the next. A station is wall
 * where a band as thick as the wall, near the line, looks unlike the ground
 * on both sides. Ways through shorter than a door, and bits of wall shorter
 * than a post, don't count. (A door drawn shut reads as wall: its plank and
 * posts are the walls' own colours.)
 */
export function wallPieces(
  run: { scores: Float32Array; step: number; total: number },
  line: Pt[],
  closed: boolean,
): { whole: boolean; walls: { line: Pt[]; first: boolean; last: boolean }[]; open: Pt[][] } {
  const { scores, step, total } = run;
  const count = scores.length;
  const raw = Array.from(scores, (v) => v >= WALL_DE);
  // Steadied: the most of five.
  const at = (k: number) => (closed ? raw[((k % count) + count) % count] : raw[Math.max(0, Math.min(count - 1, k))]);
  const wall = raw.map((_, k) => [-2, -1, 0, 1, 2].filter((d) => at(k + d)).length >= 3);
  // Stretches of one kind: [start station, end station (excl.), kind].
  const stretches = (): [number, number, boolean][] => {
    const out: [number, number, boolean][] = [];
    for (let k = 0; k < count; ) {
      let e = k;
      while (e < count && wall[e] === wall[k]) e++;
      out.push([k, e, wall[k]]);
      k = e;
    }
    // Round a closed line, the last stretch goes on into the first.
    if (closed && out.length > 1 && out[0][2] === out[out.length - 1][2]) {
      const last = out.pop()!;
      out[0] = [last[0] - count, out[0][1], out[0][2]];
    }
    return out;
  };
  const set = (s: number, e: number, v: boolean) => {
    for (let i = s; i < e; i++) wall[((i % count) + count) % count] = v;
  };
  const flip = (kind: boolean, least: number) => {
    for (const [s, e, k] of stretches()) if (k === kind && (e - s) * step < least) set(s, e, !kind);
  };
  flip(false, OPEN_MIN);
  flip(true, WALL_MIN);
  // A short bit of wall with ways through on both sides is something drawn there (a table's edge), not a wall.
  const now = stretches();
  if (now.length > 1) {
    for (const [s, e, k] of now) if (k && (closed || (s > 0 && e < count)) && (e - s) * step < LONE_MIN) set(s, e, false);
  }
  if (wall.every((v) => v)) return { whole: true, walls: [], open: [] };
  const walls: { line: Pt[]; first: boolean; last: boolean }[] = [];
  const open: Pt[][] = [];
  for (const [s, e, k] of stretches()) {
    const s0 = s === 0 && !closed ? 0 : s * step, s1 = e === count && !closed ? total : e * step;
    const piece = cutLine(line, closed, s0, s1);
    if (k) walls.push({ line: piece, first: !closed && s === 0, last: !closed && e === count });
    else open.push(piece);
  }
  return { whole: false, walls, open };
}

// ---------- Outlines ----------

/** The outline round a line, `left`/`right` off it (a closed line: its outer ring and its hole). */
export function bandRings(line: Pt[], closed: boolean, left: number, right: number, ext: [number, number] = [0, 0]): Pt[][] {
  const n = line.length;
  const pts = line.map((p): Pt => [p[0], p[1]]);
  if (!closed) {
    // Longer at the ends that meet a wall, to fill the joint.
    const grow = (i: number, j: number, by: number) => {
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) || 1;
      pts[i] = [pts[i][0] + ((pts[i][0] - pts[j][0]) / d) * by, pts[i][1] + ((pts[i][1] - pts[j][1]) / d) * by];
    };
    grow(0, 1, ext[0]);
    grow(n - 1, n - 2, ext[1]);
  }
  const offset = (by: number): Pt[] =>
    pts.map((c, i) => {
      const hasPrev = closed || i > 0, hasNext = closed || i < n - 1;
      const p = pts[(i - 1 + n) % n], q = pts[(i + 1) % n];
      const nrm = (a: Pt, b: Pt): Pt => {
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [-(b[1] - a[1]) / d, (b[0] - a[0]) / d];
      };
      const n1 = hasPrev ? nrm(p, c) : nrm(c, q);
      const n2 = hasNext ? nrm(c, q) : n1;
      let mx = n1[0] + n2[0], my = n1[1] + n2[1];
      const ml = Math.hypot(mx, my) || 1;
      mx /= ml;
      my /= ml;
      const cos = Math.max(0.35, mx * n1[0] + my * n1[1]);
      return [c[0] + (mx * by) / cos, c[1] + (my * by) / cos];
    });
  const l = offset(-left), r = offset(right);
  if (closed) {
    return Math.abs(signedArea(l)) > Math.abs(signedArea(r)) ? [l, r] : [r, l];
  }
  return [[...l, ...r.reverse()]];
}

// ---------- The relief ----------

/** How a plan's lines are taken: `openings`, its edges may be ways through (Owlbear's fog: the picture tells); `lab`, the picture's Lab if already worked out. */
export type PlanOptions = { openings?: boolean; lab?: Float32Array };

export type UvttPlan = {
  graph: Graph;
  rooms: Pt[][];
  /** Each run's outline (with `parts`, the outlines of its pieces, each a shape); `open`: the stretches of its line the picture has no wall on (with `openings`). */
  runs: { run: Run; line: Pt[]; m: Measure; kind: "wall" | "hedge" | "object"; rings: Pt[][]; open: Pt[][]; parts?: { line: Pt[]; rings: Pt[][] }[] }[];
  thickness: number;
  stairs: Stair[];
  /** Areas that are rock, not ground (see solids.ts). */
  solids: Loop[];
};

/** Everything worked out, before it's made shapes (the bench draws this). */
export function planOf(u: Pick<Uvtt, "walls" | "portals">, pic: Picture | null, scale: [number, number] = [1, 1], stairs = true, o: PlanOptions = {}): UvttPlan {
  const sc = (l: Pt[]) => l.map((p): Pt => [p[0] * scale[0], p[1] * scale[1]]);
  // Its doors are wall: the wall runs on over a door, cut through only in the scene (see doorCut.ts), as
  // open as its fog door is.
  const graph = planGraph([...u.walls.map(sc), ...u.portals.map(sc)], [], o.openings);
  const lab = pic ? (o.lab ?? labOf(pic)) : null;
  const runs = wallRuns(graph).map((run) => {
    let line = straighten(
      run.nodes.map((k): Pt => [graph.nodes[k].x, graph.nodes[k].y]),
      run.closed,
    );
    const area = run.closed ? Math.abs(signedArea(line)) : 0;
    const round = run.closed ? roundLoop(line) : null;
    if (round) line = round;
    const isObject = !o.openings && run.closed && area < OBJECT_AREA;
    const m: Measure = pic && lab && !isObject ? measureRun(pic, lab, line, run.closed, run.endsAtWall) : { left: 0, right: 0, sure: false, lab: null };
    return { run, line, m, kind: (isObject ? "object" : !o.openings && greenish(m.lab) ? "hedge" : "wall") as "wall" | "hedge" | "object", rings: [] as Pt[][], open: [] as Pt[][], parts: undefined as { line: Pt[]; rings: Pt[][] }[] | undefined };
  });
  // A wall thicker than this isn't one the picture told right (a line along a rock's dark edge).
  const believed = (m: Measure) => m.sure && m.left + m.right <= MAX_THICK;
  for (const r of runs) r.m.sure = believed(r.m);
  // The usual thickness: of the walls the picture told surely.
  const sure = runs.filter((r) => r.m.sure && r.kind === "wall").map((r) => r.m.left + r.m.right).sort((a, b) => a - b);
  const thickness = sure.length ? sure[Math.floor(sure.length / 2)] : 0.3;
  for (const r of runs) {
    if (!r.m.sure) {
      r.m.left = r.m.right = thickness / 2;
    }
  }
  // How far a wall's end runs on into a joint: to the far face of the walls it meets there.
  const through = new Map<number, { r: (typeof runs)[number]; j: number }[]>();
  runs.forEach((r) => {
    if (r.kind !== "object") r.run.nodes.forEach((k, j) => through.set(k, [...(through.get(k) ?? []), { r, j }]));
  });
  const P = (k: number): Pt => [graph.nodes[k].x, graph.nodes[k].y];
  const reach = (r: (typeof runs)[number], end: 0 | 1) => {
    const ns = r.run.nodes;
    const k = end ? ns[ns.length - 1] : ns[0];
    const [ex, ey] = P(k), [px, py] = P(end ? ns[ns.length - 2] : ns[1]);
    const d = Math.hypot(ex - px, ey - py) || 1;
    const ux = (ex - px) / d, uy = (ey - py) / d;
    let most = 0;
    for (const { r: o, j } of through.get(k) ?? []) {
      if (o === r) continue;
      const on = o.run.nodes;
      const a = P(on[j > 0 ? j - 1 : j]), b = P(on[j > 0 ? j : Math.min(j + 1, on.length - 1)]);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      // Its normal (+: its right face).
      const s = (ux * -(b[1] - a[1]) + uy * (b[0] - a[0])) / len;
      if (Math.abs(s) < 0.3) continue;
      most = Math.max(most, (s > 0 ? o.m.right : o.m.left) / Math.abs(s));
    }
    return Math.min(1, most);
  };
  // With openings: every wall's stations.
  const cuts = new Map<(typeof runs)[number], ReturnType<typeof stationsOf>>();
  if (o.openings && pic && lab) {
    const doors = u.portals.map(sc);
    const nearDoor = (x: number, y: number) => doors.some(([a, b]) => segDist(x, y, a, b) < DOOR_NEAR);
    for (const r of runs) if (r.kind !== "object") cuts.set(r, stationsOf(pic, lab, r.line, r.run.closed, Math.min(0.6, Math.max(0.15, r.m.left + r.m.right)), nearDoor));
  }
  for (const r of runs) {
    if (r.kind === "object") {
      r.rings = [r.line];
      continue;
    }
    const ext: [number, number] = r.run.closed ? [0, 0] : [r.run.endsAtWall[0] ? reach(r, 0) : 0, r.run.endsAtWall[1] ? reach(r, 1) : 0];
    if (o.openings && cuts.has(r)) {
      // Only where the picture has a wall: the rest is a way through. Each piece its own faces.
      const pieces = wallPieces(cuts.get(r)!, r.line, r.run.closed);
      r.open = pieces.open;
      if (pieces.whole) {
        r.rings = bandRings(r.line, r.run.closed, r.m.left, r.m.right, ext);
      } else {
        // Each piece an outline of its own (a shape each: they're not one outline and its holes).
        r.parts = pieces.walls.map((p) => {
          const own = measureRun(pic!, lab!, p.line, false, [p.first && r.run.endsAtWall[0], p.last && r.run.endsAtWall[1]]);
          const [lf, rt] = believed(own) ? [own.left, own.right] : [r.m.left, r.m.right];
          return { line: p.line, rings: bandRings(p.line, false, lf, rt, [p.first ? ext[0] : 0, p.last ? ext[1] : 0]) };
        });
        r.rings = r.parts.flatMap((p) => p.rings);
      }
    } else {
      r.rings = bandRings(r.line, r.run.closed, r.m.left, r.m.right, ext);
    }
  }
  if (o.openings) {
    // A run that's all way through is no wall at all.
    for (let i = runs.length - 1; i >= 0; i--) if (runs[i].kind !== "object" && runs[i].rings.length === 0) runs.splice(i, 1);
  }
  const objectAreas = runs.filter((r) => r.kind === "object").map((r) => Math.abs(signedArea(r.line)));
  const rooms = faces(graph)
    .map((f) => straighten(f, true))
    .filter((f) => {
      const a = Math.abs(signedArea(f));
      // An object's own loop is its inside, not a room.
      return a >= ROOM_AREA && !objectAreas.some((o) => Math.abs(o - a) < 0.05 * a);
    });
  return { graph, rooms, runs, thickness, stairs: pic && stairs ? findStairs(pic) : [], solids: [] };
}

const newId = () => Math.random().toString(36).slice(2, 8);

/** The plan as shapes, added on top of `base`, in a group of its own. */
export function uvttRelief(plan: UvttPlan, base: ReliefData, names: UvttNames, o: UvttOptions = {}): { data: ReliefData; counts: UvttCounts } {
  const { wallH = 2, hedgeH = 1, objectH = 2, rooms = true } = o;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const verts = [...base.verts];
  const shapes: Shape[] = [];
  const top: Group = o.parent ? { id: newId(), name: names.group, parent: o.parent } : { id: newId(), name: names.group };
  const groups: Group[] = [top];
  const sub = (name: string) => {
    const g: Group = { id: newId(), name, parent: top.id };
    groups.push(g);
    return g.id;
  };
  // Every shape at its own height, not over what's under it: a room ringed by rock would stand on the rock.
  const indices = (ring: Pt[]) => ring.map(([x, y]) => verts.push({ x: r2(x), y: r2(y), h: 0 }) - 1);
  const add = (rings: Pt[][], shape: Omit<Shape, "ring" | "holes">) => {
    const [ring, ...holes] = rings;
    if (!ring || ring.length < 3) return;
    const s: Shape = { ...shape, ring: indices(ring) };
    if (holes.length) s.holes = holes.map(indices);
    shapes.push(s);
  };
  const counts: UvttCounts = { rooms: 0, walls: 0, hedges: 0, objects: 0, stairs: 0, solids: 0, doors: o.doors?.length ?? 0, measured: 0, thickness: plan.thickness };
  if (plan.solids.length) {
    const g = sub(names.solids);
    plan.solids.forEach((l) => add([l.ring, ...l.holes], { kind: "flat", h: wallH, rel: false, name: names.solid(++counts.solids), group: g }));
  }
  if (rooms && plan.rooms.length) {
    const g = sub(names.rooms);
    plan.rooms.forEach((ring) => add([ring], { kind: "flat", h: 0, rel: false, name: names.room(++counts.rooms), group: g }));
  }
  const objects = plan.runs.filter((r) => r.kind === "object");
  if (objects.length) {
    const g = sub(names.objects);
    objects.forEach((r) => (r.parts?.map((p) => p.rings) ?? [r.rings]).forEach((rings) => add(rings, { kind: "flat", h: objectH, rel: false, name: names.object(++counts.objects), group: g })));
  }
  const hedges = plan.runs.filter((r) => r.kind === "hedge");
  if (hedges.length) {
    const g = sub(names.hedges);
    hedges.forEach((r) => (r.parts?.map((p) => p.rings) ?? [r.rings]).forEach((rings) => add(rings, { kind: "flat", h: hedgeH, rel: false, name: names.hedge(++counts.hedges), group: g })));
  }
  const walls = plan.runs.filter((r) => r.kind === "wall");
  if (walls.length) {
    const g = sub(names.walls);
    walls.forEach((r) => (r.parts?.map((p) => p.rings) ?? [r.rings]).forEach((rings) => add(rings, { kind: "flat", h: wallH, rel: false, name: names.wall(++counts.walls), group: g })));
  }
  if (plan.stairs.length) {
    const g = sub(names.stairs);
    for (const st of plan.stairs) {
      const my = (st.y0 + st.y1) / 2, mx = (st.x0 + st.x1) / 2;
      const ramp = st.axis === "x" ? { a: [st.x0, my] as Pt, b: [st.x1, my] as Pt, from: 0, to: 1, steps: st.steps } : { a: [mx, st.y0] as Pt, b: [mx, st.y1] as Pt, from: 0, to: 1, steps: st.steps };
      add(
        [[[st.x0, st.y0], [st.x1, st.y0], [st.x1, st.y1], [st.x0, st.y1]]],
        { kind: "ramp", h: 1, rel: false, ramp, name: names.stair(++counts.stairs), group: g },
      );
    }
  }
  counts.measured = plan.runs.filter((r) => r.m.sure).length;
  return {
    data: {
      ...base,
      verts,
      shapes: [...base.shapes, ...shapes],
      groups: [...(base.groups ?? []), ...groups],
      // The doorways lower than the walls (a lintel over each).
      ...(o.doors?.length || base.doors?.length ? { doors: [...(base.doors ?? []), ...(o.doors ?? []).map((d) => ({ ...d, h: d.h ?? openingFor(wallH) }))] } : {}),
    },
    counts,
  };
}

/** How far to either side of a wall's line (squares) rock is looked for, and the share of it along rock that makes it the rock's own edge. */
const ROCK_SIDE = 0.3;
const ROCK_ALONG = 0.6;

/**
 * The plan worked out in the scene's squares, given back in the relief's
 * cells: a wall's thickness, a door's width, a step are measured in squares,
 * and a map scaled up has cells of more than one (`unit`: squares a cell).
 */
export function planInSquares(
  lines: { walls: Pt[][]; portals: [Pt, Pt][]; openings: boolean; rooms?: Pt[][] },
  cellPic: Picture,
  unit: number,
  stairs: boolean,
  progress: (stage: "walls" | "stairs") => void = () => {},
): UvttPlan {
  const k = unit > 0 && Number.isFinite(unit) ? unit : 1;
  const pic: Picture = { ...cellPic, px: cellPic.px / k };
  const up = (p: Pt): Pt => [p[0] * k, p[1] * k];
  const back = (p: Pt): Pt => [p[0] / k, p[1] / k];
  const walls = lines.walls.map((l) => l.map(up));
  const portals = lines.portals.map(([a, b]) => [up(a), up(b)] as [Pt, Pt]);
  // The picture's colours, once: the walls are measured on them and the rock told by them.
  const lab = labOf(pic);
  progress("walls");
  const plan = planOf({ walls, portals }, pic, [1, 1], false, { openings: lines.openings, lab });
  // Rock: dark areas between the lines that aren't rooms; the rooms and objects in it aren't.
  const rock = solidAreas(pic, lab, [...walls, ...portals], (lines.rooms ?? []).map((r) => r.map(up)));
  plan.solids = rock.loops;
  if (plan.solids.length) {
    /** Whether a wall's line runs along the rock (the rock closes it there; a wall measured there runs into the floor). */
    const alongRock = (line: Pt[], closed: boolean) => {
      const L = closed ? [...line, line[0]] : line;
      let n = 0, along = 0;
      for (let i = 1; i < L.length; i++) {
        const [ax, ay] = L[i - 1], [bx, by] = L[i], len = Math.hypot(bx - ax, by - ay);
        if (len < 1e-6) continue;
        const nx = -(by - ay) / len, ny = (bx - ax) / len;
        for (let d = 0.125; d < len; d += 0.25) {
          const cx = ax + ((bx - ax) * d) / len, cy = ay + ((by - ay) * d) / len;
          n++;
          if (rock.at(cx + nx * ROCK_SIDE, cy + ny * ROCK_SIDE) || rock.at(cx - nx * ROCK_SIDE, cy - ny * ROCK_SIDE)) along++;
        }
      }
      return n > 0 && along >= ROCK_ALONG * n;
    };
    plan.rooms = plan.rooms.filter((r) => rock.share(r) < 0.5);
    plan.runs = plan.runs.filter((r) => {
      if (r.kind === "object") return rock.share(r.line) < 0.5;
      if (!r.parts) return !alongRock(r.line, r.run.closed);
      // Piece by piece: those along the rock go, the rest stay.
      r.parts = r.parts.filter((p) => !alongRock(p.line, false));
      r.rings = r.parts.flatMap((p) => p.rings);
      return r.parts.length > 0;
    });
  }
  if (stairs) {
    progress("stairs");
    plan.stairs = findStairs(pic);
  }
  if (k !== 1) {
    plan.rooms = plan.rooms.map((r) => r.map(back));
    for (const r of plan.runs) {
      r.line = r.line.map(back);
      r.rings = r.rings.map((g) => g.map(back));
      r.open = r.open.map((g) => g.map(back));
      if (r.parts) r.parts = r.parts.map((p) => ({ line: p.line.map(back), rings: p.rings.map((g) => g.map(back)) }));
    }
    plan.stairs = plan.stairs.map((st) => ({ ...st, x0: st.x0 / k, y0: st.y0 / k, x1: st.x1 / k, y1: st.y1 / k }));
    plan.thickness /= k;
    plan.solids = plan.solids.map((l) => ({ ring: l.ring.map(back), holes: l.holes.map((h) => h.map(back)) }));
  }
  return plan;
}
