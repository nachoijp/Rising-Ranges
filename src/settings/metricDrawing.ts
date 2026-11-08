import type { DistanceMetric } from "../engine/types";

// The calculation modes' diagrams (drawn by MetricDiagram.tsx): what a Banda reaches with each — a sphere, a
// cube, a cylinder — in perspective on a floor grid, the origin token in the middle and another one
// right on the solid's surface, always the same way off (a across, b along, c up), each mode's
// counted stretches in the accent. Drawn in a 120-unit box (shown larger), the text's colour.

/** The drawing's box, in its own units. */
export const DIAGRAM_SIZE = 120;
const C = DIAGRAM_SIZE / 2;
/** A Banda's reach (the floor grid's scale, and the cube's size). */
const R = 35;
/**
 * Each solid's own reach on the drawing: the rounder ones larger than the cube (its corners stick
 * out past its reach), so that all of them fill about as much of the drawing.
 */
const SIZE: Record<DistanceMetric, number> = { spherical: R * 1.3, cubic: R, cylindrical: R * 1.15, octagonal: R * 1.3 };

// An orthographic camera, turned 35° round and looking 24° down.
const YAW = (35 * Math.PI) / 180;
const PITCH = (24 * Math.PI) / 180;
/** Toward the viewer. */
const V: Vec = [Math.sin(YAW) * Math.cos(PITCH), Math.cos(YAW) * Math.cos(PITCH), Math.sin(PITCH)];

type Vec = [number, number, number];

function project([x, y, z]: Vec): [number, number] {
  const across = x * Math.cos(YAW) - y * Math.sin(YAW);
  const toward = x * Math.sin(YAW) + y * Math.cos(YAW);
  return [C + across, C + 4 - (z * Math.cos(PITCH) - toward * Math.sin(PITCH))];
}

const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const minus = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const n1 = (n: number) => n.toFixed(1);

const SOLID = 'fill="none" stroke="currentColor" stroke-width="1.1" stroke-opacity=".85" stroke-linejoin="round"';
const BACK = 'fill="none" stroke="currentColor" stroke-width=".9" stroke-opacity=".35" stroke-dasharray="2 2.5"';
const FAINT = 'fill="none" stroke="currentColor" stroke-width=".8" stroke-opacity=".2"';
const LEG = 'stroke="currentColor" stroke-width="1.1" stroke-opacity=".75" stroke-linecap="round"';
/** The octagonal mode's first step (a and ½b make s), told apart from the second (the accent, as every mode's result): its lines and letters, and the formula's. */
export const FIRST_STEP = "#4fd1c5";
const accentLine = (accent: string) => `stroke="${accent}" stroke-width="2.2" stroke-linecap="round"`;

function line(a: Vec, b: Vec, style: string) {
  const [x1, y1] = project(a);
  const [x2, y2] = project(b);
  return `<line x1="${n1(x1)}" y1="${n1(y1)}" x2="${n1(x2)}" y2="${n1(y2)}" ${style}/>`;
}
function polyline(points: Vec[], style: string) {
  return `<polyline points="${points.map((p) => project(p).map(n1).join(",")).join(" ")}" ${style}/>`;
}
/** A horizontal circle at height z, from one angle to another. */
function ring(z: number, r: number, from = 0, to = 2 * Math.PI, steps = 64): Vec[] {
  const points: Vec[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = from + ((to - from) * i) / steps;
    points.push([r * Math.cos(t), r * Math.sin(t), z]);
  }
  return points;
}
/** A horizontal circle's near half (drawn solid) and far half (dashed). */
function halves(z: number, r: number) {
  return { near: ring(z, r, -YAW, Math.PI - YAW), far: ring(z, r, Math.PI - YAW, 2 * Math.PI - YAW) };
}

function floor() {
  let svg = "";
  const edge = R * 1.3;
  const step = R / 2;
  for (let v = -edge + ((edge * 2) % step) / 2; v <= edge + 0.01; v += step) {
    svg += line([v, -edge, 0], [v, edge, 0], FAINT) + line([-edge, v, 0], [edge, v, 0], FAINT);
  }
  return svg;
}

/** Whether a face of a solid round the origin is turned to the viewer (its outward normal towards V). */
function turnedToViewer(face: Vec[]): boolean {
  const middle = face.reduce<Vec>((m, p) => [m[0] + p[0] / face.length, m[1] + p[1] / face.length, m[2] + p[2] / face.length], [0, 0, 0]);
  let normal = cross(minus(face[1], face[0]), minus(face[2], face[0]));
  if (dot(normal, middle) < 0) {
    normal = [-normal[0], -normal[1], -normal[2]];
  }
  return dot(normal, V) > 1e-9;
}

/** A seen face, filled faintly. */
const faceFill = (face: Vec[]) => `<polygon points="${face.map((p) => project(p).map(n1).join(",")).join(" ")}" fill="currentColor" fill-opacity=".06" stroke="none"/>`;

