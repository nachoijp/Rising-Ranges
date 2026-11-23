import * as THREE from "three";

// The walls' patterns (see buildWalls), drawn here once each: a height and a colour worked out at each
// pixel of a tile that repeats, then lit from above (a bevel on each piece).

/**
 * A grey tile (256 px, two cells across) that repeats seamlessly, to tint
 * with the map's colour: brick courses ("stone"), irregular stones
 * ("rubble"), earth strata, or planks. Drawn once each (each takes some
 * tens of ms), a new texture on it each time.
 */
export function patternTexture(style: "stone" | "rubble" | "earth" | "wood"): THREE.CanvasTexture {
  let texture = patternTextures.get(style);
  if (!texture) {
    texture = new THREE.CanvasTexture(drawPattern(style));
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    // One for every material of its style, every build: not to be let go with one (see isShared).
    texture.userData.shared = true;
    patternTextures.set(style, texture);
  }
  return texture;
}

/** A texture every build shares (a pattern's): kept when what uses it is let go. */
export const isShared = (texture: THREE.Texture) => texture.userData.shared === true;

const patternTextures = new Map<string, THREE.CanvasTexture>();

const SIZE = 256;

/** A small deterministic random, so a pattern is the same every time. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(i: number, j: number, s: number): number {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(s + 1, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Value noise that repeats across the tile: `px` × `py` cells over it (whole numbers). */
function vnoise(x: number, y: number, px: number, py: number, s: number): number {
  const fx = (x * px) / SIZE;
  const fy = (y * py) / SIZE;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const ux = tx * tx * (3 - 2 * tx);
  const uy = ty * ty * (3 - 2 * ty);
  const mx = (v: number) => ((v % px) + px) % px;
  const my = (v: number) => ((v % py) + py) % py;
  const x0 = mx(ix);
  const x1 = mx(ix + 1);
  const y0 = my(iy);
  const y1 = my(iy + 1);
  const a = hash2(x0, y0, s);
  const b = hash2(x1, y0, s);
  const c = hash2(x0, y1, s);
  const d = hash2(x1, y1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Octaves of it, each twice as fine: 0 to 1, about 0.5 on average. */
function fbm(x: number, y: number, px: number, py: number, octaves: number, s: number): number {
  let v = 0;
  let a = 0.5;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    v += a * vnoise(x, y, px, py, s + o * 31);
    total += a;
    a *= 0.5;
    px *= 2;
    py *= 2;
  }
  return v / total;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** The shortest way between two points along a tile that repeats. */
const wrap = (d: number) => {
  d = Math.abs(d) % SIZE;
  return Math.min(d, SIZE - d);
};

/**
 * Lit from above and a little to the left (the canvas's top is a wall's top), by the slope of `height`;
 * flat comes out as `albedo`. Then scaled so its average is `mean` (the old tile's: a map's colour comes
 * out as bright on it as before).
 */
function lit(height: Float32Array, albedo: Float32Array, relief: number, mean: number | undefined, c: CanvasRenderingContext2D) {
  const L = [0.3, -0.6, 0.74];
  const len = Math.hypot(L[0], L[1], L[2]);
  const [lx, ly, lz] = L.map((v) => v / len);
  const out = new Float32Array(SIZE * SIZE);
  let sum = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const at = (xx: number, yy: number) => height[((yy + SIZE) % SIZE) * SIZE + ((xx + SIZE) % SIZE)];
      const dx = (at(x + 1, y) - at(x - 1, y)) * relief;
      const dy = (at(x, y + 1) - at(x, y - 1)) * relief;
      const n = Math.hypot(dx, dy, 1);
      const d = Math.max(0, (-dx * lx - dy * ly + lz) / n);
      const v = albedo[y * SIZE + x] * (0.62 + 0.38 * d / lz);
      out[y * SIZE + x] = v;
      sum += v;
    }
  }
  const k = mean ? mean / (sum / out.length) : 1;
  const image = c.createImageData(SIZE, SIZE);
  for (let i = 0; i < out.length; i++) {
    const v = Math.max(0, Math.min(255, out[i] * k));
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = v;
    image.data[i * 4 + 3] = 255;
  }
  c.putImageData(image, 0, 0);
}

