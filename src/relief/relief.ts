import clip from "../terrain/clip";
import { bbox, ccw, centroid, closed, delaunay, inBox, inShape, insertPoints, locate, nearestH, nearestOnTris, open, triangulate, type Box, type HPt } from "./geom";
import type { Affine, Detail, Pt, ReliefData, Shape, StandEdge } from "./types";

// The relief worked out: heights at any point of the map, from the painted
// ground at the bottom and the shapes over it, in order (a later one over an
// earlier one). Inside a shape, its surface (a stair's step, a ramp along its
// arrow, an inclined one between its vertices' heights, plus what's painted
// on it); a soft edge fades its edge's height into what's round it over its
// width; a hole shows what's under. A shape "over what's under it" sits on the
// shapes before it, not on the ground alone. Slabs aren't terrain (they lie
// over it, see slabAt); a standing shape measures as a terrain shape does.
// Ported from the mockup's editor F (dev-tests/tmp/mockup/layers.js).

/** The ground's spacing, and a painted relief's (cells). */
export const G = 0.5;
/** The layers' index: which reach each square this big (cells). */
const BUCKET = 2;
/** A shape's map of where it is: inside, outside, or near its edge (cells). */
const RASTER = 0.25;

export const quarter = (h: number) => Math.round(h * 4) / 4;

/** How near a shape's outline (cells) a point is on it: what working it out to and from the scene leaves. */
const ON_EDGE = 1e-6;

/** How long (cells) a stair's riser slopes, round it, where its soft edge copies its steps (see Relief.edgeHeight). */
const RISER_SLOPE = 0.5;

/** The highest (and, below 0, the deepest) a height goes, in cells: past it nothing's of use, and the maths would suffer. */
export const HEIGHT_LIMIT = 100;
export const clampHeight = (h: number) => Math.max(-HEIGHT_LIMIT, Math.min(HEIGHT_LIMIT, h));

/** What a shape makes: one piece, or (stairs) one a step; each its outline, box and height. */
export type Piece = { si: number; ring: Pt[]; holes: Pt[][]; box: Box; h?: number; fn: (x: number, y: number) => number };

/** Where a shape is, on a grid of RASTER: 1 inside, 0 outside, 2 near an edge (asked exactly, by its row's sides). */
export type Raster = { x0: number; y0: number; nx: number; ny: number; cells: Uint8Array; rows: number[][]; used: number };

/** A terrain shape worked out. */
export type Layer = {
  si: number;
  ring: Pt[];
  holes: Pt[][];
  loops: Pt[][];
  box: Box;
  /** Its box with its soft edge round it. */
  outer: Box;
  soft: number;
  stand?: StandEdge;
  wrap: boolean;
  kin?: string;
  detail: Detail | null;
  raster: Raster;
  pieces: Piece[];
  /** A stair's: its steps with sloped risers (its soft edge fades from that, see Relief.edgeHeight). */
  climb?: (x: number, y: number) => number;
};

/** A slab worked out: over the terrain, `thick` deep under its surface. */
export type SlabLayer = { si: number; ring: Pt[]; holes: Pt[][]; loops: Pt[][]; box: Box; thick: number; raster: Raster; pieces: Piece[] };

export class Relief {
  data: ReliefData;
  gw: number;
  gh: number;
  layers: Layer[] = [];
  slabLayers: SlabLayer[] = [];
  pieces: Piece[] = [];
  /** Bumped by each derive (rasters not used for a while are forgotten). */
  version = 0;
  private buckets: Map<number, Layer[]> | null = null;
  private rasters = new Map<string, Raster>();
  private deriving = false;
  private kin: string | undefined;

  constructor(data: ReliefData) {
    this.data = data;
    this.gw = Math.round(data.w / G) + 1;
    this.gh = Math.round(data.h / G) + 1;
    if (data.ground.length !== this.gw * this.gh) {
      data.ground = new Float32Array(this.gw * this.gh);
    }
    this.derive();
  }

  // ---------- Heights ----------