/** A convex solid from its faces: those turned to the viewer filled faintly, an edge solid if a face beside it is seen, dashed if none is. */
function solid(faces: Vec[][]) {
  let fill = "";
  let hidden = "";
  let shown = "";
  const edges = new Map<string, { a: Vec; b: Vec; seen: boolean }>();
  const key = (p: Vec) => p.map((c) => c.toFixed(2)).join(",");
  for (const face of faces) {
    const seen = turnedToViewer(face);
    if (seen) {
      fill += faceFill(face);
    }
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length];
      const k = [key(a), key(b)].sort().join("|");
      const edge = edges.get(k) ?? { a, b, seen: false };
      edge.seen ||= seen;
      edges.set(k, edge);
    });
  }
  for (const edge of edges.values()) {
    if (edge.seen) {
      shown += line(edge.a, edge.b, SOLID);
    } else {
      hidden += line(edge.a, edge.b, BACK);
    }
  }
  return fill + hidden + shown;
}

function cubeFaces(r: number): Vec[][] {
  const faces: Vec[][] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (const side of [-r, r]) {
      const u = (axis + 1) % 3;
      const w = (axis + 2) % 3;
      faces.push(
        [[-r, -r], [r, -r], [r, r], [-r, r]].map(([p, q]) => {
          const v: Vec = [0, 0, 0];
          v[axis] = side;
          v[u] = p;
          v[w] = q;
          return v;
        })
      );
    }
  }
  return faces;
}

/**
 * The octagonal mode's solid (the 5-10-5 rule's reach): on the ground an octagon (the longer leg
 * plus half the shorter = r: r along the axes, 2/3 r on the diagonals), narrowing straight to one
 * 2/3 as big at 2/3 r up, and from there to a point at r. The same below.
 */
function octagon(r: number, z: number): Vec[] {
  const k = (2 / 3) * r;
  return ([[r, 0], [k, k], [0, r], [-k, k], [-r, 0], [-k, -k], [0, -r], [k, -k]] as [number, number][]).map(([x, y]) => [x, y, z]);
}
function octagonalFaces(r: number): Vec[][] {
  const middle = octagon(r, 0);
  const up = octagon((2 / 3) * r, (2 / 3) * r);
  const down = octagon((2 / 3) * r, -(2 / 3) * r);
  const top: Vec = [0, 0, r];
  const bottom: Vec = [0, 0, -r];
  const faces: Vec[][] = [];
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8;
    faces.push([top, up[i], up[j]], [up[i], middle[i], middle[j], up[j]], [middle[i], down[i], down[j], middle[j]], [down[i], bottom, down[j]]);
  }
  return faces;
}

/**
 * A faceted solid as a gem: the faces turned to the viewer filled faintly, the edges on its outline
 * (a face seen on one side only) marked, the ones between two seen faces fainter; none behind (with
 * so many, they'd tangle).
 */
function facets(faces: Vec[][]) {
  const edges = new Map<string, { a: Vec; b: Vec; seen: number }>();
  const key = (p: Vec) => p.map((c) => c.toFixed(2)).join(",");
  let fill = "";
  for (const face of faces) {
    const seen = turnedToViewer(face);
    if (seen) {
      fill += faceFill(face);
    }
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length];
      const k = [key(a), key(b)].sort().join("|");
      const edge = edges.get(k) ?? { a, b, seen: 0 };
      edge.seen += seen ? 1 : 0;
      edges.set(k, edge);
    });
  }
  let inner = "";
  let rim = "";
  for (const edge of edges.values()) {
    if (edge.seen === 2) {
      inner += line(edge.a, edge.b, 'stroke="currentColor" stroke-width=".8" stroke-opacity=".4"');
    } else if (edge.seen === 1) {
      rim += line(edge.a, edge.b, SOLID);
    }
  }
  return fill + inner + rim;
}

function volume(metric: DistanceMetric) {
  const r = SIZE[metric];
  if (metric === "spherical") {
    const [cx, cy] = project([0, 0, 0]);
    const equator = halves(0, r);
    return (
      `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${r}" fill="currentColor" fill-opacity=".06" ${SOLID}/>` +
      polyline(equator.far, BACK) +
      polyline(equator.near, SOLID)
    );
  }
  if (metric === "cubic") {
    return solid(cubeFaces(r));
  }
  if (metric === "octagonal") {
    return facets(octagonalFaces(r));
  }
  const bottom = halves(-r, r);
  let svg = polyline(bottom.far, BACK) + polyline(bottom.near, SOLID) + polyline(ring(r, r), SOLID);
  // Its sides: where the circles are widest on the drawing.
  for (const t of [-YAW, Math.PI - YAW]) {
    const x = r * Math.cos(t);
    const y = r * Math.sin(t);
    svg += line([x, y, -r], [x, y, r], SOLID);
  }
  return svg;
}

