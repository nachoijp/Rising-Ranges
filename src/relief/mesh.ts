import clip from "../terrain/clip";
import { centroid, closed, open, triangulate } from "./geom";
import { G, covers, type Layer, type Relief } from "./relief";
import { standSide, type StandSide } from "./stand";
import type { Pt, Skin, WallLook } from "./types";

// The relief as triangles to draw it (no three here: plain arrays the editor's
// view and the Vistazo turn into their meshes). The terrain on a lattice of G
// cells, each square crossed by an outline cut along it (the cuts kept while
// the outlines stay); walls along the outlines where the heights beside them
// differ, and round the map's edge; slabs with their underside and sides;
// standing shapes' pictures turned up; water over the shapes that hold it.

/** Walls cut every quarter of a cell. */
const STEP = 0.25;
/** A point on an outline, taken from the side it's drawn for. */
const NUDGE = 1e-3;

/** A corner: [x, y, h] (cells, grid units). */
export type V3 = [number, number, number];
/** A corner whose picture comes from a point of the map: [x, y, h, mapX, mapY]. */
export type V5 = [number, number, number, number, number];
/** A dressed wall's corner: [x, y, h, u, v, shade] (u, v a point of the map, or a pattern's tile). */
export type V6 = [number, number, number, number, number, number];

export type MeshData = {
  /** The terrain's top, textured with the map. */
  top: V3[];
  /** Walls as they always are (and the map's edge, and slabs' undersides and sides). */
  walls: V3[];
  /** Standing shapes' tops: plain (their picture stands up). */
  plain: V3[];
  /** Standing shapes' pictures. */
  cards: V5[];
  /** Walls with a look of their own, by look ("skin": a picture from the map). */
  styled: { look: WallLook | "skin"; tris: V6[] }[];
  /** Water's surface, and the cells it covers (x, y pairs, `waterStep` across). */
  water: V3[];
  waterCells: number[];
  waterStep: number;
};

type Segment = { px: number; py: number; qx: number; qy: number; tp: number; bp: number; tq: number; bq: number };

export class ReliefMesh {
  relief: Relief;
  /** The lattice squares' cuts, by square and the outlines through it. */
  private cells = new Map<string, { tris: Pt[][] }[]>();
  /** Each slab's top, cut on the lattice, by its outline. */
  private slabCells = new Map<string, Pt[][]>();

  constructor(relief: Relief) {
    this.relief = relief;
  }

