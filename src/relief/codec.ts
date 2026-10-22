import { G, cellKey, cellOf } from "./relief";
import type { Affine, Detail, HeightPoint, ReliefData, Shape, Vert } from "./types";

// A relief as it's kept (JSON): versioned; vertices and points as [x, y, h]
// rounded to hundredths of a cell; the painted ground in 32nds of a level
// (Int16, base64), left out when nothing's painted; a shape's painted relief
// as its frame and the points painted.

export const RELIEF_VERSION = 1;
const GROUND_SCALE = 32;

type StoredDetail = { m: Affine; cells: number[] };
type StoredShape = Omit<Shape, "detail"> & { detail?: StoredDetail };

export type StoredRelief = {
  v: number;
  w: number;
  h: number;
  verts: [number, number, number][];
  shapes: StoredShape[];
  points: [number, number, number][];
  ground?: string;
};

const r2 = (v: number) => Math.round(v * 100) / 100;

export function toStored(data: ReliefData): StoredRelief {
  const stored: StoredRelief = {
    v: RELIEF_VERSION,
    w: data.w,
    h: data.h,
    verts: data.verts.map((v) => [r2(v.x), r2(v.y), v.h]),
    shapes: data.shapes.map((s) => {
      const { detail, ...rest } = s;
      const out: StoredShape = { ...rest };
      if (!out.holes?.length) {
        delete out.holes;
      }
      if (detail && detail.v.size > 0) {
        out.detail = writeDetail(detail);
      }
      return out;
    }),
    points: data.points.map((p) => [r2(p.x), r2(p.y), p.h]),
  };
  if (data.ground.some((g) => Math.round(g * GROUND_SCALE) !== 0)) {
    const q = new Int16Array(data.ground.length);
    for (let i = 0; i < q.length; i++) {
      q[i] = Math.max(-32768, Math.min(32767, Math.round(data.ground[i] * GROUND_SCALE)));
    }
    stored.ground = toBase64(new Uint8Array(q.buffer));
  }
  return stored;
}

/** A kept relief read back; null if it isn't one this version can read. */
export function fromStored(stored: unknown): ReliefData | null {
  const s = stored as StoredRelief | null;
  if (!s || typeof s !== "object" || s.v !== RELIEF_VERSION || !(s.w > 0) || !(s.h > 0)) {
    return null;
  }
  const gw = Math.round(s.w / G) + 1;
  const gh = Math.round(s.h / G) + 1;
  const ground = new Float32Array(gw * gh);
  if (s.ground) {
    const q = new Int16Array(fromBase64(s.ground).buffer);
    if (q.length === ground.length) {
      for (let i = 0; i < q.length; i++) {
        ground[i] = q[i] / GROUND_SCALE;
      }
    }
  }
  const verts: Vert[] = (s.verts ?? []).map(([x, y, h]) => ({ x, y, h }));
  const points: HeightPoint[] = (s.points ?? []).map(([x, y, h]) => ({ x, y, h }));
  const shapes: Shape[] = (s.shapes ?? []).map((shape) => {
    const { detail, ...rest } = shape;
    return detail ? { ...rest, detail: readDetail(detail) } : { ...rest };
  });
  return { w: s.w, h: s.h, verts, shapes, points, ground };
}

/** An empty relief for a map `w` × `h` cells. */
export function emptyRelief(w: number, h: number): ReliefData {
  return { w, h, verts: [], shapes: [], points: [], ground: new Float32Array((Math.round(w / G) + 1) * (Math.round(h / G) + 1)) };
}

function writeDetail({ m, v }: Detail): StoredDetail {
  const cells: number[] = [];
  for (const [key, h] of v) {
    const q = Math.round(h * GROUND_SCALE);
    if (q !== 0) {
      cells.push(...cellOf(key), q);
    }
  }
  return { m: m.map((n) => Math.round(n * 1e5) / 1e5) as Affine, cells };
}

function readDetail({ m, cells }: StoredDetail): Detail {
  const v = new Map<number, number>();
  for (let k = 0; k + 2 < cells.length; k += 3) {
    v.set(cellKey(cells[k], cells[k + 1]), cells[k + 2] / GROUND_SCALE);
  }
  return { m: m ?? [1, 0, 0, 1, 0, 0], v };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i);
  }
  return bytes;
}
