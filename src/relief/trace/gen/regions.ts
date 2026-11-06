// The map's picture cut into regions of one look: first small cells of like
// colour (SLIC superpixels, about `S` pixels across, kept off the walls), then
// neighbours joined while they look alike (colour, grain) and the line between
// them is weak, cheapest first. A region doesn't cross a room's wall: the
// plan's rooms (if there's a plan) keep them apart.

/** A picture made ready: Lab, its grain (local spread of lightness), `px` pixels a cell. */
export type Img = { W: number; H: number; px: number; L: Float32Array; A: Float32Array; B: Float32Array; tex: Float32Array; lump: Float32Array };

/** The spread of `v` over a (2r+1)² window round each pixel (box sums). */
function spread(v: Float32Array, W: number, H: number, r: number): Float32Array {
  const s1 = new Float64Array((W + 1) * (H + 1)), s2 = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let a = 0, b = 0;
    for (let x = 0; x < W; x++) {
      const t = v[y * W + x];
      a += t;
      b += t * t;
      s1[(y + 1) * (W + 1) + x + 1] = s1[y * (W + 1) + x + 1] + a;
      s2[(y + 1) * (W + 1) + x + 1] = s2[y * (W + 1) + x + 1] + b;
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      const k = (x1 - x0) * (y1 - y0);
      const box = (s: Float64Array) => s[y1 * (W + 1) + x1] - s[y0 * (W + 1) + x1] - s[y1 * (W + 1) + x0] + s[y0 * (W + 1) + x0];
      const m = box(s1) / k;
      out[y * W + x] = Math.sqrt(Math.max(0, box(s2) / k - m * m));
    }
  return out;
}