/** Widths of pieces across the tile, between `min` and `max`, adding up to it exactly (so it repeats). */
function widths(random: () => number, min: number, max: number): number[] {
  const out: number[] = [];
  let rest = SIZE;
  while (rest > max + min) {
    const w = Math.round(min + random() * (max - min));
    out.push(w);
    rest -= w;
  }
  if (rest > max) {
    out.push(Math.floor(rest / 2), rest - Math.floor(rest / 2));
  } else {
    out.push(rest);
  }
  return out;
}

type PatternStyle = "stone" | "rubble" | "earth" | "wood";

/**
 * Each tile's average grey: the old flat tiles' (measured 2026-11-22), so a map's colour comes out as
 * bright on the new ones as it did.
 */
const MEAN: Record<PatternStyle, number> = { stone: 210.6, rubble: 188.5, earth: 206.9, wood: 196.7 };

function drawPattern(style: PatternStyle): HTMLCanvasElement {
  const mean = MEAN[style];
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const c = canvas.getContext("2d")!;
  const height = new Float32Array(SIZE * SIZE);
  const albedo = new Float32Array(SIZE * SIZE);
  const random = seeded(style === "stone" ? 7 : style === "rubble" ? 5 : style === "earth" ? 11 : 13);
  let relief = 4;
  if (style === "stone") {
    // Four courses of blocks of uneven length and tone, each row offset; rounded, a little worn and
    // chipped at the edges; the mortar sunk between them, uneven.
    const row = SIZE / 4;
    const rows = [0, 1, 2, 3].map(() => {
      const start = random() * SIZE;
      let x0 = 0;
      const blocks = widths(random, 64, 120).map((w) => {
        const b = { x0, w, shade: 196 + random() * 46, tilt: (random() - 0.5) * 14 };
        x0 += w;
        return b;
      });
      return { start, blocks };
    });
    for (let y = 0; y < SIZE; y++) {
      const r = Math.floor(y / row);
      const ly = y - r * row;
      const { start, blocks } = rows[r];
      for (let x = 0; x < SIZE; x++) {
        const xx = (((x - start) % SIZE) + SIZE) % SIZE;
        const b = blocks.find((bb) => xx < bb.x0 + bb.w) ?? blocks[blocks.length - 1];
        const lx = xx - b.x0;
        // Its rounded outline's distance (negative inside), the mortar 2.5 px each side, uneven.
        const radius = 4;
        const qx = Math.abs(lx - b.w / 2) - (b.w / 2 - 2 - radius);
        const qy = Math.abs(ly - row / 2) - (row / 2 - 2 - radius);
        let d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
        d += (fbm(x, y, 16, 16, 2, 3) - 0.5) * 2.5;
        const inside = -d;
        const rough = fbm(x, y, 16, 16, 3, 5);
        // Chips: bites out of it near its edge.
        const chip = smoothstep(0.6, 0.72, fbm(x, y, 12, 12, 2, 9)) * (1 - smoothstep(0, 9, inside));
        height[y * SIZE + x] = smoothstep(-0.5, 4, inside) * (0.85 + 0.15 * rough) - chip * 0.55;
        const face = b.shade * (0.86 + 0.26 * fbm(x, y, 8, 8, 4, 13)) + b.tilt * (0.5 - ly / row);
        const mortar = 150 * (0.88 + 0.24 * fbm(x, y, 32, 32, 2, 17));
        albedo[y * SIZE + x] = mix(mortar, face * (1 - chip * 0.12), smoothstep(-0.5, 1.5, inside));
      }
    }
  } else if (style === "rubble") {
    // Irregular stones (each pixel its nearest of some jittered points, across the tile's edges too),
    // their outlines uneven and bevelled, each mottled its own way, the mortar sunk between them.
    const cells = 6;
    const seeds: { x: number; y: number; shade: number; k: number }[] = [];
    for (let gy = 0; gy < cells; gy++) {
      for (let gx = 0; gx < cells; gx++) {
        seeds.push({ x: ((gx + 0.1 + random() * 0.8) * SIZE) / cells, y: ((gy + 0.1 + random() * 0.8) * SIZE) / cells, shade: 172 + random() * 66, k: Math.floor(random() * 1000) });
      }
    }
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        // Where it's looked up a little warped: the outlines uneven, not straight between two points.
        const wx = x + (fbm(x, y, 8, 8, 2, 21) - 0.5) * 10;
        const wy = y + (fbm(x, y, 8, 8, 2, 23) - 0.5) * 10;
        let d1 = Infinity;
        let d2 = Infinity;
        let near = seeds[0];
        for (const seed of seeds) {
          const dx = wrap(wx - seed.x);
          const dy = wrap(wy - seed.y);
          const d = dx * dx + dy * dy;
          if (d < d1) {
            d2 = d1;
            d1 = d;
            near = seed;
          } else if (d < d2) {
            d2 = d;
          }
        }
        const edge = Math.sqrt(d2) - Math.sqrt(d1);
        const rough = fbm(x, y, 16, 16, 3, 25 + near.k);
        height[y * SIZE + x] = smoothstep(0.8, 8, edge) * (0.85 + 0.15 * rough);
        const face = near.shade * (0.88 + 0.22 * fbm(x, y, 8, 8, 4, 29 + near.k));
        const mortar = 140 * (0.88 + 0.24 * fbm(x, y, 32, 32, 2, 31));
        albedo[y * SIZE + x] = mix(mortar, face, smoothstep(0.6, 2.2, edge));
      }
    }
  } else if (style === "earth") {
    // Wavy strata of different shades, running into each other, a little stepped; pebbles in them,
    // rounded.
    relief = 4;
    let total = 0;
    const raw: { h: number; shade: number; phase: number; amp: number; step: number }[] = [];
    // Thin ones and thick ones; each a shade drifting from the one above (not light, dark, light...).
    let shade = 205;
    while (total < SIZE) {
      const h = random() < 0.45 ? 5 + random() * 9 : 22 + random() * 38;
      shade = Math.min(236, Math.max(176, shade + (random() - 0.5) * 52));
      raw.push({ h, shade, phase: random() * Math.PI * 2, amp: 2 + random() * 4, step: random() * 0.15 });
      total += h;
    }
    // Their heights scaled to add up to the tile (so it repeats down it too).
    let y0 = 0;
    const layers = raw.map((l) => {
      const layer = { ...l, y0 };
      y0 += (l.h * SIZE) / total;
      return layer;
    });
    const n = layers.length;
    const pebbles = Array.from({ length: 60 }, () => ({ x: random() * SIZE, y: random() * SIZE, r: 1 + random() * 1.6, squash: 0.65 + random() * 0.35, shade: random() < 0.65 ? 214 + random() * 22 : 165 + random() * 20 }));
    for (let x = 0; x < SIZE; x++) {
      // Each boundary across this column, wavy, and its own noise.
      const bounds = layers.map((l, k) => l.y0 + Math.sin((x / SIZE) * Math.PI * 4 + l.phase) * l.amp + (fbm(x, k * 7, 8, 4, 2, 41 + k) - 0.5) * 8);
      for (let y = 0; y < SIZE; y++) {
        // The last boundary at or above it (the ones above the tile, a tile up, count too).
        let k = -1;
        let at = -Infinity;
        for (let i = 0; i < n; i++) {
          for (const shift of [-SIZE, 0, SIZE]) {
            const b = bounds[i] + shift;
            if (b <= y && b > at) {
              at = b;
              k = i;
            }
          }
        }
        const layer = layers[k];
        const above = layers[(k + n - 1) % n];
        const t = smoothstep(0, 4, y - at);
        const h = mix(above.step, layer.step, t) + 0.3 * fbm(x, y, 16, 8, 4, 43);
        // Thin laminae across each, wavy as its boundaries are: strata within the strata.
        const wave = Math.sin((x / SIZE) * Math.PI * 4 + layer.phase) * layer.amp;
        const laminae = fbm(x, y - wave, 2, 40, 3, 49 + k);
        const a = mix(above.shade, layer.shade, t) * (0.9 + 0.12 * fbm(x, y, 16, 32, 3, 47)) * (0.9 + 0.2 * laminae);
        height[y * SIZE + x] = h;
        albedo[y * SIZE + x] = a;
      }
    }
    // The pebbles over them, each over its own few pixels (round the tile's edges too).
    for (const p of pebbles) {
      const reach = Math.ceil(p.r + 1);
      for (let oy = -reach; oy <= reach; oy++) {
        for (let ox = -reach; ox <= reach; ox++) {
          const x = Math.round(p.x) + ox;
          const y = Math.round(p.y) + oy;
          const d = Math.hypot(x - p.x, (y - p.y) / p.squash);
          if (d >= p.r + 1) continue;
          const i = (((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE);
          const k2 = 1 - smoothstep(p.r - 0.8, p.r + 0.6, d);
          const dome = Math.sqrt(Math.max(0, 1 - (d / (p.r + 0.6)) ** 2)) * 0.35;
          height[i] += dome * k2;
          albedo[i] = mix(albedo[i], p.shade, k2);
        }
      }
    }
  } else {
    // Upright planks with dark gaps, each in two boards (their ends staggered), grain along them that
    // bends round the odd knot.
    relief = 5;
    let x0 = 0;
    const planks = widths(random, 28, 44).map((w) => {
      const plank = {
        x0,
        w,
        joint: random() * SIZE,
        boards: [0, 1].map(() => ({ shade: 196 + random() * 40, freq: (Math.PI * 2) / (5 + random() * 4), phase: random() * 10, s: Math.floor(random() * 1000) })),
        knot: random() < 0.55 ? { x: 8 + random() * (w - 16), y: random() * SIZE, r: 2.5 + random() * 3 } : null,
      };
      x0 += w;
      return plank;
    });
    for (let x = 0; x < SIZE; x++) {
      const plank = planks.find((p) => x < p.x0 + p.w) ?? planks[planks.length - 1];
      const lx = x - plank.x0;
      const side = Math.min(lx, plank.w - 1 - lx);
      for (let y = 0; y < SIZE; y++) {
        const fromJoint = wrap(y - plank.joint);
        // One board a plank, the tile long (two cells), its ends where the joint is.
        const board = plank.boards[0];
        let u = lx + (fbm(x, y, 4, 2, 2, 61 + board.s) - 0.5) * 6;
        let knot = 0;
        if (plank.knot) {
          const dx = lx - plank.knot.x;
          const dy = wrap(y - plank.knot.y) / 1.7;
          const d = Math.hypot(dx, dy);
          const bend = Math.exp(-((d / (plank.knot.r * 2.6)) ** 2));
          u += dx * bend * 1.4;
          knot = 0.7 * (1 - smoothstep(plank.knot.r * 0.6, plank.knot.r, d));
          knot += 0.25 * (1 - smoothstep(0, 0.8, Math.abs(d - plank.knot.r * 1.25)));
        }
        const stripes = 0.5 + 0.5 * Math.sin(u * board.freq + board.phase);
        const streak = fbm(x, y, 64, 2, 2, 67 + board.s);
        const gap = smoothstep(0.5, 2.5, side) * smoothstep(0.5, 2.2, fromJoint);
        height[y * SIZE + x] = gap * (0.9 + 0.1 * streak) - knot * 0.08;
        const face = board.shade * (0.8 + 0.12 * stripes + 0.14 * streak) * (1 - knot * 0.38);
        albedo[y * SIZE + x] = mix(100, face, smoothstep(0.5, 1.8, Math.min(side, fromJoint)));
      }
    }
  }
  // A little soft grain over all of it (not a pixel's own: no sparkle at a distance).
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      albedo[y * SIZE + x] *= 0.96 + 0.08 * fbm(x, y, 64, 64, 2, 71);
    }
  }
  lit(height, albedo, relief, mean, c);
  return canvas;
}