/** The other token's way off: a across, b along, c up, in these proportions. */
const WAY: Vec = [1, -0.7, 0.75];
const REACH: Record<DistanceMetric, (v: Vec) => number> = {
  spherical: ([a, b, c]) => Math.hypot(a, b, c),
  cubic: ([a, b, c]) => Math.max(Math.abs(a), Math.abs(b), Math.abs(c)),
  cylindrical: ([a, b, c]) => Math.max(Math.hypot(a, b), Math.abs(c)),
  octagonal: ([a, b, c]) => {
    const ground = Math.max(Math.abs(a), Math.abs(b)) + Math.min(Math.abs(a), Math.abs(b)) / 2;
    return Math.max(ground, Math.abs(c)) + Math.min(ground, Math.abs(c)) / 2;
  },
};

/**
 * A letter by a stretch (`along` it), set off to the side away from `from` (or toward it, `inward`;
 * or, `from` null, below it on the drawing), with a halo of the background.
 */
function label(a: Vec, b: Vec, text: string, color: string, halo: string, from: Vec | null, along: number, inward: boolean) {
  const [x1, y1] = project(a);
  const [x2, y2] = project(b);
  const mx = x1 + (x2 - x1) * along;
  const my = y1 + (y2 - y1) * along;
  let nx = -(y2 - y1);
  let ny = x2 - x1;
  const length = Math.hypot(nx, ny) || 1;
  nx /= length;
  ny /= length;
  const toward = from ? (mx - project(from)[0]) * nx + (my - project(from)[1]) * ny < 0 !== inward : ny < 0;
  if (toward) {
    nx = -nx;
    ny = -ny;
  }
  // Farther off the longer its text ("½b"), so it doesn't cover the line.
  const away = 10 + (text.length - 1) * 3.5;
  return (
    `<text x="${n1(mx + nx * away)}" y="${n1(my + ny * away + 3.5)}" font-size="10" font-style="italic" font-weight="${color === "currentColor" ? 500 : 700}"` +
    ` fill="${color}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif"` +
    ` paint-order="stroke" stroke="${halo}" stroke-width="4" stroke-linejoin="round">${text}</text>`
  );
}

function point(p: Vec, r = 2.8) {
  const [x, y] = project(p);
  return `<circle cx="${n1(x)}" cy="${n1(y)}" r="${r}" fill="currentColor"/>`;
}

/**
 * The other token on the solid's surface, its stretches, and what the mode counts. Octagonal in its
 * two steps: a and ½b make s (the ground, `groundLetter`) in FIRST_STEP, then s and ½c in the accent.
 */
function example(metric: DistanceMetric, accent: string, halo: string, groundLetter: string) {
  const k = SIZE[metric] / REACH[metric](WAY);
  const [a, b, c] = WAY.map((d) => d * k);
  const origin: Vec = [0, 0, 0];
  const across: Vec = [a, 0, 0];
  const ground: Vec = [a, b, 0];
  const token: Vec = [a, b, c];
  const middle: Vec = [a / 2, b / 2, c / 2];
  const lit = accentLine(accent);
  const first = accentLine(FIRST_STEP);
  // Each stretch's style and its letter's colour (the text's, where it doesn't count); and the straight
  // line the mode measures, if any. (Octagonal: a whole and half of b, then half of c; the token's way
  // off has a the longest, and s longer than c.)
  const legs: [string, string][] =
    metric === "cubic"
      ? [[lit, accent], [LEG, "currentColor"], [LEG, "currentColor"]]
      : metric === "octagonal"
        ? [[first, FIRST_STEP], [first, FIRST_STEP], [lit, accent]]
        : [[LEG, "currentColor"], [LEG, "currentColor"], [LEG, "currentColor"]];
  const names = metric === "octagonal" ? ["a", "½b", "½c"] : ["a", "b", "c"];
  const straight =
    metric === "spherical"
      ? line(origin, token, lit)
      : metric === "cylindrical"
        ? line(origin, ground, lit)
        : metric === "octagonal"
          ? line(origin, ground, lit) + label(origin, ground, groundLetter, accent, halo, across, 0.55, false)
          : "";
  const stretches: [Vec, Vec][] = [[origin, across], [across, ground], [ground, token]];
  let svg = "";
  stretches.forEach(([from, to], i) => (svg += line(from, to, legs[i][0])));
  svg += straight;
  // a toward its start, under it; b toward its end, below it (down and to the right: on the inner
  // side it got mixed up with the measured line, and with c); c in its middle, outside (its halo
  // cuts the outline it may cross).
  const along = [0.38, 0.62, 0.5];
  names.forEach((name, i) => {
    const [from, to] = stretches[i];
    svg += label(from, to, name, legs[i][1], halo, i === 1 ? null : middle, along[i], false);
  });
  return svg + point(ground, 1.3) + point(token) + point(origin);
}

/**
 * A mode's diagram, as SVG markup (inside a DIAGRAM_SIZE box). `halo`: the background it's drawn on;
 * `groundLetter`: the octagonal mode's ground distance (s), in the language shown.
 */
export function metricDiagram(metric: DistanceMetric, accent: string, halo: string, groundLetter: string): string {
  return floor() + volume(metric) + example(metric, accent, halo, groundLetter);
}
