import { Command } from "@owlbear-rodeo/sdk";
import type { PathCommand } from "@owlbear-rodeo/sdk";
import { Direction, IconPosition, IconShape } from "../engine/types";

// The stacked icons of height markers and icon-style Lecturas: one icon per
// Banda step. `direction` (up/down) decides which end of a tapered stack is
// bigger, which way a stack is nudged, and, for the feather/shovel shape,
// which art is drawn.

export type { Direction };

interface Point {
  x: number;
  y: number;
}

function normalize(v: Point): Point {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

/** Build a rounded-corner polygon as a closed path (line + quad-curve per corner) */
function roundedPolygonCommands(points: Point[], radius: number): PathCommand[] {
  const n = points.length;
  const starts: Point[] = points.map((p, i) => {
    const prev = points[(i - 1 + n) % n];
    const dir = normalize({ x: prev.x - p.x, y: prev.y - p.y });
    return { x: p.x + dir.x * radius, y: p.y + dir.y * radius };
  });
  const ends: Point[] = points.map((p, i) => {
    const next = points[(i + 1) % n];
    const dir = normalize({ x: next.x - p.x, y: next.y - p.y });
    return { x: p.x + dir.x * radius, y: p.y + dir.y * radius };
  });

  const commands: PathCommand[] = [[Command.MOVE, starts[0].x, starts[0].y]];
  for (let i = 0; i < n; i++) {
    commands.push([Command.QUAD, points[i].x, points[i].y, ends[i].x, ends[i].y]);
    const j = (i + 1) % n;
    if (j !== 0) {
      commands.push([Command.LINE, starts[j].x, starts[j].y]);
    }
  }
  commands.push([Command.CLOSE]);
  return commands;
}

function triangleVertices(
  left: number,
  top: number,
  width: number,
  height: number,
  direction: Direction
): Point[] {
  const midX = left + width / 2;
  if (direction === "up") {
    return [
      { x: midX, y: top },
      { x: left + width, y: top + height },
      { x: left, y: top + height },
    ];
  }
  return [
    { x: left, y: top },
    { x: left + width, y: top },
    { x: midX, y: top + height },
  ];
}

function rectVertices(left: number, top: number, width: number, height: number): Point[] {
  return [
    { x: left, y: top },
    { x: left + width, y: top },
    { x: left + width, y: top + height },
    { x: left, y: top + height },
  ];
}

function diamondVertices(cx: number, cy: number, size: number): Point[] {
  const r = size / 2;
  return [
    { x: cx, y: cy - r },
    { x: cx + r, y: cy },
    { x: cx, y: cy + r },
    { x: cx - r, y: cy },
  ];
}

function circleVertices(cx: number, cy: number, size: number, sides = 24): Point[] {
  const r = size / 2;
  const points: Point[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2 - Math.PI / 2;
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return points;
}

function starVertices(cx: number, cy: number, size: number, spikes = 5): Point[] {
  const outerR = size / 2;
  const innerR = outerR * 0.45;
  const points: Point[] = [];
  const step = Math.PI / spikes;
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = -Math.PI / 2 + i * step;
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return points;
}

const CORNER_RADIUS_RATIO = 0.22;

/**
 * Feather silhouette, converted from Phosphor Icons' "feather-fill" SVG
 * (github.com/phosphor-icons/core, MIT license, no attribution required) and
 * normalized to a centered -0.5..0.5 unit box. Unlike the other cell shapes
 * this is baked vector art (with curves), not something built from simple
 * polygon math.
 */
const FEATHER_COMMANDS: PathCommand[] = [
  [0, 0.3275, 0.0266], [1, 0.0939, 0.2628], [1, 0.0939, 0.2628],
  [4, 0.0824, 0.2745, 0.0666, 0.2811, 0.0502, 0.2811], [1, -0.2058, 0.2811], [1, -0.3216, 0.3971],
  [4, -0.3339, 0.4093, -0.3536, 0.4093, -0.3659, 0.3971], [4, -0.3781, 0.3849, -0.3781, 0.3651, -0.3659, 0.3529],
  [1, -0.2776, 0.2647], [1, -0.2776, 0.2647], [1, -0.0129, 0], [1, 0.3164, 0],
  [4, 0.3227, 0, 0.3284, 0.0038, 0.3308, 0.0096], [4, 0.3332, 0.0154, 0.3319, 0.0221, 0.3275, 0.0266],
  [5],
  [0, 0.3465, -0.3806], [4, 0.2471, -0.4623, 0.102, -0.4553, 0.0109, -0.3644], [1, -0.0266, -0.3274],
  [4, -0.0295, -0.3245, -0.0312, -0.3205, -0.0312, -0.3164], [1, -0.0312, -0.0703], [1, 0.1836, -0.2852],
  [4, 0.1959, -0.2968, 0.2152, -0.2966, 0.2272, -0.2846], [4, 0.2392, -0.2726, 0.2394, -0.2533, 0.2278, -0.241],
  [1, 0.0496, -0.0625], [1, 0.3949, -0.0625], [4, 0.4007, -0.0625, 0.4061, -0.0657, 0.4088, -0.0709],
  [4, 0.464, -0.1759, 0.438, -0.3052, 0.3465, -0.3806],
  [5],
  [0, -0.2546, 0.1532], [1, -0.0937, -0.0076], [1, -0.0937, -0.2236],
  [4, -0.0938, -0.2299, -0.0975, -0.2356, -0.1034, -0.238], [4, -0.1092, -0.2404, -0.1159, -0.2391, -0.1204, -0.2347],
  [1, -0.2629, -0.0937], [4, -0.2747, -0.0821, -0.2813, -0.0662, -0.2812, -0.0496], [1, -0.2812, 0.1422],
  [4, -0.2813, 0.1485, -0.2774, 0.1542, -0.2716, 0.1566], [4, -0.2658, 0.1591, -0.259, 0.1577, -0.2546, 0.1532],
  [5],
] as unknown as PathCommand[];

/** Shovel silhouette (the "down" counterpart to the feather), same source/normalization as above. */
const SHOVEL_COMMANDS: PathCommand[] = [
  [0, 0.4596, -0.2279], [4, 0.4537, -0.222, 0.4458, -0.2187, 0.4375, -0.2187],
  [4, 0.4292, -0.2187, 0.4213, -0.222, 0.4154, -0.2279], [1, 0.3438, -0.2996], [1, 0.0664, -0.0222],
  [1, 0.0221, -0.0664], [1, 0.2995, -0.3437], [1, 0.2279, -0.4154],
  [4, 0.2157, -0.4276, 0.2157, -0.4474, 0.2279, -0.4596], [4, 0.2401, -0.4718, 0.2599, -0.4718, 0.2721, -0.4596],
  [1, 0.4596, -0.2721], [4, 0.4655, -0.2662, 0.4688, -0.2583, 0.4688, -0.25],
  [4, 0.4688, -0.2417, 0.4655, -0.2338, 0.4596, -0.2279],
  [5],
  [0, -0.1562, 0.1875], [4, -0.1689, 0.1875, -0.1803, 0.1799, -0.1851, 0.1682],
  [4, -0.19, 0.1565, -0.1873, 0.1431, -0.1784, 0.1341], [1, 0.0221, -0.0664], [1, -0.1121, -0.2005],
  [4, -0.1365, -0.2249, -0.176, -0.2249, -0.2004, -0.2005], [1, -0.4192, 0.0183],
  [4, -0.431, 0.03, -0.4376, 0.0459, -0.4375, 0.0625], [1, -0.4375, 0.375],
  [4, -0.4375, 0.4095, -0.4095, 0.4375, -0.375, 0.4375], [1, -0.0625, 0.4375],
  [4, -0.0459, 0.4376, -0.03, 0.431, -0.0183, 0.4192], [1, 0.2004, 0.2004],
  [4, 0.2248, 0.176, 0.2248, 0.1365, 0.2004, 0.1121], [1, 0.0664, -0.0221], [1, -0.1341, 0.1784],
  [4, -0.14, 0.1842, -0.148, 0.1875, -0.1562, 0.1875],
  [5],
] as unknown as PathCommand[];

function transformNormalizedCommands(
  commands: PathCommand[],
  cx: number,
  cy: number,
  width: number,
  height: number
): PathCommand[] {
  const tx = (x: number) => cx + x * width;
  const ty = (y: number) => cy + y * height;
  return commands.map((cmd): PathCommand => {
    if (cmd[0] === Command.MOVE || cmd[0] === Command.LINE) {
      return [cmd[0], tx(cmd[1]), ty(cmd[2])];
    }
    if (cmd[0] === Command.CUBIC) {
      return [cmd[0], tx(cmd[1]), ty(cmd[2]), tx(cmd[3]), ty(cmd[4]), tx(cmd[5]), ty(cmd[6])];
    }
    return cmd;
  });
}

/** The visual silhouette drawn for each icon in a stack */
type CellShape = "triangle" | "bar" | "circle" | "diamond" | "square" | "star" | "wingDrill";

interface ShapeConfig {
  cell: CellShape;
  /** Whether the stack tapers in size along its length, vs. every cell the same size */
  stepped: boolean;
}

const SHAPE_CONFIG: Record<IconShape, ShapeConfig> = {
  triangle: { cell: "triangle", stepped: false },
  triangleStepped: { cell: "triangle", stepped: true },
  bar: { cell: "bar", stepped: true },
  circle: { cell: "circle", stepped: true },
  diamond: { cell: "diamond", stepped: true },
  square: { cell: "square", stepped: true },
  star: { cell: "star", stepped: true },
  wingDrill: { cell: "wingDrill", stepped: false },
};

export const ICON_SHAPES: IconShape[] = [
  "triangle",
  "triangleStepped",
  "bar",
  "circle",
  "diamond",
  "square",
  "star",
  "wingDrill",
];

const SHAPE_SIZE_RATIO: Record<CellShape, { width: number; height: number }> = {
  triangle: { width: 0.4, height: 0.34 },
  bar: { width: 0.5, height: 0.16 },
  square: { width: 0.32, height: 0.32 },
  diamond: { width: 0.38, height: 0.38 },
  circle: { width: 0.32, height: 0.32 },
  star: { width: 0.36, height: 0.36 },
  wingDrill: { width: 0.36, height: 0.36 },
};

const SHAPE_GAP_RATIO: Record<CellShape, number> = {
  triangle: 0.08,
  bar: 0.08,
  square: 0.08,
  diamond: 0.08,
  circle: 0.08,
  star: 0.08,
  wingDrill: 0.08,
};

/**
 * Outline width ratio (of dpi) for the icon's stroke. The baked feather art
 * has fine internal details, so the same stroke used on the simple polygon
 * shapes would visually thicken and muddy it.
 */
const SHAPE_STROKE_RATIO: Record<CellShape, number> = {
  triangle: 0.035,
  bar: 0.035,
  square: 0.035,
  diamond: 0.035,
  circle: 0.035,
  star: 0.035,
  wingDrill: 0.012,
};

export function getStrokeWidthRatio(shape: IconShape): number {
  return SHAPE_STROKE_RATIO[SHAPE_CONFIG[shape].cell];
}

/** How much a stepped stack's cells grow from its smallest to its biggest */
const STEPPED_MIN_SCALE = 0.5;
const STEPPED_MAX_SCALE = 1.15;

/**
 * Scale of the icon at `index` in a stack of `count`. In a vertical stack
 * (index 0 nearest the token) UP grows toward the far end, DOWN toward the
 * near end. In a horizontal stack that reads backwards, so the growth
 * direction is flipped.
 */
function taperScale(index: number, count: number, direction: Direction, horizontal: boolean): number {
  if (count <= 1) {
    return 1;
  }
  const t = index / (count - 1);
  const up = direction === "up";
  const grow = horizontal ? (up ? t : 1 - t) : up ? 1 - t : t;
  return STEPPED_MIN_SCALE + grow * (STEPPED_MAX_SCALE - STEPPED_MIN_SCALE);
}

type PolygonCellShape = Exclude<CellShape, "wingDrill">;

function cellVertices(
  cell: PolygonCellShape,
  cx: number,
  cy: number,
  width: number,
  height: number,
  direction: Direction
): Point[] {
  switch (cell) {
    case "triangle":
      return triangleVertices(cx - width / 2, cy - height / 2, width, height, direction);
    case "bar":
    case "square":
      return rectVertices(cx - width / 2, cy - height / 2, width, height);
    case "diamond":
      return diamondVertices(cx, cy, Math.min(width, height));
    case "circle":
      return circleVertices(cx, cy, Math.min(width, height));
    case "star":
      return starVertices(cx, cy, Math.min(width, height));
  }
}

function cellCornerRadius(cell: PolygonCellShape, width: number, height: number): number {
  switch (cell) {
    case "triangle":
    case "square":
      return Math.min(width, height) * CORNER_RADIUS_RATIO;
    case "bar":
      // Fully round the short ends, turning the rectangle into a capsule/pill
      return height / 2;
    case "diamond":
      return Math.min(width, height) * CORNER_RADIUS_RATIO * 0.6;
    case "circle":
    case "star":
      return 0;
  }
}

/** Builds the full path for one icon in the stack, in absolute local coordinates */
function cellCommands(
  cell: CellShape,
  cx: number,
  cy: number,
  width: number,
  height: number,
  direction: Direction
): PathCommand[] {
  if (cell === "wingDrill") {
    const normalized = direction === "up" ? FEATHER_COMMANDS : SHOVEL_COMMANDS;
    return transformNormalizedCommands(normalized, cx, cy, width, height);
  }
  return roundedPolygonCommands(
    cellVertices(cell, cx, cy, width, height, direction),
    cellCornerRadius(cell, width, height)
  );
}

/** How far a vertical stack is nudged toward its direction, as a fraction of its own length. */
export const DIRECTION_NUDGE = 0.1;

/**
 * Geometry, in local path units, of an icon stack centered at (0, 0). For
 * left/right positions the stack is a vertical column; for top/bottom it's a
 * horizontal row. Stepped shapes taper in size along the stack, growing from
 * the first icon (index 0) to the last.
 */
export function buildIconStackCommands(
  shape: IconShape,
  count: number,
  dpi: number,
  sizeScale: number,
  position: IconPosition,
  direction: Direction = "up",
  /** Nudge a vertical stack toward the way it points (see DIRECTION_NUDGE). Off for a Lectura at the Origen's own height, which points neither way. */
  nudge = true
): PathCommand[] {
  const { cell, stepped } = SHAPE_CONFIG[shape];
  const ratio = SHAPE_SIZE_RATIO[cell];
  const baseWidth = ratio.width * dpi * sizeScale;
  const baseHeight = ratio.height * dpi * sizeScale;
  const gap = SHAPE_GAP_RATIO[cell] * dpi * sizeScale;
  const horizontal = position === "top" || position === "bottom";

  const scales = Array.from({ length: count }, (_, i) =>
    stepped ? taperScale(i, count, direction, horizontal) : 1
  );
  const widths = scales.map((s) => baseWidth * s);
  const heights = scales.map((s) => baseHeight * s);
  const stackSizes = horizontal ? widths : heights;
  const totalStack = stackSizes.reduce((a, b) => a + b, 0) + gap * Math.max(0, count - 1);
  // All cells share one centerline on the cross axis (sized to the biggest
  // cell) instead of each hugging the anchor with its own size, which would
  // leave smaller cells looking pushed to one side once sizes start to vary.
  const maxWidth = Math.max(...widths);
  const maxHeight = Math.max(...heights);
  const crossCenterX = position === "left" ? -maxWidth / 2 : maxWidth / 2;
  const crossCenterY = position === "top" ? -maxHeight / 2 : maxHeight / 2;

  const commands: PathCommand[] = [];
  // A vertical stack (left/right of the token) sits a little toward the way
  // it points — higher when up, lower when down — instead of dead center
  // on the token's midline, which read oddly balanced. A horizontal stack
  // (above/below the token) stays put: shifting it would only move it
  // toward or away from the token.
  const shift = !horizontal && nudge ? (direction === "up" ? -1 : 1) * DIRECTION_NUDGE * totalStack : 0;
  let cursor = -totalStack / 2 + shift;
  for (let i = 0; i < count; i++) {
    const width = widths[i];
    const height = heights[i];
    let cx: number;
    let cy: number;
    if (horizontal) {
      cx = cursor + width / 2;
      cy = crossCenterY;
    } else {
      cy = cursor + height / 2;
      cx = crossCenterX;
    }
    commands.push(...cellCommands(cell, cx, cy, width, height, direction));
    cursor += stackSizes[i] + gap;
  }
  return commands;
}

function forEachCommandPoint(commands: PathCommand[], fn: (x: number, y: number) => void) {
  for (const cmd of commands) {
    if (cmd[0] === Command.MOVE || cmd[0] === Command.LINE) {
      fn(cmd[1], cmd[2]);
    } else if (cmd[0] === Command.QUAD) {
      fn(cmd[1], cmd[2]);
      fn(cmd[3], cmd[4]);
    } else if (cmd[0] === Command.CUBIC) {
      fn(cmd[1], cmd[2]);
      fn(cmd[3], cmd[4]);
      fn(cmd[5], cmd[6]);
    }
  }
}

/** Bounding box of an icon stack's commands, in its own local path units (anchor at 0, 0). */
export function iconStackExtent(commands: PathCommand[]) {
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  forEachCommandPoint(commands, (x, y) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  });
  return { minX, maxX, minY, maxY };
}

function translateCommands(commands: PathCommand[], dx: number, dy: number): PathCommand[] {
  return commands.map((cmd): PathCommand => {
    if (cmd[0] === Command.MOVE || cmd[0] === Command.LINE) {
      return [cmd[0], cmd[1] + dx, cmd[2] + dy];
    }
    if (cmd[0] === Command.QUAD) {
      return [cmd[0], cmd[1] + dx, cmd[2] + dy, cmd[3] + dx, cmd[4] + dy];
    }
    if (cmd[0] === Command.CUBIC) {
      return [cmd[0], cmd[1] + dx, cmd[2] + dy, cmd[3] + dx, cmd[4] + dy, cmd[5] + dx, cmd[6] + dy];
    }
    return cmd;
  });
}

function pathCommandsToSvgD(commands: PathCommand[]): string {
  let d = "";
  for (const cmd of commands) {
    switch (cmd[0]) {
      case Command.MOVE:
        d += `M ${cmd[1]} ${cmd[2]} `;
        break;
      case Command.LINE:
        d += `L ${cmd[1]} ${cmd[2]} `;
        break;
      case Command.QUAD:
        d += `Q ${cmd[1]} ${cmd[2]} ${cmd[3]} ${cmd[4]} `;
        break;
      case Command.CUBIC:
        d += `C ${cmd[1]} ${cmd[2]} ${cmd[3]} ${cmd[4]} ${cmd[5]} ${cmd[6]} `;
        break;
      case Command.CLOSE:
        d += "Z ";
        break;
    }
  }
  return d;
}

/** Small fixed-size SVG preview used inside the shape picker */
export function iconStackPreviewSvg(
  shape: IconShape,
  count: number,
  color: string,
  direction: Direction = "up"
): string {
  // Matches on-board sizing at dpi=1, sizeScale=27.5 (chosen so a plain
  // triangle preview comes out ~11x9px, the size the original art used).
  const commands = buildIconStackCommands(shape, count, 1, 27.5, "left", direction);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  forEachCommandPoint(commands, (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });
  const width = maxX - minX;
  const height = maxY - minY;
  const d = pathCommandsToSvgD(translateCommands(commands, -minX, -minY));

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="${color}" /></svg>`;
}
