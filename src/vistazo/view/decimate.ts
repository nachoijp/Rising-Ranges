import { Earcut } from "three/src/extras/Earcut.js";

// A surface cut small (see FineSurfaces), its corners at their heights, drawn with as few triangles as
// it takes to stay within a height of them: what's flat or evenly sloped (most painted ground) a few
// big triangles, the small ones only where the heights bend. Greedy insertion (Garland & Heckbert's,
// for terrain): the outline's corners triangulated, then the corner farthest from the triangles over it
// added, again and again (each added one flips its neighbours' edges while they aren't Delaunay), till
// none is farther than the tolerance. The outline's corners are all kept (its neighbours' edges, and
// the walls along it, meet them where they are), and the ones asked for.

/** Corners (x y z each), triangles; `tolerance`: how far (z) any corner may be from the result; `keep`: corners it must have. Null if it can't be done (an outline that touches itself at a corner): the surface as it is, then. */
export function decimate(position: ArrayLike<number>, index: ArrayLike<number>, tolerance: number, keep?: (corner: number) => boolean): { position: Float32Array; index: Uint32Array } | null {
  const nv = position.length / 3;
  const nt = index.length / 3;
  if (nt === 0) {
    return null;
  }
  const X = (i: number) => position[i * 3];
  const Y = (i: number) => position[i * 3 + 1];
  const Z = (i: number) => position[i * 3 + 2];
  const orient = (a: number, b: number, c: number) => (X(b) - X(a)) * (Y(c) - Y(a)) - (Y(b) - Y(a)) * (X(c) - X(a));

  // Which way its triangles turn (kept so in the result: faces culled as before).
  let turn = 0;
  for (let t = 0; t < nt; t++) {
    turn += orient(index[t * 3], index[t * 3 + 1], index[t * 3 + 2]);
  }
  const sign = turn >= 0 ? 1 : -1;

  // The outline: the edges one triangle has (no triangle the other way round), chained into loops.
  // Each corner's edges out of it, in one array (a corner's from start[v] to start[v + 1]).
  const start = new Int32Array(nv + 1);
  for (let i = 0; i < index.length; i++) {
    start[index[i] + 1]++;
  }
  for (let v = 0; v < nv; v++) {
    start[v + 1] += start[v];
  }
  const fill = start.slice(0, nv);
  const to = new Int32Array(index.length);
  for (let t = 0; t < nt; t++) {
    for (let j = 0; j < 3; j++) {
      const a = index[t * 3 + j];
      to[fill[a]++] = index[t * 3 + ((j + 1) % 3)];
    }
  }
  const next = new Int32Array(nv).fill(-1);
  for (let a = 0; a < nv; a++) {
    for (let e = start[a]; e < start[a + 1]; e++) {
      const b = to[e];
      let back = false;
      for (let f = start[b]; f < start[b + 1] && !back; f++) {
        back = to[f] === a;
      }
      if (!back) {
        if (next[a] >= 0) {
          return null;
        }
        next[a] = b;
      }
    }
  }
  const loops: number[][] = [];
  const looped = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) {
    if (next[v] < 0 || looped[v]) {
      continue;
    }
    const loop: number[] = [];
    for (let w = v; !looped[w]; w = next[w]) {
      if (next[w] < 0) {
        return null;
      }
      looped[w] = 1;
      loop.push(w);
    }
    if (loop.length >= 3) {
      loops.push(loop);
    }
  }
  const area = (loop: number[]) => {
    let s = 0;
    for (let i = 0; i < loop.length; i++) {
      const [a, b] = [loop[i], loop[(i + 1) % loop.length]];
      s += X(a) * Y(b) - X(b) * Y(a);
    }
    return s / 2;
  };
  const inLoop = (x: number, y: number, loop: number[]) => {
    let inside = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [xi, yi, xj, yj] = [X(loop[i]), Y(loop[i]), X(loop[j]), Y(loop[j])];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  };
  const outers = loops.filter((loop) => area(loop) * sign > 0);
  const holes = loops.filter((loop) => area(loop) * sign < 0);
  const holesOf = outers.map(() => [] as number[][]);
  for (const hole of holes) {
    // Into the smallest outline round it.
    let best = -1;
    for (let o = 0; o < outers.length; o++) {
      if (inLoop(X(hole[0]), Y(hole[0]), outers[o]) && (best < 0 || Math.abs(area(outers[o])) < Math.abs(area(outers[best])))) {
        best = o;
      }
    }
    if (best < 0) {
      return null;
    }
    holesOf[best].push(hole);
  }

  // The triangles: corners (counter-clockwise), the triangle across each edge (j: from corner j to j+1; -1 none).
  const cap = 2 * nv + 8;
  const tv = new Int32Array(cap * 3);
  const tn = new Int32Array(cap * 3).fill(-1);
  let count = 0;
  const used = new Uint8Array(nv);
  const pairs = new Map<number, number>();
  for (let o = 0; o < outers.length; o++) {
    const rings = [outers[o], ...holesOf[o]];
    const ids = rings.flat();
    const flat: number[] = [];
    const starts: number[] = [];
    for (const ring of rings) {
      if (flat.length > 0) {
        starts.push(flat.length / 2);
      }
      for (const v of ring) {
        flat.push(X(v), Y(v));
      }
    }
    const cut = Earcut.triangulate(flat, starts);
    for (let i = 0; i + 2 < cut.length; i += 3) {
      let [a, b, c] = [ids[cut[i]], ids[cut[i + 1]], ids[cut[i + 2]]];
      const o2 = orient(a, b, c);
      if (o2 === 0) {
        continue;
      }
      if (o2 < 0) {
        [b, c] = [c, b];
      }
      const t = count++;
      tv.set([a, b, c], t * 3);
      for (const v of [a, b, c]) {
        used[v] = 1;
      }
      for (let j = 0; j < 3; j++) {
        const [p, q] = [tv[t * 3 + j], tv[t * 3 + ((j + 1) % 3)]];
        const other = pairs.get(q * nv + p);
        if (other !== undefined) {
          const n = Math.floor(other / 3);
          tn[t * 3 + j] = n;
          tn[other] = t;
          pairs.delete(q * nv + p);
        } else {
          pairs.set(p * nv + q, t * 3 + j);
        }
      }
    }
  }
  if (count === 0) {
    return null;
  }

  // Each corner not in them yet lies in one triangle (a list per triangle).
  const head = new Int32Array(cap).fill(-1);
  const after = new Int32Array(nv).fill(-1);
  const must = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) {
    if (!used[v] && (looped[v] || keep?.(v))) {
      must[v] = 1;
    }
  }
  // Where a point is in a triangle: the least of its three weights (≥ 0 inside, negative outside).
  const weight = (t: number, v: number) => {
    const [a, b, c] = [tv[t * 3], tv[t * 3 + 1], tv[t * 3 + 2]];
    const d = orient(a, b, c);
    const x = X(v);
    const y = Y(v);
    const wa = ((X(b) - x) * (Y(c) - y) - (Y(b) - y) * (X(c) - x)) / d;
    const wb = ((X(c) - x) * (Y(a) - y) - (Y(c) - y) * (X(a) - x)) / d;
    return Math.min(wa, wb, 1 - wa - wb);
  };
  // Each triangle's farthest corner and how far (corners that must be in: first, at any distance).
  const far = new Int32Array(cap).fill(-1);
  const farBy = new Float64Array(cap);
  const stamp = new Int32Array(cap);
  // A heap of [distance, triangle, stamp]: a triangle's entry stale once its stamp moved on.
  const heap: number[] = [];
  const push = (d: number, t: number, s: number) => {
    let i = heap.length / 3;
    heap.push(d, t, s);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p * 3] >= heap[i * 3]) {
        break;
      }
      for (let k = 0; k < 3; k++) {
        [heap[p * 3 + k], heap[i * 3 + k]] = [heap[i * 3 + k], heap[p * 3 + k]];
      }
      i = p;
    }
  };
  const pop = (): [number, number, number] => {
    const top: [number, number, number] = [heap[0], heap[1], heap[2]];
    const last = heap.splice(heap.length - 3, 3);
    if (heap.length > 0) {
      heap[0] = last[0];
      heap[1] = last[1];
      heap[2] = last[2];
      const n = heap.length / 3;
      for (let i = 0; ;) {
        const [l, r] = [i * 2 + 1, i * 2 + 2];
        let m = i;
        if (l < n && heap[l * 3] > heap[m * 3]) m = l;
        if (r < n && heap[r * 3] > heap[m * 3]) m = r;
        if (m === i) break;
        for (let k = 0; k < 3; k++) {
          [heap[m * 3 + k], heap[i * 3 + k]] = [heap[i * 3 + k], heap[m * 3 + k]];
        }
        i = m;
      }
    }
    return top;
  };
  const measure = (t: number) => {
    stamp[t]++;
    far[t] = -1;
    farBy[t] = -1;
    const [a, b, c] = [tv[t * 3], tv[t * 3 + 1], tv[t * 3 + 2]];
    // The triangle's plane: z = pa + px·(x − xa) + py·(y − ya).
    const d = orient(a, b, c);
    const [ux, uy, uz, vx, vy, vz] = [X(b) - X(a), Y(b) - Y(a), Z(b) - Z(a), X(c) - X(a), Y(c) - Y(a), Z(c) - Z(a)];
    const px = (uz * vy - vz * uy) / d;
    const py = (vz * ux - uz * vx) / d;
    for (let v = head[t]; v >= 0; v = after[v]) {
      const by = must[v] ? Infinity : Math.abs(Z(v) - (Z(a) + px * (X(v) - X(a)) + py * (Y(v) - Y(a))));
      if (by > farBy[t]) {
        [far[t], farBy[t]] = [v, by];
      }
    }
    if (far[t] >= 0) {
      push(farBy[t], t, stamp[t]);
    }
  };

  const across = (n: number, old: number, now: number) => {
    if (n < 0) return;
    for (let j = 0; j < 3; j++) {
      if (tn[n * 3 + j] === old) {
        tn[n * 3 + j] = now;
        return;
      }
    }
  };
  // The corners of two triangles (one way to the left of the line a→b, the other to the right): shared
  // out again by which side they're on (they cover the same ground as before).
  const byLine = (from1: number, from2: number, a: number, b: number, left: number, right: number, skip: number) => {
    let v = head[from1];
    let w = from2 >= 0 ? head[from2] : -1;
    head[left] = -1;
    head[right] = -1;
    const [ax, ay, dx, dy] = [X(a), Y(a), X(b) - X(a), Y(b) - Y(a)];
    for (let pass = 0; pass < 2; pass++, v = w) {
      while (v >= 0) {
        const nextV = after[v];
        if (v !== skip) {
          const to = dx * (Y(v) - ay) - dy * (X(v) - ax) > 0 ? left : right;
          after[v] = head[to];
          head[to] = v;
        }
        v = nextV;
      }
    }
  };
  // Rotated so that corner `v` is first: [corners, neighbours] from it.
  const from = (t: number, v: number): [number, number, number, number, number, number] => {
    const j = tv[t * 3] === v ? 0 : tv[t * 3 + 1] === v ? 1 : 2;
    const [j1, j2] = [(j + 1) % 3, (j + 2) % 3];
    return [tv[t * 3 + j], tv[t * 3 + j1], tv[t * 3 + j2], tn[t * 3 + j], tn[t * 3 + j1], tn[t * 3 + j2]];
  };
  const set = (t: number, a: number, b: number, c: number, nab: number, nbc: number, nca: number) => {
    tv[t * 3] = a;
    tv[t * 3 + 1] = b;
    tv[t * 3 + 2] = c;
    tn[t * 3] = nab;
    tn[t * 3 + 1] = nbc;
    tn[t * 3 + 2] = nca;
  };
  const inCircle = (a: number, b: number, c: number, d: number) => {
    const [ax, ay, bx, by, cx, cy] = [X(a) - X(d), Y(a) - Y(d), X(b) - X(d), Y(b) - Y(d), X(c) - X(d), Y(c) - Y(d)];
    const [la, lb, lc] = [ax * ax + ay * ay, bx * bx + by * by, cx * cx + cy * cy];
    const terms = [la * (bx * cy - cx * by), -lb * (ax * cy - cx * ay), lc * (ax * by - bx * ay)];
    const size = Math.abs(terms[0]) + Math.abs(terms[1]) + Math.abs(terms[2]);
    return terms[0] + terms[1] + terms[2] > 1e-9 * size;
  };
  const touched = new Set<number>();
  // The edge across from corner p of triangle t flipped while the far corner's in its circle.
  const legalize = (t0: number, p: number) => {
    const stack = [t0];
    let guard = 0;
    while (stack.length > 0 && guard++ < 100000) {
      const t = stack.pop()!;
      if (tv[t * 3] !== p && tv[t * 3 + 1] !== p && tv[t * 3 + 2] !== p) continue;
      const [, x, y, a, nxy, b] = from(t, p);
      const n = nxy;
      if (n < 0) continue;
      const [, , d, , c, dd] = from(n, y);
      // n from y: (y, x, d), neighbours (y-x: t, x-d: c, d-y: dd).
      if (!inCircle(p, x, y, d) || orient(p, d, x) * orient(p, d, y) >= 0) continue;
      set(t, p, x, d, a, c, n);
      set(n, p, d, y, t, dd, b);
      across(c, n, t);
      across(b, t, n);
      byLine(t, n, p, d, n, t, -1);
      touched.add(t);
      touched.add(n);
      stack.push(t, n);
    }
  };
  const insert = (t: number, v: number) => {
    const [a, b, c] = [tv[t * 3], tv[t * 3 + 1], tv[t * 3 + 2]];
    const d = orient(a, b, c);
    const wa = ((X(b) - X(v)) * (Y(c) - Y(v)) - (Y(b) - Y(v)) * (X(c) - X(v))) / d;
    const wb = ((X(c) - X(v)) * (Y(a) - Y(v)) - (Y(c) - Y(v)) * (X(a) - X(v))) / d;
    const w = [wa, wb, 1 - wa - wb];
    const least = w.indexOf(Math.min(...w));
    used[v] = 1;
    if (w[least] > 1e-9) {
      // Inside: three triangles.
      const [, , , nab, nbc, nca] = from(t, a);
      const [t2, t3] = [count++, count++];
      set(t, a, b, v, nab, t2, t3);
      set(t2, b, c, v, nbc, t3, t);
      set(t3, c, a, v, nca, t, t2);
      across(nbc, t, t2);
      across(nca, t, t3);
      // Round v: (a, b, v) between its rays to a and b, (b, c, v) between b and c, (c, a, v) the rest.
      {
        let s0 = head[t];
        head[t] = -1;
        const [vx, vy] = [X(v), Y(v)];
        const side = (q: number, r: number) => (X(q) - vx) * (Y(r) - vy) - (Y(q) - vy) * (X(r) - vx);
        while (s0 >= 0) {
          const nextS = after[s0];
          if (s0 !== v) {
            const oa = side(a, s0);
            const ob = side(b, s0);
            const to = oa >= 0 && ob < 0 ? t : ob >= 0 && side(c, s0) < 0 ? t2 : t3;
            after[s0] = head[to];
            head[to] = s0;
          }
          s0 = nextS;
        }
      }
      [t, t2, t3].forEach((k) => touched.add(k));
      [t, t2, t3].forEach((k) => legalize(k, v));
      return;
    }
    // On the edge across from that corner: it and the triangle beyond split in two each.
    const opp = [a, b, c][least];
    // t = (o, e0, e1): split at v on e0-e1 into (o, e0, v) and (o, v, e1).
    const [o, e0, e1, nOE0, u, nE1O] = from(t, opp);
    const t2 = count++;
    let u2 = -1;
    if (u >= 0) {
      u2 = count++;
    }
    set(t, o, e0, v, nOE0, u >= 0 ? u2 : -1, t2);
    set(t2, o, v, e1, t, u >= 0 ? u : -1, nE1O);
    across(nE1O, t, t2);
    const group = [t, t2];
    if (u >= 0) {
      // u = (e1, e0, f) from e1: neighbours (e1-e0: t, e0-f, f-e1).
      const [, , f, , nE0F, nFE1] = from(u, e1);
      set(u, e1, v, f, t2, u2, nFE1);
      set(u2, v, e0, f, t, nE0F, u);
      across(nE0F, u, u2);
      group.push(u, u2);
    }
    // (o, v, e1) left of o→v; (v, e0, f) left of f→v.
    byLine(t, -1, o, v, t2, t, v);
    if (u >= 0) {
      const f = tv[u * 3 + 2];
      byLine(u, -1, f, v, u2, u, v);
    }
    group.forEach((k) => touched.add(k));
    group.forEach((k) => legalize(k, v));
  };

  // The outline's triangles made Delaunay first (earcut's are long and thin), the corners put in them
  // then (not shared out again at every flip), then each measured.
  for (let t = 0, n = count; t < n; t++) {
    for (let j = 0; j < 3; j++) {
      legalize(t, tv[t * 3 + j]);
    }
  }
  const locateAll = (): boolean => {
    // A grid of the triangles' boxes (made when first wanted).
    let bins: number[][] | null = null;
    let cellOf = (_x: number, _y: number) => 0;
    const makeGrid = () => {
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let v = 0; v < nv; v++) {
        [x0, y0, x1, y1] = [Math.min(x0, X(v)), Math.min(y0, Y(v)), Math.max(x1, X(v)), Math.max(y1, Y(v))];
      }
      const side = Math.max(1, Math.ceil(Math.sqrt(count)));
      const cw = (x1 - x0) / side || 1;
      const ch = (y1 - y0) / side || 1;
      cellOf = (x: number, y: number) => Math.min(side - 1, Math.floor((y - y0) / ch)) * side + Math.min(side - 1, Math.floor((x - x0) / cw));
      bins = Array.from({ length: side * side }, () => []);
      for (let t = 0; t < count; t++) {
        const [a, b, c] = [tv[t * 3], tv[t * 3 + 1], tv[t * 3 + 2]];
        const [i0, i1] = [Math.min(side - 1, Math.floor((Math.min(X(a), X(b), X(c)) - x0) / cw)), Math.min(side - 1, Math.floor((Math.max(X(a), X(b), X(c)) - x0) / cw))];
        const [j0, j1] = [Math.min(side - 1, Math.floor((Math.min(Y(a), Y(b), Y(c)) - y0) / ch)), Math.min(side - 1, Math.floor((Math.max(Y(a), Y(b), Y(c)) - y0) / ch))];
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            bins[j * side + i].push(t);
          }
        }
      }
    };
    // Walked to from the last one found (the corners come near each other's), across the edge the point
    // is beyond; from the grid when that runs into the outline or round in circles.
    let last = 0;
    for (let v = 0; v < nv; v++) {
      if (used[v]) {
        continue;
      }
      let t = last;
      for (let steps = 0; t >= 0 && steps < 64; steps++) {
        const [a, b, c] = [tv[t * 3], tv[t * 3 + 1], tv[t * 3 + 2]];
        if (orient(a, b, v) < 0) {
          t = tn[t * 3];
        } else if (orient(b, c, v) < 0) {
          t = tn[t * 3 + 1];
        } else if (orient(c, a, v) < 0) {
          t = tn[t * 3 + 2];
        } else {
          break;
        }
        if (steps === 63) {
          t = -1;
        }
      }
      if (t >= 0) {
        after[v] = head[t];
        head[t] = v;
        last = t;
        continue;
      }
      let best = -1;
      let score = -Infinity;
      if (!bins) {
        makeGrid();
      }
      for (const t of bins![cellOf(X(v), Y(v))]) {
        const w = weight(t, v);
        if (w > score) {
          [best, score] = [t, w];
        }
      }
      if (best < 0 || score < -1e-6) {
        // Not inside the outline's triangles: the surface isn't what it seemed.
        return false;
      }
      after[v] = head[best];
      head[best] = v;
      last = best;
    }
    return true;
  };

  if (!locateAll()) {
    return null;
  }
  for (let t = 0; t < count; t++) {
    measure(t);
  }
  while (heap.length > 0) {
    const [d, t, s] = pop();
    if (s !== stamp[t] || far[t] < 0) {
      continue;
    }
    if (d <= tolerance) {
      break;
    }
    if (count + 2 > cap) {
      return null;
    }
    touched.clear();
    insert(t, far[t]);
    for (const k of touched) {
      measure(k);
    }
  }

  // The corners used, renumbered; the triangles turned as they came.
  const map = new Int32Array(nv).fill(-1);
  const corners: number[] = [];
  const out = new Uint32Array(count * 3);
  for (let t = 0; t < count; t++) {
    for (let j = 0; j < 3; j++) {
      const v = tv[t * 3 + (sign > 0 ? j : (3 - j) % 3)];
      if (map[v] < 0) {
        map[v] = corners.length / 3;
        corners.push(X(v), Y(v), Z(v));
      }
      out[t * 3 + j] = map[v];
    }
  }
  return { position: Float32Array.from(corners), index: out };
}
