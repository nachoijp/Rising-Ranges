import type { Pt } from "../types";
import type { Picture } from "./uvtt";
import { loopsOf, paintRings, type Loop } from "./vector";

// What's solid: the plan's lines part the map into areas; an area that's dark
// on the picture (the black round a dungeon's rooms, rock drawn in shadow)
// and isn't one of the rooms is rock, not ground — a solid block, not a floor
// with walls round it. Owlbear's Forecast rooms are rooms whatever their
// colour (a dark stairwell stays one); everything else is told by the picture.
//
// Dark is the map's own: below a share of its lighter ground (the upper
// quarter of its lightness), so a night map's floors aren't taken for rock.

/** An area's dark share to be solid; how dark a pixel is, of the lighter ground's lightness; the least solid (squares²). */
const DARK_SHARE = 0.6;
const DARK_OF = 0.45;
const MIN_AREA = 0.25;

/** A line's half width as a barrier between areas (squares): ends a little short of each other still part them. */
const BARRIER = 0.06;

/**
 * The solid areas, as outlines with holes (cells of `pic`), reaching to the
 * lines round them; `at` a point's solid or not; `share` of an outline that's
 * solid. `lab`: the picture's Lab (labOf); `lines`: everything that parts
 * areas (walls, doors, the fog's edges); `rooms`: outlines that are rooms
 * whatever they look like.
 */
export function solidAreas(
  pic: Picture,
  lab: Float32Array,
  lines: Pt[][],
  rooms: Pt[][],
): { loops: Loop[]; at: (x: number, y: number) => boolean; share: (ring: Pt[]) => number } {
  const { w: W, h: H, px } = pic;
  const N = W * H;
  // The lighter ground's lightness: the upper quarter of the map's (by a histogram of whole steps of L).
  const hist = new Uint32Array(101);
  for (let i = 0; i < N; i++) hist[Math.max(0, Math.min(100, Math.round(lab[i * 3])))]++;
  let ref = 50;
  for (let L = 0, acc = 0; L <= 100; L++) if ((acc += hist[L]) >= 0.75 * N) {
    ref = L;
    break;
  }
  const dark = Math.max(8, DARK_OF * ref);

  // The lines, as barriers.
  const barrier = new Uint8Array(N);
  const r = Math.max(1, Math.round(BARRIER * px));
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1], [bx, by] = line[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * px * 2));
      for (let k = 0; k <= steps; k++) {
        const cx = Math.round((ax + ((bx - ax) * k) / steps) * px - 0.5), cy = Math.round((ay + ((by - ay) * k) / steps) * px - 0.5);
        for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++)
          for (let x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) barrier[y * W + x] = 1;
      }
    }
  }
  const room = new Uint8Array(N);
  for (const ring of rooms) paintRings(room, W, H, px, [ring], 1);

  // The areas between the lines (filled one at a time), and whether each is rock.
  const label = new Int32Array(N).fill(-1);
  const solid: boolean[] = [];
  const queue = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (barrier[s] || label[s] >= 0) continue;
    const id = solid.length;
    let head = 0, tail = 0, nDark = 0, nRoom = 0;
    const visit = (j: number) => {
      if (!barrier[j] && label[j] < 0) {
        label[j] = id;
        queue[tail++] = j;
      }
    };
    visit(s);
    while (head < tail) {
      const i = queue[head++];
      if (lab[i * 3] < dark) nDark++;
      if (room[i]) nRoom++;
      const x = i % W;
      if (x > 0) visit(i - 1);
      if (x < W - 1) visit(i + 1);
      if (i >= W) visit(i - W);
      if (i + W < N) visit(i + W);
    }
    const n = tail;
    solid.push(nRoom < n / 2 && nDark >= DARK_SHARE * n && n >= MIN_AREA * px * px);
  }

  // Solid pixels, out over the lines round them (to their middles).
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (label[i] >= 0 && solid[label[i]]) mask[i] = 1;
  for (let pass = 0; pass <= r; pass++) {
    const grow: number[] = [];
    for (let i = 0; i < N; i++) {
      if (mask[i] || !barrier[i]) continue;
      const x = i % W;
      if ((x > 0 && mask[i - 1]) || (x < W - 1 && mask[i + 1]) || (i >= W && mask[i - W]) || (i + W < N && mask[i + W])) grow.push(i);
    }
    for (const i of grow) mask[i] = 1;
  }
  const at = (x: number, y: number) => {
    const i = Math.floor(x * px), j = Math.floor(y * px);
    return i >= 0 && j >= 0 && i < W && j < H && mask[j * W + i] === 1;
  };
  // One scratch mask for every outline asked about, cleared over its box after.
  const own = new Uint8Array(N);
  const share = (ring: Pt[]) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of ring) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    const X0 = Math.max(0, Math.floor(x0 * px)), Y0 = Math.max(0, Math.floor(y0 * px));
    const X1 = Math.min(W, Math.ceil(x1 * px)), Y1 = Math.min(H, Math.ceil(y1 * px));
    paintRings(own, W, H, px, [ring], 1);
    let n = 0, s = 0;
    for (let y = Y0; y < Y1; y++)
      for (let x = X0; x < X1; x++) {
        const i = y * W + x;
        if (!own[i]) continue;
        own[i] = 0;
        n++;
        if (mask[i]) s++;
      }
    return n ? s / n : 0;
  };
  return { loops: loopsOf(mask, W, H, px, 0.08, MIN_AREA), at, share };
}