  /** The painted ground, between its points. */
  relief(x: number, y: number): number {
    const g = this.data.ground;
    const u = Math.min(this.gw - 1, Math.max(0, x / G));
    const v = Math.min(this.gh - 1, Math.max(0, y / G));
    const i = Math.min(this.gw - 2, Math.floor(u));
    const j = Math.min(this.gh - 2, Math.floor(v));
    const [fu, fv] = [u - i, v - j];
    const k = j * this.gw + i;
    const top = g[k] + (g[k + 1] - g[k]) * fu;
    const bottom = g[k + this.gw] + (g[k + this.gw + 1] - g[k + this.gw]) * fu;
    return top + (bottom - top) * fv;
  }

  /** What a shape "over what's under it" sits on: while working them out, the layers below it. */
  groundAt(x: number, y: number): number {
    return this.deriving ? this.evaluate(x, y) : this.relief(x, y);
  }

  /**
   * The terrain at a point from the layers below `upTo` (all of them by
   * default), but those `skip` leaves out. A cut shape's halves never stand
   * on one another: while working them out, they leave each other out.
   */
  evaluate(x: number, y: number, upTo = Infinity, skip: ((layer: Layer) => boolean) | null = null): number {
    let h = this.relief(x, y);
    // While working them out, all those so far; after, those that reach here.
    const near = this.deriving || !this.buckets ? this.layers : (this.buckets.get(bucketKey(x, y)) ?? []);
    for (const layer of near) {
      if (layer.si >= upTo) {
        break;
      }
      if ((skip && skip(layer)) || (this.deriving && this.kin && layer.kin === this.kin)) {
        continue;
      }
      if (covers(layer, x, y)) {
        h = this.surface(layer, x, y);
        continue;
      }
      if (layer.soft > 0 && inBox(layer.outer, x, y)) {
        // Its edge's nearest point: round it, or in a hole.
        const near = nearestOnLoops(layer.loops, x, y);
        if (near.d < layer.soft) {
          // Its edge's height, fading over the width into what's there.
          const u = 1 - near.d / layer.soft;
          h += (this.edgeHeight(layer, near.x, near.y) - h) * u * u * (3 - 2 * u);
        }
      }
    }
    return h;
  }

  /**
   * The terrain at a point as a part of it has it (the Vistazo's pieces):
   * `own`'s surface (`piece`'s, a stair's step, if given), or with none the
   * painted ground, and the soft edges of the shapes over it reaching there;
   * what covers the point is left out, so a point right on the part's edge
   * keeps its own height (not the next shape's, or the ground's beside it).
   */
  evaluateOn(own: Layer | null, x: number, y: number, piece?: Piece): number {
    let h = !own ? this.relief(x, y) : piece ? piece.fn(x, y) + (own.detail && own.detail.v.size > 0 ? detailAt(own.detail, x, y) : 0) : this.surface(own, x, y);
    const near = !this.buckets ? this.layers : (this.buckets.get(bucketKey(x, y)) ?? []);
    for (const layer of near) {
      if ((own && layer.si <= own.si) || layer.soft <= 0 || !inBox(layer.outer, x, y)) {
        continue;
      }
      // On its outline is its edge, not under it (a neighbour's corner there, a hair either side of it
      // as it's worked out: some taken in, some left at what's under, would show as teeth along it).
      const inside = covers(layer, x, y);
      const edge = nearestOnLoops(layer.loops, x, y);
      if (inside && edge.d > ON_EDGE) {
        continue;
      }
      if (edge.d < layer.soft) {
        const u = 1 - edge.d / layer.soft;
        h += (this.edgeHeight(layer, edge.x, edge.y) - h) * u * u * (3 - 2 * u);
      }
    }
    return h;
  }

  /**
   * What a soft edge fades from, at a point of its outline: the shape's surface; a stair's, its steps
   * with each riser a short slope instead of a jump (fading from a jump would make what's round it jump
   * too, which no ground can: it showed as wedges). The step beside such a slope stands over it: its
   * side's wall (see the Vistazo's walls).
   */
  edgeHeight(layer: Layer, x: number, y: number): number {
    if (!layer.climb) {
      return this.surface(layer, x, y);
    }
    return layer.climb(x, y) + (layer.detail && layer.detail.v.size > 0 ? detailAt(layer.detail, x, y) : 0);
  }