  build(): MeshData {
    const r = this.relief;
    const { w: W, h: H } = r.data;
    const nx = Math.round(W / G);
    const ny = Math.round(H / G);
    // Which lattice squares each outline goes through.
    const crossing = new Map<number, number[]>();
    const sigs = r.layers.map(signature);
    r.layers.forEach((layer, li) => {
      const mark = (i: number, j: number) => {
        if (i < 0 || j < 0 || i >= nx || j >= ny) {
          return;
        }
        const c = j * nx + i;
        const list = crossing.get(c) ?? [];
        if (list[list.length - 1] !== li) {
          list.push(li);
        }
        crossing.set(c, list);
      };
      // Every square a side goes through, however little of it (a corner clipped too), or touches:
      // column by column, the side's stretch of y in each.
      const e = 1e-7;
      for (const ring of layer.loops) {
        for (let k = 0; k < ring.length; k++) {
          const [ax, ay] = ring[k];
          const [bx, by] = ring[(k + 1) % ring.length];
          const [xa, xb] = [Math.min(ax, bx), Math.max(ax, bx)];
          for (let i = Math.floor((xa - e) / G); i <= Math.floor((xb + e) / G); i++) {
            const [c0, c1] = [Math.max(xa, i * G), Math.min(xb, (i + 1) * G)];
            const yAt = (x: number) => (Math.abs(bx - ax) < 1e-12 ? ay : ay + ((by - ay) * (x - ax)) / (bx - ax));
            const ys = Math.abs(bx - ax) < 1e-12 ? [ay, by] : [yAt(c0), yAt(c1)];
            for (let j = Math.floor((Math.min(...ys) - e) / G); j <= Math.floor((Math.max(...ys) + e) / G); j++) {
              mark(i, j);
            }
          }
        }
      }
    });
    const top: V3[] = [];
    const plain: V3[] = [];
    const stands = r.layers.filter((layer) => layer.stand);
    /** Whether the terrain at a point is a standing shape's top (drawn plain: its picture stands up). */
    const standing = (x: number, y: number) => {
      if (stands.length === 0) {
        return false;
      }
      for (let i = r.layers.length - 1; i >= 0; i--) {
        if (covers(r.layers[i], x, y)) {
          return !!r.layers[i].stand;
        }
      }
      return false;
    };
    const corner = new Float32Array((nx + 1) * (ny + 1)).fill(NaN);
    const at = (i: number, j: number) => {
      const k = j * (nx + 1) + i;
      if (Number.isNaN(corner[k])) {
        corner[k] = r.evaluate(i * G, j * G);
      }
      return corner[k];
    };
    const tri = (pts: Pt[]) => {
      const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3;
      const cy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
      const into = standing(cx, cy) ? plain : top;
      for (const [x, y] of pts) {
        // Toward its middle, never past it: inside the triangle, so on its side of every outline.
        const len = Math.hypot(cx - x, cy - y) || 1;
        const t = Math.min(NUDGE, len / 2) / len;
        into.push([x, y, r.evaluate(x + (cx - x) * t, y + (cy - y) * t)]);
      }
    };
    const used = new Set<string>();
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const [x0, y0, x1, y1] = [i * G, j * G, (i + 1) * G, (j + 1) * G];
        const list = crossing.get(j * nx + i);
        if (!list) {
          const [a, b, c, d] = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
          const TL: V3 = [x0, y0, a];
          const TR: V3 = [x1, y0, b];
          const BR: V3 = [x1, y1, c];
          const BL: V3 = [x0, y1, d];
          const into = standing((x0 + x1) / 2, (y0 + y1) / 2) ? plain : top;
          // Split along the diagonal whose ends are most alike (a ridge or a valley along it stays).
          if (Math.abs(a - c) <= Math.abs(b - d)) {
            into.push(TL, TR, BR, TL, BR, BL);
          } else {
            into.push(TL, TR, BL, TR, BR, BL);
          }
          continue;
        }
        // Cut by the outlines through it: the pieces kept while those outlines stay as they are.
        const key = `${j * nx + i}|${list.map((li) => sigs[li]).join("|")}`;
        used.add(key);
        let parts = this.cells.get(key);
        if (!parts) {
          // Each outline cut down to round the square first (a long one is slow to cut whole).
          const win: [number, number, number, number] = [x0 - G, y0 - G, x1 + G, y1 + G];
          parts = partition(
            [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
            list.map((li) => r.layers[li].loops.map((loop) => clipToBox(loop, win)).filter((loop, k) => k === 0 || loop.length >= 3))
          );
          this.cells.set(key, parts);
        }
        for (const polygon of parts) {
          for (const t of polygon.tris) {
            tri(t);
          }
        }
      }
    }
    // Forget the cuts no outline has now.
    if (this.cells.size > used.size * 2 + 200) {
      for (const key of this.cells.keys()) {
        if (!used.has(key)) {
          this.cells.delete(key);
        }
      }
    }
    let base = Infinity;
    for (const q of top) {
      base = Math.min(base, q[2]);
    }
    for (const q of plain) {
      base = Math.min(base, q[2]);
    }
    base = Math.min(0, base) - 1;
    // Walls: along each outline, where the terrain beside it is at another height.
    const walls: V3[] = [];
    const wall = (px: number, py: number, hp: number, lp: number, qx: number, qy: number, hq: number, lq: number) =>
      walls.push([px, py, hp], [qx, qy, hq], [qx, qy, lq], [px, py, hp], [qx, qy, lq], [px, py, lp]);
    // A shape with walls of its own look: its pieces of wall kept, to be dressed after (see dress).
    const styled = new Map<Layer, { look: WallLook | "skin"; segments: Segment[] }>();
    for (const layer of r.layers) {
      const shape = r.data.shapes[layer.si];
      const look = layer.stand ? undefined : shape.skin ? "skin" : shape.wall;
      const own: Segment[] | null = look ? [] : null;
      if (look && own) {
        styled.set(layer, { look, segments: own });
      }
      for (const ring of layer.loops) {
        for (let k = 0; k < ring.length; k++) {
          const [ax, ay] = ring[k];
          const [bx, by] = ring[(k + 1) % ring.length];
          const len = Math.hypot(bx - ax, by - ay);
          if (len < 1e-6) {
            continue;
          }
          const [nx2, ny2] = [((by - ay) / len) * NUDGE * 2, (-(bx - ax) / len) * NUDGE * 2];
          const steps = Math.max(1, Math.ceil(len / STEP - 1e-6));
          // Each side's height a step along: at its ends, a little in from the corner (just off it, at
          // a corner, would be on the next side, neither in nor out).
          const end = Math.min(0.25, (NUDGE * 4) / len);
          const side = (t: number): [number, number] => {
            const u = Math.min(1 - end, Math.max(end, t));
            const [x, y] = [ax + (bx - ax) * u, ay + (by - ay) * u];
            return [r.evaluate(x + nx2, y + ny2), r.evaluate(x - nx2, y - ny2)];
          };
          let [pa, pb] = side(0);
          for (let s = 1; s <= steps; s++) {
            const qx = ax + ((bx - ax) * s) / steps;
            const qy = ay + ((by - ay) * s) / steps;
            const [qa, qb] = side(s / steps);
            if (Math.abs(pa - pb) > 1e-3 || Math.abs(qa - qb) > 1e-3) {
              const px = ax + ((bx - ax) * (s - 1)) / steps;
              const py = ay + ((by - ay) * (s - 1)) / steps;
              if (own) {
                own.push({ px, py, qx, qy, tp: Math.max(pa, pb), bp: Math.min(pa, pb), tq: Math.max(qa, qb), bq: Math.min(qa, qb) });
              } else {
                wall(px, py, Math.max(pa, pb), Math.min(pa, pb), qx, qy, Math.max(qa, qb), Math.min(qa, qb));
              }
            }
            [pa, pb] = [qa, qb];
          }
        }
      }
    }
    const dressed = this.dress(styled);
    // And round the map's edge, down to under everything.
    const edge = (ax: number, ay: number, bx: number, by: number, inX: number, inY: number) => {
      const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / STEP));
      for (let s = 0; s < n; s++) {
        const [px, py] = [ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n];
        const [qx, qy] = [ax + ((bx - ax) * (s + 1)) / n, ay + ((by - ay) * (s + 1)) / n];
        wall(px, py, r.evaluate(px + inX, py + inY), base, qx, qy, r.evaluate(qx + inX, qy + inY), base);
      }
    };
    edge(0, 0, W, 0, 0, NUDGE);
    edge(W, 0, W, H, -NUDGE, 0);
    edge(W, H, 0, H, 0, -NUDGE);
    edge(0, H, 0, 0, NUDGE, 0);
    this.slabs(top, walls);
    const cards = stands.flatMap((layer) => this.card(layer));
    const water = this.water();
    return { top, walls, plain, cards, styled: dressed, water: water.tris, waterCells: water.cells, waterStep: water.step };
  }

  /** Where a standing layer stands. */
  side(layer: Layer): StandSide {
    return standSide(layer.stand ?? "auto", layer.ring, layer.box, this.relief.data.w, this.relief.data.h);
  }

  /**
   * Walls with a look of their own, as the Vistazo draws them. From the map
   * (stretch, fold, skin), u and v are a point of the map; a pattern's are
   * its tile's (two cells a tile, along the wall and up from the ground);
   * plain, none.
   */
  private dress(styled: Map<Layer, { look: WallLook | "skin"; segments: Segment[] }>) {
    const out = new Map<WallLook | "skin", V6[]>();
    const BAND = 0.75; // the fold's strip, cells into the map
    const INSET = 0.05; // the stretch's row of pixels, a hair inside the edge
    const TILE = 2;
    const [TOP, BOTTOM] = [0.92, 0.57];
    for (const [layer, { look, segments }] of styled) {
      if (segments.length === 0) {
        continue;
      }
      const list = out.get(look) ?? [];
      out.set(look, list);
      const skin = look === "skin" ? this.relief.data.shapes[layer.si].skin : undefined;
      // A skin's picture: the whole of its walls' height, from their lowest foot to their highest top.
      const lowest = Math.min(...segments.map((g) => Math.min(g.bp, g.bq)));
      const span = Math.max(...segments.map((g) => Math.max(g.tp, g.tq))) - lowest || 1;
      for (const g of segments) {
        const { px, py, qx, qy, tp, bp, tq, bq } = g;
        const len = Math.hypot(qx - px, qy - py) || 1;
        const [dx, dy] = [(qx - px) / len, (qy - py) / len];
        // Into the shape: its own picture is on that side (a pit's, inside the hollow).
        const [mx, my] = [(px + qx) / 2, (py + qy) / 2];
        const [ix, iy] = covers(layer, mx + dy * 0.02, my - dx * 0.02) ? [dy, -dx] : [-dy, dx];
        const at = (x: number, y: number, d: number): Pt => [x + ix * d, y + iy * d];
        const quad = (pt: number, qt: number, qb: number, pb: number, uv: [Pt, Pt, Pt, Pt]) => {
          // uv: the four corners' [u, v], p top, q top, q bottom, p bottom.
          const a: V6 = [px, py, pt, ...uv[0], TOP];
          const b: V6 = [qx, qy, qt, ...uv[1], TOP];
          const c: V6 = [qx, qy, qb, ...uv[2], BOTTOM];
          const d: V6 = [px, py, pb, ...uv[3], BOTTOM];
          list.push(a, b, c, a, c, d);
        };
        if (look === "skin" && skin) {
          const point = (x: number, y: number, h: number) => skinPoint(skin, skinAcross(skin, x, y), (h - lowest) / span);
          quad(tp, tq, bq, bp, [point(px, py, tp), point(qx, qy, tq), point(qx, qy, bq), point(px, py, bp)]);
        } else if (look === "stretch") {
          const [p, q] = [at(px, py, INSET), at(qx, qy, INSET)];
          quad(tp, tq, bq, bp, [p, q, q, p]);
        } else if (look === "fold") {
          const height = Math.max(tp - bp, tq - bq);
          if (Math.abs(tp - tq) > 1e-3 || Math.abs(bp - bq) > 1e-3) {
            // Slanting (beside a ramp): one strip, as deep as it is tall.
            const deep = Math.min(BAND, height);
            quad(tp, tq, bq, bp, [at(px, py, INSET), at(qx, qy, INSET), at(qx, qy, deep), at(px, py, deep)]);
          } else {
            // Strips of the map just inside the edge, folded down, every other one mirrored.
            for (let t = 0, j = 0; t < height - 1e-9; t += BAND, j++) {
              const t1 = Math.min(height, t + BAND);
              const d0 = (j % 2 === 0 ? 0 : BAND) + INSET;
              const d1 = (j % 2 === 0 ? t1 - t : BAND - (t1 - t)) + INSET;
              quad(tp - t, tq - t, tq - t1, tp - t1, [at(px, py, d0), at(qx, qy, d0), at(qx, qy, d1), at(px, py, d1)]);
            }
          }
        } else if (look === "stone" || look === "rubble" || look === "earth" || look === "wood") {
          // Along the wall's own direction, so a straight edge's steps run on without a jump.
          const s0 = (px * dx + py * dy) / TILE;
          const s1 = s0 + len / TILE;
          quad(tp, tq, bq, bp, [[s0, tp / TILE], [s1, tq / TILE], [s1, bq / TILE], [s0, bp / TILE]]);
        } else {
          quad(tp, tq, bq, bp, [[0, 0], [0, 0], [0, 0], [0, 0]]);
        }
      }
    }
    return [...out].map(([look, tris]) => ({ look, tris }));
  }

  /** Each slab: its top (on the lattice, so ramps bend where they should), its underside and its sides. */
  private slabs(top: V3[], walls: V3[]) {
    if (this.slabCells.size > 5000) {
      this.slabCells.clear();
    }
    const r = this.relief;
    for (const layer of r.slabLayers) {
      const sig = signature(layer);
      let tris = this.slabCells.get(sig);
      if (!tris) {
        tris = [];
        const { x0, y0, x1, y1 } = layer.box;
        for (let j = Math.floor(y0 / G); j < Math.ceil(y1 / G); j++) {
          for (let i = Math.floor(x0 / G); i < Math.ceil(x1 / G); i++) {
            const cell: Pt[] = [[i * G, j * G], [(i + 1) * G, j * G], [(i + 1) * G, (j + 1) * G], [i * G, (j + 1) * G]];
            let parts: Pt[][][] = [];
            try {
              parts = clip.intersection([closed(cell)], layer.loops.map(closed)) as Pt[][][];
            } catch {
              // Not there.
            }
            for (const polygon of parts) {
              try {
                const t = triangulate(polygon.map(open));
                tris.push(...t.tris.map((u) => u.map((k) => t.pts[k])));
              } catch {
                // Too thin.
              }
            }
          }
        }
        this.slabCells.set(sig, tris);
      }
      const h = (x: number, y: number) => r.surface(layer, x, y);
      for (const t of tris) {
        top.push(...t.map(([x, y]): V3 => [x, y, h(x, y)]));
        walls.push(...[t[0], t[2], t[1]].map(([x, y]): V3 => [x, y, h(x, y) - layer.thick]));
      }
      for (const ring of layer.loops) {
        for (let k = 0; k < ring.length; k++) {
          const [ax, ay] = ring[k];
          const [bx, by] = ring[(k + 1) % ring.length];
          const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / STEP - 1e-6));
          for (let s = 0; s < steps; s++) {
            const [px, py] = [ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps];
            const [qx, qy] = [ax + ((bx - ax) * (s + 1)) / steps, ay + ((by - ay) * (s + 1)) / steps];
            const [hp, hq] = [h(px, py), h(qx, qy)];
            walls.push([px, py, hp], [qx, qy, hq], [qx, qy, hq - layer.thick], [px, py, hp], [qx, qy, hq - layer.thick], [px, py, hp - layer.thick]);
          }
        }
      }
    }
  }

  /** A standing shape's picture turned up on its edge, from the ground just past it. */
  private card(layer: Layer): V5[] {
    const r = this.relief;
    const side = this.side(layer);
    if (side.top) {
      return this.unfoldedCard(layer, side as Required<Pick<StandSide, "base" | "top" | "out">>);
    }
    if (layer.wrap) {
      return this.frontCard(layer, side);
    }
    let tri: ReturnType<typeof triangulate>;
    try {
      tri = triangulate(layer.loops);
    } catch {
      return [];
    }
    const { x0, y0, x1, y1 } = layer.box;
    const edge = side.edge!;
    const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
    const probe = 0.1;
    const beside: Record<string, Pt> = { bottom: [cx, y1 + probe], top: [cx, y0 - probe], right: [x1 + probe, cy], left: [x0 - probe, cy] };
    const base = r.evaluate(...beside[edge]);
    const gap = 0.02;
    const turn = ([X, Y]: Pt): V5 => {
      const placed: Record<string, V3> = {
        bottom: [X, y1 + gap, base + (y1 - Y)],
        top: [X, y0 - gap, base + (Y - y0)],
        right: [x1 + gap, Y, base + (x1 - X)],
        left: [x0 - gap, Y, base + (X - x0)],
      };
      return [...placed[edge], X, Y];
    };
    return tri.tris.flatMap((t) => t.map((k) => turn(tri.pts[k])));
  }

  /**
   * A standing shape's picture on every side of it that faces the front (the
   * way it stands): at each point of such a side, the picture from there
   * straight back to the far end of the shape, its foot at the ground, the
   * far end at its height. So it runs on round a corner, a cut-off one or a
   * step back, and shows only what's inside the shape.
   */
  private frontCard(layer: Layer, { base, out }: StandSide): V5[] {
    const r = this.relief;
    const probe = 0.1;
    const [mx, my] = [(base[0][0] + base[1][0]) / 2, (base[0][1] + base[1][1]) / 2];
    const ground = r.evaluate(mx + out[0] * probe, my + out[1] * probe);
    const [cx, cy] = centroid(layer.ring);
    const rise = Math.max(0.5, r.surface(layer, cx, cy) - ground);
    const [gap, rows, step] = [0.02, 12, 0.25];
    const edges = layer.loops.flatMap((loop) => loop.map((a, k): [Pt, Pt] => [a, loop[(k + 1) % loop.length]]));
    /** How far back (against `out`) the shape reaches from a point of its outline: to where it ends behind it. */
    const back = ([px, py]: Pt) => {
      const [dx, dy] = [-out[0], -out[1]];
      let far = 0;
      for (const [[ax, ay], [bx, by]] of edges) {
        const [ex, ey] = [bx - ax, by - ay];
        const det = dx * -ey - dy * -ex;
        if (Math.abs(det) < 1e-12) {
          continue;
        }
        // p + t·d = a + u·e
        const [rx, ry] = [ax - px, ay - py];
        const t = (rx * -ey - ry * -ex) / det;
        const u = (dx * ry - dy * rx) / det;
        if (t > 1e-6 && u >= -1e-9 && u <= 1 + 1e-9) {
          far = Math.max(far, t);
        }
      }
      return far;
    };
    const tris: V5[] = [];
    for (const [a, b] of edges) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) {
        continue;
      }
      // Its outward side; only a side facing the front.
      let [nx, ny] = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
      const [mx2, my2] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (covers(layer, mx2 + nx * 0.01, my2 + ny * 0.01)) {
        [nx, ny] = [-nx, -ny];
      }
      if (nx * out[0] + ny * out[1] < 0.05) {
        continue;
      }
      const steps = Math.max(1, Math.ceil(len / step));
      const columns = Array.from({ length: steps + 1 }, (_, i) => {
        const p: Pt = [a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps];
        const t = back(p);
        return { p, q: [p[0] - out[0] * t, p[1] - out[1] * t] as Pt };
      });
      const point = (i: number, j: number): V5 => {
        const { p, q } = columns[i];
        const f = j / rows;
        return [p[0] + nx * gap, p[1] + ny * gap, ground + f * rise, p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
      };
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < steps; i++) {
          const [p0, p1, p2, p3] = [point(i, j), point(i + 1, j), point(i, j + 1), point(i + 1, j + 1)];
          tris.push(p0, p1, p3, p0, p3, p2);
        }
      }
    }
    return tris;
  }

  /**
   * A four-corner standing shape's picture unfolded on its own sides: its
   * base on the ground just past it, the side across up at its height (as it
   * measures), in a 12×12 grid so the picture stretches evenly between them.
   * Wrapped, the front is what's straight across from its base; what's left
   * over at each end (a triangle) goes on the side there.
   */
  private unfoldedCard(layer: Layer, { base, top, out }: { base: [Pt, Pt]; top: [Pt, Pt]; out: Pt }): V5[] {
    const r = this.relief;
    const probe = 0.1;
    const [mx, my] = [(base[0][0] + base[1][0]) / 2, (base[0][1] + base[1][1]) / 2];
    const ground = r.evaluate(mx + out[0] * probe, my + out[1] * probe);
    const [cx, cy] = centroid(layer.ring);
    const rise = Math.max(0.5, r.surface(layer, cx, cy) - ground);
    const gap = 0.02;
    const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const n = 12;
    const tris: V5[] = [];
    /** A face standing on `from`→`to` (pushed `push` out), the picture from `foot0`→`foot1` at its foot to `top0`→`top1` at its top. */
    const face = (from: Pt, to: Pt, push: Pt, foot0: Pt, foot1: Pt, top0: Pt, top1: Pt) => {
      const point = (i: number, j: number): V5 => {
        const foot = lerp(from, to, i / n);
        const drawn = lerp(lerp(foot0, foot1, i / n), lerp(top0, top1, i / n), j / n);
        return [foot[0] + push[0] * gap, foot[1] + push[1] * gap, ground + (j / n) * rise, drawn[0], drawn[1]];
      };
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const [a, b, c, d] = [point(i, j), point(i + 1, j), point(i, j + 1), point(i + 1, j + 1)];
          tris.push(a, b, d, a, d, c);
        }
      }
    };
    const [B0, B1] = base;
    const [T0, T1] = top;
    if (layer.wrap) {
      const [dx, dy] = [T1[0] - T0[0], T1[1] - T0[1]];
      // Where a line from a base corner, straight in (against `out`), meets the side across: how far along it.
      const across = (B: Pt) => {
        const det = out[0] * dy - out[1] * dx;
        if (Math.abs(det) < 1e-9) {
          return null;
        }
        return Math.max(0, Math.min(1, ((T0[0] - B[0]) * out[1] - (T0[1] - B[1]) * out[0]) / det));
      };
      const [u0, u1] = [across(B0), across(B1)];
      if (u0 !== null && u1 !== null && u0 < u1) {
        const [P0, P1] = [lerp(T0, T1, u0), lerp(T0, T1, u1)];
        face(B0, B1, out, B0, B1, P0, P1);
        const [qx, qy] = [(B0[0] + B1[0] + T0[0] + T1[0]) / 4, (B0[1] + B1[1] + T0[1] + T1[1]) / 4];
        const outward = (a: Pt, b: Pt): Pt => {
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const v: Pt = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
          const [ox, oy] = [(a[0] + b[0]) / 2 - qx, (a[1] + b[1]) / 2 - qy];
          return v[0] * ox + v[1] * oy < 0 ? [-v[0], -v[1]] : v;
        };
        if (Math.hypot(P0[0] - T0[0], P0[1] - T0[1]) > 1e-3) {
          face(B0, T0, outward(B0, T0), B0, T0, P0, T0);
        }
        if (Math.hypot(P1[0] - T1[0], P1[1] - T1[1]) > 1e-3) {
          face(B1, T1, outward(B1, T1), B1, T1, P1, T1);
        }
        return tris;
      }
    }
    face(B0, B1, out, B0, B1, T0, T1);
    return tris;
  }

  /**
   * Each shape's water: up to its depth over its lowest floor, and out over
   * the ground round it that's lower (joined to it), on a grid a quarter of a
   * cell across. Its surface's triangles, and the cells it covers.
   */
  private water(): { tris: V3[]; cells: number[]; step: number } {
    const r = this.relief;
    const step = 0.25;
    const nx = Math.round(r.data.w / step);
    const ny = Math.round(r.data.h / step);
    const tris: V3[] = [];
    const cells: number[] = [];
    for (const layer of r.layers) {
      const depth = r.data.shapes[layer.si].water;
      if (!depth || !(depth > 0) || layer.stand) {
        continue;
      }
      // Its cells, and its lowest floor among them.
      const { x0, y0, x1, y1 } = layer.box;
      const seeds: number[] = [];
      let floor = Infinity;
      for (let j = Math.max(0, Math.floor(y0 / step)); j < Math.min(ny, Math.ceil(y1 / step)); j++) {
        for (let i = Math.max(0, Math.floor(x0 / step)); i < Math.min(nx, Math.ceil(x1 / step)); i++) {
          const [x, y] = [(i + 0.5) * step, (j + 0.5) * step];
          if (covers(layer, x, y)) {
            seeds.push(j * nx + i);
            floor = Math.min(floor, r.surface(layer, x, y));
          }
        }
      }
      if (seeds.length === 0) {
        continue;
      }
      const level = floor + depth;
      // Out from them, over what's lower than the water.
      const wet = new Uint8Array(nx * ny);
      const queue: number[] = [];
      for (const c of seeds) {
        if (r.evaluate(((c % nx) + 0.5) * step, (Math.floor(c / nx) + 0.5) * step) < level - 1e-3) {
          wet[c] = 1;
          queue.push(c);
        }
      }
      while (queue.length > 0 && queue.length < 400000) {
        const c = queue.pop()!;
        const [i, j] = [c % nx, Math.floor(c / nx)];
        for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
          const n = b * nx + a;
          if (a < 0 || b < 0 || a >= nx || b >= ny || wet[n]) {
            continue;
          }
          if (r.evaluate((a + 0.5) * step, (b + 0.5) * step) < level - 1e-3) {
            wet[n] = 1;
            queue.push(n);
          }
        }
      }
      for (let c = 0; c < wet.length; c++) {
        if (!wet[c]) {
          continue;
        }
        const [x, y] = [(c % nx) * step, Math.floor(c / nx) * step];
        tris.push([x, y, level], [x + step, y, level], [x + step, y + step, level], [x, y, level], [x + step, y + step, level], [x, y + step, level]);
        cells.push(x, y);
      }
    }
    return { tris, cells, step };
  }
}