/** `v` box-blurred over a (2r+1)² window. */
function blur(v: Float32Array, W: number, H: number, r: number): Float32Array {
  const s1 = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let a = 0;
    for (let x = 0; x < W; x++) {
      a += v[y * W + x];
      s1[(y + 1) * (W + 1) + x + 1] = s1[y * (W + 1) + x + 1] + a;
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      out[y * W + x] = (s1[y1 * (W + 1) + x1] - s1[y0 * (W + 1) + x1] - s1[y1 * (W + 1) + x0] + s1[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
  return out;
}

export function prepareImg(data: Uint8ClampedArray, W: number, H: number, px: number): Img {
  const n = W * H;
  const lin = Float32Array.from({ length: 256 }, (_, i) => {
    const c = i / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = lin[data[i * 4]], g = lin[data[i * 4 + 1]], b = lin[data[i * 4 + 2]];
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
    const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    L[i] = 116 * y - 16;
    A[i] = 500 * (x - y);
    B[i] = 200 * (y - z);
  }
  // A night (or tinted) map: its cast taken off, as a day map's would be (its mean blue-yellow and
  // red-green moved to a day map's usual, its middle lightness lifted to a day map's). Water, leaves
  // and rock are then told apart by the same colours.
  const sample = (v: Float32Array) => {
    const out: number[] = [];
    for (let i = 0; i < n; i += 13) out.push(v[i]);
    return out.sort((a, b) => a - b);
  };
  const midL = sample(L)[Math.floor(n / 13 / 2)] ?? 50;
  const meanA = A.reduce((s, v) => s + v, 0) / n, meanB = B.reduce((s, v) => s + v, 0) / n;
  const DAY_B = 18, DAY_A = 0, DAY_L = 55;
  if (meanB < 6 || midL < 35) {
    const dA = DAY_A - meanA, dB = DAY_B - meanB, kL = midL > 1 ? Math.min(2.5, DAY_L / midL) : 1;
    for (let i = 0; i < n; i++) {
      L[i] = Math.min(100, L[i] * kL);
      A[i] += dA * 0.7;
      B[i] += dB;
    }
  }
  // Grain: the spread of lightness over a fifth of a cell; lumps: the spread, over half a cell, of
  // the lightness blurred over a tenth (a lawn's fine grain blurs away, leaf clusters don't).
  const tex = spread(L, W, H, Math.max(1, Math.round(px / 10)));
  const lump = spread(blur(L, W, H, Math.max(1, Math.round(px / 10))), W, H, Math.max(2, Math.round(px / 4)));
  return { W, H, px, L, A, B, tex, lump };
}

/** Superpixels: a label per pixel (-1 where `blocked`), about S pixels across. */
export function slic(img: Img, S: number, blocked: Uint8Array, compact = 10, iterations = 5): { labels: Int32Array; count: number } {
  const { W, H, L, A, B } = img;
  const cx: number[] = [], cy: number[] = [], cL: number[] = [], cA: number[] = [], cB: number[] = [];
  for (let y = S / 2; y < H; y += S)
    for (let x = S / 2; x < W; x += S) {
      const i = Math.floor(y) * W + Math.floor(x);
      if (blocked[i]) continue;
      cx.push(x);
      cy.push(y);
      cL.push(L[i]);
      cA.push(A[i]);
      cB.push(B[i]);
    }
  const K = cx.length;
  const label = new Int32Array(W * H).fill(-1);
  const dist = new Float32Array(W * H);
  const mS = (compact / S) ** 2;
  for (let it = 0; it < iterations; it++) {
    dist.fill(Infinity);
    for (let k = 0; k < K; k++) {
      const x0 = Math.max(0, Math.floor(cx[k] - S)), x1 = Math.min(W, Math.ceil(cx[k] + S));
      const y0 = Math.max(0, Math.floor(cy[k] - S)), y1 = Math.min(H, Math.ceil(cy[k] + S));
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = y * W + x;
          if (blocked[i]) continue;
          const dl = L[i] - cL[k], da = A[i] - cA[k], db = B[i] - cB[k];
          const dx = x - cx[k], dy = y - cy[k];
          const d = dl * dl + da * da + db * db + mS * (dx * dx + dy * dy);
          if (d < dist[i]) {
            dist[i] = d;
            label[i] = k;
          }
        }
    }
    const n = new Float64Array(K), sx = new Float64Array(K), sy = new Float64Array(K), sl = new Float64Array(K), sa = new Float64Array(K), sb = new Float64Array(K);
    for (let i = 0; i < W * H; i++) {
      const k = label[i];
      if (k < 0) continue;
      n[k]++;
      sx[k] += i % W;
      sy[k] += Math.floor(i / W);
      sl[k] += L[i];
      sa[k] += A[i];
      sb[k] += B[i];
    }
    for (let k = 0; k < K; k++) {
      if (!n[k]) continue;
      cx[k] = sx[k] / n[k];
      cy[k] = sy[k] / n[k];
      cL[k] = sl[k] / n[k];
      cA[k] = sa[k] / n[k];
      cB[k] = sb[k] / n[k];
    }
  }
  // Every open pixel some label (one no centre reached takes its neighbour's).
  for (let pass = 0; pass < 4; pass++)
    for (let i = 0; i < W * H; i++) {
      if (label[i] >= 0 || blocked[i]) continue;
      const x = i % W;
      label[i] = x > 0 && label[i - 1] >= 0 ? label[i - 1] : i >= W && label[i - W] >= 0 ? label[i - W] : x < W - 1 && label[i + 1] >= 0 ? label[i + 1] : label[i];
    }
  // Connected pieces: each its own label; small ones join a neighbour.
  const out = new Int32Array(W * H).fill(-1);
  let count = 0;
  const stack: number[] = [];
  const small = (S * S) / 4;
  for (let s = 0; s < W * H; s++) {
    if (out[s] >= 0 || label[s] < 0) continue;
    const piece: number[] = [];
    let adjacent = -1;
    stack.push(s);
    out[s] = count;
    while (stack.length) {
      const i = stack.pop()!;
      piece.push(i);
      const x = i % W;
      const ns = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < W * (H - 1) ? i + W : -1];
      for (const j of ns) {
        if (j < 0) continue;
        if (label[j] === label[s] && out[j] < 0) {
          out[j] = count;
          stack.push(j);
        } else if (out[j] >= 0 && out[j] !== count) adjacent = out[j];
      }
    }
    if (piece.length < small && adjacent >= 0) {
      for (const i of piece) out[i] = adjacent;
    } else count++;
  }
  return { labels: out, count };
}

/** A region: its pixels' count, mean colour and grain, middle and box (pixels). */
export type Region = {
  n: number;
  L: number;
  A: number;
  B: number;
  tex: number;
  x: number;
  y: number;
  box: [number, number, number, number];
};

type Acc = { n: number; L: number; A: number; B: number; tex: number; x: number; y: number; x0: number; y0: number; x1: number; y1: number; room: number };

/**
 * Superpixels joined into regions, cheapest join first (colour difference,
 * grain difference, and how strong the line between them is), while the
 * cheapest is under `limit`; pieces under `minPixels` then join the neighbour
 * they share most border with. `room` (if any): a region's room, never crossed.
 */
export function mergeRegions(img: Img, sp: { labels: Int32Array; count: number }, limit: number, minPixels: number, room?: Int32Array): { labels: Int32Array; regions: Region[] } {
  const { W, H } = img;
  const K = sp.count;
  const acc: Acc[] = Array.from({ length: K }, () => ({ n: 0, L: 0, A: 0, B: 0, tex: 0, x: 0, y: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, room: -1 }));
  const lab = sp.labels;
  for (let i = 0; i < W * H; i++) {
    const k = lab[i];
    if (k < 0) continue;
    const a = acc[k];
    const x = i % W, y = (i - x) / W;
    a.n++;
    a.L += img.L[i];
    a.A += img.A[i];
    a.B += img.B[i];
    a.tex += img.tex[i];
    a.x += x;
    a.y += y;
    a.x0 = Math.min(a.x0, x);
    a.y0 = Math.min(a.y0, y);
    a.x1 = Math.max(a.x1, x + 1);
    a.y1 = Math.max(a.y1, y + 1);
    if (room && room[i] >= 0) a.room = room[i];
  }
  // Borders: length and summed colour jump across.
  const border = new Map<number, { len: number; jump: number }>();
  const key = (a: number, b: number) => (a < b ? a * K + b : b * K + a);
  const addBorder = (i: number, j: number) => {
    const a = lab[i], b = lab[j];
    if (a < 0 || b < 0 || a === b) return;
    const k = key(a, b);
    const d = Math.hypot(img.L[i] - img.L[j], img.A[i] - img.A[j], img.B[i] - img.B[j]);
    const e = border.get(k);
    if (e) {
      e.len++;
      e.jump += d;
    } else border.set(k, { len: 1, jump: d });
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x < W - 1) addBorder(i, i + 1);
      if (y < H - 1) addBorder(i, i + W);
    }
  const parent = Int32Array.from({ length: K }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const nbrs: Map<number, { len: number; jump: number }>[] = Array.from({ length: K }, () => new Map());
  for (const [k, e] of border) {
    const a = Math.floor(k / K), b = k % K;
    nbrs[a].set(b, e);
    nbrs[b].set(a, { ...e });
  }
  const cost = (a: number, b: number) => {
    const p = acc[a], q = acc[b];
    if (room && p.room !== q.room) return Infinity;
    const e = nbrs[a].get(b)!;
    const dc = Math.hypot(p.L / p.n - q.L / q.n, p.A / p.n - q.A / q.n, p.B / p.n - q.B / q.n);
    const dt = Math.abs(p.tex / p.n - q.tex / q.n);
    return dc + 0.6 * dt + 0.25 * (e.jump / e.len);
  };
  // A heap of joins (stale ones skipped by their stamps).
  const heap: { c: number; a: number; b: number; sa: number; sb: number }[] = [];
  const stamp = new Int32Array(K);
  const push = (c: number, a: number, b: number) => {
    heap.push({ c, a, b, sa: stamp[a], sb: stamp[b] });
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].c <= heap[i].c) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].c < heap[m].c) m = l;
        if (r < heap.length && heap[r].c < heap[m].c) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const join = (a: number, b: number) => {
    // b into a.
    const p = acc[a], q = acc[b];
    p.n += q.n;
    p.L += q.L;
    p.A += q.A;
    p.B += q.B;
    p.tex += q.tex;
    p.x += q.x;
    p.y += q.y;
    p.x0 = Math.min(p.x0, q.x0);
    p.y0 = Math.min(p.y0, q.y0);
    p.x1 = Math.max(p.x1, q.x1);
    p.y1 = Math.max(p.y1, q.y1);
    parent[b] = a;
    nbrs[a].delete(b);
    for (const [c, e] of nbrs[b]) {
      if (c === a) continue;
      const had = nbrs[a].get(c);
      const sum = had ? { len: had.len + e.len, jump: had.jump + e.jump } : { ...e };
      nbrs[a].set(c, sum);
      nbrs[c].delete(b);
      nbrs[c].set(a, { ...sum });
    }
    nbrs[b].clear();
    stamp[a]++;
    stamp[b]++;
  };
  for (let a = 0; a < K; a++) for (const b of nbrs[a].keys()) if (a < b) push(cost(a, b), a, b);
  while (heap.length) {
    const j = pop();
    if (j.c >= limit) break;
    if (parent[j.a] !== j.a || parent[j.b] !== j.b || stamp[j.a] !== j.sa || stamp[j.b] !== j.sb) continue;
    join(j.a, j.b);
    for (const c of nbrs[j.a].keys()) push(cost(j.a, c), j.a, c);
  }
  // The small ones: into the neighbour they share most border with (in their room).
  let changed = true;
  while (changed) {
    changed = false;
    for (let a = 0; a < K; a++) {
      if (parent[a] !== a || acc[a].n >= minPixels || !acc[a].n) continue;
      let best = -1, len = 0;
      for (const [c, e] of nbrs[a]) {
        if (room && acc[c].room !== acc[a].room) continue;
        if (e.len > len) {
          len = e.len;
          best = c;
        }
      }
      if (best < 0) continue;
      join(best, a);
      changed = true;
    }
  }
  const ids = new Int32Array(K).fill(-1);
  const regions: Region[] = [];
  for (let a = 0; a < K; a++) {
    if (parent[a] !== a || !acc[a].n) continue;
    const p = acc[a];
    ids[a] = regions.length;
    regions.push({ n: p.n, L: p.L / p.n, A: p.A / p.n, B: p.B / p.n, tex: p.tex / p.n, x: p.x / p.n, y: p.y / p.n, box: [p.x0, p.y0, p.x1, p.y1] });
  }
  const labels = new Int32Array(W * H).fill(-1);
  for (let i = 0; i < W * H; i++) if (lab[i] >= 0) labels[i] = ids[find(lab[i])];
  return { labels, regions };
}

/** Each pair of regions that touch: how long their border is (pixels). */
export function bordersOf(labels: Int32Array, W: number, H: number): Map<number, number>[] {
  let count = 0;
  for (let i = 0; i < labels.length; i++) count = Math.max(count, labels[i] + 1);
  const out: Map<number, number>[] = Array.from({ length: count }, () => new Map());
  const add = (a: number, b: number) => {
    if (a < 0 || b < 0 || a === b) return;
    out[a].set(b, (out[a].get(b) ?? 0) + 1);
    out[b].set(a, (out[b].get(a) ?? 0) + 1);
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x < W - 1) add(labels[i], labels[i + 1]);
      if (y < H - 1) add(labels[i], labels[i + W]);
    }
  return out;
}