  /** A stair's steps with sloped risers (see edgeHeight): undefined for anything else. */
  private climbOf(s: Shape): ((x: number, y: number) => number) | undefined {
    if (s.kind !== "ramp" || !s.ramp || s.ramp.steps < 2) {
      return undefined;
    }
    const { a, b, steps } = s.ramp;
    const [from, to] = this.rampEnds(s);
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const len = Math.hypot(dx, dy) || 1;
    const [ux, uy] = [dx / len, dy / len];
    const tread = len / steps;
    const slope = Math.min(RISER_SLOPE, tread / 2);
    const step = (k: number) => from + ((to - from) * k) / (steps - 1);
    return (x, y) => {
      const d = (x - a[0]) * ux + (y - a[1]) * uy;
      const k = Math.max(0, Math.min(steps - 1, Math.floor(d / tread)));
      const past = d - k * tread;
      return k > 0 && past < slope ? step(k - 1) + (step(k) - step(k - 1)) * (past / slope) : step(k);
    };
  }

  /** A shape's own surface at a point (a stair's step there, or the nearest one), and its painted relief unless `bare`. */
  surface(layer: Layer | SlabLayer, x: number, y: number, bare = false): number {
    const detail = "detail" in layer ? layer.detail : null;
    const painted = !bare && detail && detail.v.size > 0 ? detailAt(detail, x, y) : 0;
    const pieces = layer.pieces;
    if (pieces.length === 1) {
      return pieces[0].fn(x, y) + painted;
    }
    let best = pieces[0];
    let d = Infinity;
    for (const piece of pieces) {
      if (inBox(piece.box, x, y) && inShape(x, y, piece.ring, piece.holes)) {
        return piece.fn(x, y) + painted;
      }
      const e = nearestOnRing(piece.ring, x, y).d;
      if (e < d) {
        d = e;
        best = piece;
      }
    }
    return best.fn(x, y) + painted;
  }

  /** The terrain's height at a point of the map (undefined off it). */
  heightAt(x: number, y: number): number | undefined {
    if (x < 0 || y < 0 || x > this.data.w || y > this.data.h) {
      return undefined;
    }
    return this.evaluate(x, y);
  }

  /** The slab over a point, if any (the highest): its surface there and its underside. */
  slabAt(x: number, y: number): { top: number; bottom: number } | undefined {
    let found: { top: number; bottom: number } | undefined;
    for (const layer of this.slabLayers) {
      if (covers(layer, x, y)) {
        const top = this.surface(layer, x, y);
        if (!found || top > found.top) {
          found = { top, bottom: top - layer.thick };
        }
      }
    }
    return found;
  }

  // ---------- Working it out ----------

  /** A shape's outline and its holes, as points. */
  coordsOf(s: Shape): [Pt[], Pt[][]] {
    const at = (loop: number[]): Pt[] => loop.map((i) => [this.data.verts[i].x, this.data.verts[i].y]);
    return [at(s.ring), (s.holes ?? []).map(at)];
  }