/** A layer's outlines as text: what its cuts are kept by. */
function signature(layer: { loops: Pt[][] }): string {
  return layer.loops.map((loop) => loop.map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`).join(" ")).join(" / ");
}

/** A square cut by outlines into the pieces between them, each as triangles of [x, y] points. */
function partition(square: Pt[], shapes: Pt[][][]): { tris: Pt[][] }[] {
  let parts: Pt[][][] = [[closed(square)]];
  for (const loops of shapes) {
    if (loops[0].length < 3) {
      // Its outline doesn't reach the square after all.
      continue;
    }
    const shape = loops.map(closed);
    const next: Pt[][][] = [];
    for (const part of parts) {
      try {
        next.push(...(clip.intersection(part, shape) as Pt[][][]), ...(clip.difference(part, shape) as Pt[][][]));
      } catch {
        next.push(part);
      }
    }
    parts = next;
  }
  const out: { tris: Pt[][] }[] = [];
  for (const polygon of parts) {
    const rings = polygon.map(open);
    if (rings[0].length < 3) {
      continue;
    }
    try {
      const t = triangulate(rings);
      out.push({ tris: t.tris.map((u) => u.map((k) => t.pts[k])) });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * An outline cut to a box [x0, y0, x1, y1] (Sutherland-Hodgman): what's of it
 * in the box, though where it goes out and back it runs along the box's edge.
 */
function clipToBox(ring: Pt[], [x0, y0, x1, y1]: [number, number, number, number]): Pt[] {
  let out = ring;
  const inside = [(p: Pt) => p[0] >= x0, (p: Pt) => p[0] <= x1, (p: Pt) => p[1] >= y0, (p: Pt) => p[1] <= y1];
  const cross = [
    (a: Pt, b: Pt): Pt => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])],
    (a: Pt, b: Pt): Pt => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])],
    (a: Pt, b: Pt): Pt => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0],
    (a: Pt, b: Pt): Pt => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1],
  ];
  for (let e = 0; e < 4 && out.length > 0; e++) {
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k++) {
      const a = input[(k + input.length - 1) % input.length];
      const b = input[k];
      const [ina, inb] = [inside[e](a), inside[e](b)];
      if (inb) {
        if (!ina) {
          out.push(cross[e](a, b));
        }
        out.push(b);
      } else if (ina) {
        out.push(cross[e](a, b));
      }
    }
  }
  return out;
}

/**
 * Where round a shape a point is, as a way across its picture (0 to 1): by
 * its angle about the shape's middle, there and back (a picture painted from
 * one side shows the front; going round, the back is its mirror, so the seam
 * doesn't show). As the Vistazo's skinAcross.
 */
export function skinAcross(skin: Skin, x: number, y: number): number {
  const turn = (Math.atan2(y - skin.center[1], x - skin.center[0]) / (2 * Math.PI) + 1) % 1;
  return 1 - Math.abs(2 * turn - 1);
}

/** The map point of a picture's `across` (0 to 1) and `up` (0 at its foot, 1 at its far end). As the Vistazo's skinPoint. */
export function skinPoint(skin: Skin, across: number, up: number): Pt {
  const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return lerp(lerp(skin.base[0], skin.base[1], across), lerp(skin.top[0], skin.top[1], across), up);
}