  /** Each shape worked out on top of the ones before it (so "over what's under it" means them too). */
  derive() {
    this.version++;
    this.layers = [];
    this.slabLayers = [];
    this.pieces = [];
    this.buckets = null;
    this.deriving = true;
    try {
      this.data.shapes.forEach((s, si) => {
        this.kin = s.kin;
        const own = this.piecesOf(s, si);
        this.pieces.push(...own);
        const [ring, holes] = this.coordsOf(s);
        if (own.length === 0 || ring.length < 3) {
          return;
        }
        const box = bbox(ring);
        const loops = [ring, ...holes];
        const raster = this.rasterOf(loops);
        if (s.slab && s.slab > 0) {
          this.slabLayers.push({ si, ring, holes, loops, box, thick: s.slab, raster, pieces: own });
          return;
        }
        const soft = s.soft && s.soft > 0 && !s.stand ? s.soft : 0;
        this.layers.push({
          si,
          ring,
          holes,
          loops,
          box,
          outer: { x0: box.x0 - soft, y0: box.y0 - soft, x1: box.x1 + soft, y1: box.y1 + soft },
          soft,
          stand: s.stand,
          wrap: !!s.wrap,
          kin: s.kin,
          detail: s.stand ? null : (s.detail ?? null),
          raster,
          pieces: own,
          climb: soft > 0 ? this.climbOf(s) : undefined,
        });
      });
    } finally {
      this.deriving = false;
      this.kin = undefined;
    }
    // Each square of the index: the layers (in order) whose reach (soft edge too) is over it.
    const buckets = new Map<number, Layer[]>();
    for (const layer of this.layers) {
      const { x0, y0, x1, y1 } = layer.outer;
      for (let j = Math.floor(y0 / BUCKET); j <= Math.floor(y1 / BUCKET); j++) {
        for (let i = Math.floor(x0 / BUCKET); i <= Math.floor(x1 / BUCKET); i++) {
          const key = i * 4096 + j;
          const list = buckets.get(key);
          if (list) {
            list.push(layer);
          } else {
            buckets.set(key, [layer]);
          }
        }
      }
    }
    this.buckets = buckets;
    // Those no outline has now, forgotten.
    if (this.rasters.size > 2 * (this.data.shapes.length + 50)) {
      for (const [key, r] of this.rasters) {
        if (r.used < this.version - 2) {
          this.rasters.delete(key);
        }
      }
    }
  }

  /** A ramp's heights at its arrow's two ends (over what's under them, if it's relative). */
  rampEnds(s: Shape): [number, number] {
    const { a, b, from, to } = s.ramp!;
    return s.rel ? [quarter(this.groundAt(...a)) + from, quarter(this.groundAt(...b)) + to] : [from, to];
  }

  /** What a shape makes: one piece, or (stairs) one a step. */
  private piecesOf(s: Shape, si: number): Piece[] {
    const [ring, holes] = this.coordsOf(s);
    if (ring.length < 3) {
      return [];
    }
    const box = bbox(ring);
    if (s.kind === "flat") {
      const h = s.rel ? quarter(this.groundAt(...centroid(ring))) + s.h : s.h;
      return [{ si, ring, holes, box, h, fn: () => h }];
    }
    if (s.kind === "ramp" && s.ramp) {
      const { a, b, steps } = s.ramp;
      const [from, to] = this.rampEnds(s);
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const len2 = dx * dx + dy * dy || 1;
      const t = (x: number, y: number) => Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len2));
      if (steps >= 2) {
        // One flat piece a step: the outline cut in bands across the arrow.
        const pieces: Piece[] = [];
        const far = 4 * Math.hypot(box.x1 - box.x0, box.y1 - box.y0) + 10;
        const len = Math.sqrt(len2);
        const [ux, uy] = [dx / len, dy / len];
        const [nx, ny] = [-uy * far, ux * far];
        const at = (k: number) => (k <= 0 ? -far : k >= steps ? len + far : (k / steps) * len);
        for (let k = 0; k < steps; k++) {
          const [d0, d1] = [at(k), at(k + 1)];
          const band: Pt[] = [
            [a[0] + ux * d0 + nx, a[1] + uy * d0 + ny],
            [a[0] + ux * d1 + nx, a[1] + uy * d1 + ny],
            [a[0] + ux * d1 - nx, a[1] + uy * d1 - ny],
            [a[0] + ux * d0 - nx, a[1] + uy * d0 - ny],
          ];
          let parts: Pt[][][] = [];
          try {
            parts = clip.intersection([closed(ring), ...holes.map(closed)], [closed(band)]) as Pt[][][];
          } catch {
            // No step.
          }
          const h = from + ((to - from) * k) / (steps - 1);
          for (const polygon of parts) {
            const piece = open(polygon[0]);
            pieces.push({ si, ring: piece, holes: polygon.slice(1).map(open), box: bbox(piece), h, fn: () => h });
          }
        }
        return pieces;
      }
      return [{ si, ring, holes, box, fn: (x, y) => from + (to - from) * t(x, y) }];
    }
    // Inclined (or a ramp with no arrow yet): each corner at its height, and the height points inside.
    const verts = this.data.verts;
    const pts: HPt[] = [s.ring, ...(s.holes ?? [])].flat().map((i) => [verts[i].x, verts[i].y, verts[i].h]);
    let tris: number[][] = [];
    try {
      tris = triangulate([ring, ...holes]).tris;
    } catch {
      // A self-crossing outline: no surface.
    }
    ccw(pts, tris);
    // Its triangles joining the corners nearest each other, not across it (see delaunay).
    delaunay(pts, tris);
    insertPoints(
      pts,
      tris,
      this.data.points.filter((p) => inShape(p.x, p.y, ring, holes)).map((p): HPt => [p.x, p.y, p.h])
    );
    // A hair outside (a point on its outline, rounded): its side's height there, not a far corner's.
    return [{ si, ring, holes, box, fn: (x, y) => locate(pts, tris, x, y) ?? nearestOnTris(pts, tris, x, y) ?? nearestH(pts, x, y) }];
  }

  /** Where a shape's outline (with its holes) is, on a grid of RASTER. Kept while the outline stays. */
  private rasterOf(loops: Pt[][]): Raster {
    const sig = loops.map((loop) => loop.map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`).join(" ")).join(" / ");
    const known = this.rasters.get(sig);
    if (known) {
      known.used = this.version;
      return known;
    }
    const box = bbox(loops[0]);
    const x0 = Math.floor(box.x0 / RASTER) * RASTER;
    const y0 = Math.floor(box.y0 / RASTER) * RASTER;
    const nx = Math.max(1, Math.ceil((box.x1 - x0) / RASTER));
    const ny = Math.max(1, Math.ceil((box.y1 - y0) / RASTER));
    const cells = new Uint8Array(nx * ny);
    // Inside: each row's middle, between the outlines' crossings (even-odd, holes too).
    for (let j = 0; j < ny; j++) {
      const y = y0 + (j + 0.5) * RASTER;
      const xs: number[] = [];
      for (const loop of loops) {
        for (let k = 0; k < loop.length; k++) {
          const [ax, ay] = loop[k];
          const [bx, by] = loop[(k + 1) % loop.length];
          if (ay > y !== by > y) {
            xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
          }
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil((xs[k] - x0) / RASTER - 0.5));
        const to = Math.min(nx - 1, Math.floor((xs[k + 1] - x0) / RASTER - 0.5));
        for (let i = from; i <= to; i++) {
          cells[j * nx + i] = 1;
        }
      }
    }
    // Near an edge: every cell a side goes through, and those round it.
    for (const loop of loops) {
      for (let k = 0; k < loop.length; k++) {
        const [ax, ay] = loop[k];
        const [bx, by] = loop[(k + 1) % loop.length];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (RASTER / 2)));
        for (let t = 0; t <= n; t++) {
          const ci = Math.floor((ax + ((bx - ax) * t) / n - x0) / RASTER);
          const cj = Math.floor((ay + ((by - ay) * t) / n - y0) / RASTER);
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const [i, j] = [ci + di, cj + dj];
              if (i >= 0 && j >= 0 && i < nx && j < ny) {
                cells[j * nx + i] = 2;
              }
            }
          }
        }
      }
    }
    // Each row's sides (where it's asked exactly): those across its band.
    const rows: number[][] = Array.from({ length: ny }, () => []);
    for (const loop of loops) {
      for (let k = 0; k < loop.length; k++) {
        const [ax, ay] = loop[k];
        const [bx, by] = loop[(k + 1) % loop.length];
        const from = Math.max(0, Math.floor((Math.min(ay, by) - y0) / RASTER));
        const to = Math.min(ny - 1, Math.floor((Math.max(ay, by) - y0) / RASTER));
        for (let j = from; j <= to; j++) {
          rows[j].push(ax, ay, bx, by);
        }
      }
    }
    const raster = { x0, y0, nx, ny, cells, rows, used: this.version };
    this.rasters.set(sig, raster);
    return raster;
  }
}

/** The square of the layers' index a point is in. */
const bucketKey = (x: number, y: number) => Math.floor(x / BUCKET) * 4096 + Math.floor(y / BUCKET);

/** Whether a layer covers a point: from its raster, and exactly only near its edge. */
export function covers(layer: { box: Box; raster: Raster; ring: Pt[]; holes: Pt[][] }, x: number, y: number): boolean {
  const { box, raster } = layer;
  if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) {
    return false;
  }
  const i = Math.floor((x - raster.x0) / RASTER);
  const j = Math.floor((y - raster.y0) / RASTER);
  const c = i >= 0 && j >= 0 && i < raster.nx && j < raster.ny ? raster.cells[j * raster.nx + i] : 0;
  if (c !== 2) {
    return c === 1;
  }
  if (j >= 0 && j < raster.ny) {
    // Its row's sides only: how many cross the line to the right of the point (even-odd, holes too).
    const e = raster.rows[j];
    let inside = false;
    for (let k = 0; k < e.length; k += 4) {
      const [ay, by] = [e[k + 1], e[k + 3]];
      if (ay > y !== by > y && x < e[k] + ((y - ay) * (e[k + 2] - e[k])) / (by - ay)) {
        inside = !inside;
      }
    }
    return inside;
  }
  return inShape(x, y, layer.ring, layer.holes);
}

/** The point of an outline nearest to (x, y), and how far it is. */
export function nearestOnRing(ring: Pt[], x: number, y: number): { x: number; y: number; d: number } {
  // Asked for every point of a soft edge, every build: plain numbers, the distance squared till the end.
  let [bestX, bestY, best2] = [ring[0][0], ring[0][1], Infinity];
  const n = ring.length;
  for (let k = 0; k < n; k++) {
    const a = ring[k];
    const b = ring[k + 1 < n ? k + 1 : 0];
    const ax = a[0];
    const ay = a[1];
    const dx = b[0] - ax;
    const dy = b[1] - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const px = ax + dx * t;
    const py = ay + dy * t;
    const d2 = (px - x) * (px - x) + (py - y) * (py - y);
    if (d2 < best2) {
      [bestX, bestY, best2] = [px, py, d2];
    }
  }
  return { x: bestX, y: bestY, d: Math.hypot(bestX - x, bestY - y) };
}

/** The point nearest to (x, y) on any of some outlines, and how far it is. */
export function nearestOnLoops(loops: Pt[][], x: number, y: number): { x: number; y: number; d: number } {
  let best = nearestOnRing(loops[0], x, y);
  for (let k = 1; k < loops.length; k++) {
    const near = nearestOnRing(loops[k], x, y);
    if (near.d < best.d) {
      best = near;
    }
  }
  return best;
}

// ---------- A shape's painted relief ----------

/** A point of a relief's grid (u, v: in its own frame, in steps of G) as one number, and back. */
export const cellKey = (u: number, v: number) => (u + 32768) * 65536 + (v + 32768);
export const cellOf = (key: number): [number, number] => [Math.floor(key / 65536) - 32768, (key % 65536) - 32768];

export const apply = (m: Affine, u: number, v: number): Pt => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];

export function inverse(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const [a, b, c, d] = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** `f` after `m`. */
export function compose(f: Affine, m: Affine): Affine {
  return [
    f[0] * m[0] + f[2] * m[1],
    f[1] * m[0] + f[3] * m[1],
    f[0] * m[2] + f[2] * m[3],
    f[1] * m[2] + f[3] * m[3],
    f[0] * m[4] + f[2] * m[5] + f[4],
    f[1] * m[4] + f[3] * m[5] + f[5],
  ];
}

/** A relief's height at a point: between its grid's four points round it (none painted: 0). */
export function detailAt(detail: Detail, x: number, y: number): number {
  if (detail.invOf !== detail.m || !detail.inv) {
    detail.inv = inverse(detail.m);
    detail.invOf = detail.m;
  }
  const [lu, lv] = apply(detail.inv, x, y);
  const [u, v] = [lu / G, lv / G];
  const [i, j] = [Math.floor(u), Math.floor(v)];
  const [fu, fv] = [u - i, v - j];
  const at = (a: number, b: number) => detail.v.get(cellKey(a, b)) ?? 0;
  const top = at(i, j) + (at(i + 1, j) - at(i, j)) * fu;
  const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fu;
  return top + (bottom - top) * fv;
}
