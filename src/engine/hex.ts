import type { GridType } from "@owlbear-rodeo/sdk";
import type { BandSet, BandShape } from "./types";

// Measuring hex by hex. Owlbear's hex grids (measured live): neighbouring
// cells' centers are one `dpi` apart; on HEX_HORIZONTAL they're straight
// above and below and at ±30° (flat-topped cells), on HEX_VERTICAL straight
// left and right and at ±60° (pointy-topped). Owlbear counts one step per
// neighbour.
//
// A BandSet's "hex" shape is stored as such and only means something on a
// hex grid: where a Medición starts it's resolved to the grid's own
// orientation (hexHorizontal / hexVertical), or to a circle on any other grid
// (see shapeOnGrid). Everything downstream then just reads bandSet.shape.

/**
 * The directions (degrees) a ring of equal hex distance has its flat sides
 * facing: halfway between the neighbours, whose directions its corners point
 * to (see hexSteps).
 */
const SIDE_ANGLES: Record<"hexHorizontal" | "hexVertical", number[]> = {
  hexHorizontal: [0, 60, 120],
  hexVertical: [30, 90, 150],
};

const COS_30 = Math.cos(Math.PI / 6);

export function isHexShape(shape: BandShape): shape is "hexHorizontal" | "hexVertical" {
  return shape === "hexHorizontal" || shape === "hexVertical";
}

/** The shape to draw and measure with on this grid. */
export function shapeOnGrid(shape: BandShape, type: GridType): BandShape {
  if (shape !== "hex") {
    return shape;
  }
  if (type === "HEX_HORIZONTAL") {
    return "hexHorizontal";
  }
  if (type === "HEX_VERTICAL") {
    return "hexVertical";
  }
  return "circle";
}

/** The BandSet as it's drawn and measured on this grid. */
export function onGrid(bandSet: BandSet, type: GridType): BandSet {
  const shape = shapeOnGrid(bandSet.shape, type);
  return shape === bandSet.shape ? bandSet : { ...bandSet, shape };
}

/**
 * How many hex steps away an offset (in cells) is, continuously: exactly
 * the step count at cell centers, and a hexagon around the origin for every
 * distance in between, its corners toward the neighbours.
 */
export function hexSteps(dx: number, dy: number, shape: "hexHorizontal" | "hexVertical"): number {
  let most = 0;
  for (const angle of SIDE_ANGLES[shape]) {
    const radians = (angle * Math.PI) / 180;
    most = Math.max(most, Math.abs(dx * Math.cos(radians) + dy * Math.sin(radians)));
  }
  return most / COS_30;
}

/**
 * The ground offset to measure: with a hex shape, its hex steps as one
 * straight distance (so the metric then combines it with height as it
 * would any ground distance); otherwise unchanged.
 */
export function groundOffset(dx: number, dy: number, shape: BandShape, cells?: Point[]): { x: number; y: number } {
  return isHexShape(shape) ? { x: stepsFrom(dx, dy, shape, cells), y: 0 } : { x: dx, y: dy };
}

/**
 * Hex steps from an Origen made of `cells` (offsets in cells from it: its
 * own cell, or the three around a corner — see originCellsAt): to the
 * nearest of them. From a corner its three cells are already one step
 * away: 5 ft from a corner is just those three.
 */
export function stepsFrom(dx: number, dy: number, shape: "hexHorizontal" | "hexVertical", cells: Point[] = CENTER): number {
  const nearest = Math.min(...cells.map((cell) => hexSteps(dx - cell.x, dy - cell.y, shape)));
  return cells.length > 1 ? nearest + 1 : nearest;
}

type HexShape = "hexHorizontal" | "hexVertical";
type Point = { x: number; y: number };

/** Two neighbours' directions 60° apart, in cells: the axial axes (q, r). */
const AXES: Record<HexShape, [Point, Point]> = {
  hexHorizontal: [{ x: 0, y: 1 }, { x: COS_30, y: 0.5 }],
  hexVertical: [{ x: 1, y: 0 }, { x: 0.5, y: COS_30 }],
};
/** An Origen at a cell's center: that cell alone. */
const CENTER: Point[] = [{ x: 0, y: 0 }];
/** A free point this close to a corner (in cells) measures from the corner: small, but easy enough to hit. */
const CORNER_PICK = 0.2;
/** A whole cell's corners are this far from its center, in cells: half a cell to its sides. */
const CIRCUMRADIUS = 0.5 / COS_30;
/** The six neighbours, axial. */
const NEIGHBOURS: [number, number][] = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];

const cellAt = (q: number, r: number, shape: HexShape): Point => {
  const [a, b] = AXES[shape];
  return { x: q * a.x + r * b.x, y: q * a.y + r * b.y };
};

/** The center of the cell an offset (in cells, from a cell's center) falls in. */
export function nearestCell(dx: number, dy: number, shape: HexShape): Point {
  const r = shape === "hexHorizontal" ? dx / COS_30 : dy / COS_30;
  const q = shape === "hexHorizontal" ? dy - 0.5 * r : dx - 0.5 * r;
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) {
    rq = -rr - rs;
  } else if (dr > ds) {
    rr = -rq - rs;
  }
  return cellAt(rq, rr, shape);
}

/**
 * One cell's corners, its sides `apothem` from its center (half a cell for a
 * whole one): a flat top on hexHorizontal, a point on hexVertical.
 */
export function cellCorners(apothem: number, shape: HexShape): Point[] {
  const first = shape === "hexHorizontal" ? 0 : 30;
  const circumradius = apothem / COS_30;
  return [0, 1, 2, 3, 4, 5].map((i) => {
    const radians = ((first + 60 * i) * Math.PI) / 180;
    return { x: circumradius * Math.cos(radians), y: circumradius * Math.sin(radians) };
  });
}

/**
 * The outline of every cell within `steps` of a cell, in cells from its
 * center: a hexagon with sides stepped along the cells' own edges.
 */
export function cellsOutline(steps: number, shape: HexShape, cells: Point[] = CENTER): Point[] {
  // Rounded, and -0 made 0: an edge's end must find the next edge's start.
  const coord = (v: number) => (Math.abs(v) < 5e-7 ? 0 : v).toFixed(6);
  const key = (p: Point) => `${coord(p.x)},${coord(p.y)}`;
  /** Each outline edge, keyed by where it starts: they chain into one loop. */
  const next = new Map<string, Point>();
  let start: Point | null = null;
  // Cells counted from the first of the Origen's: all of them are on its lattice.
  const base = cells[0];
  const within = (q: number, r: number) => {
    const at = cellAt(q, r, shape);
    return stepsFrom(base.x + at.x, base.y + at.y, shape, cells) <= steps + 1e-6;
  };
  const reach = steps + 2;
  for (let q = -reach; q <= reach; q++) {
    for (let r = -reach; r <= reach; r++) {
      if (!within(q, r)) {
        continue;
      }
      const at = cellAt(q, r, shape);
      const center = { x: base.x + at.x, y: base.y + at.y };
      for (const [nq, nr] of NEIGHBOURS) {
        if (within(q + nq, r + nr)) {
          continue;
        }
        // The edge facing that neighbour: between the two corners either side of its direction.
        const toward = cellAt(nq, nr, shape);
        const angle = Math.atan2(toward.y, toward.x);
        const ends = [angle - Math.PI / 6, angle + Math.PI / 6].map((a) => ({
          x: center.x + CIRCUMRADIUS * Math.cos(a),
          y: center.y + CIRCUMRADIUS * Math.sin(a),
        }));
        next.set(key(ends[0]), ends[1]);
        start ??= ends[0];
      }
    }
  }
  const outline: Point[] = [];
  for (let at = start; at && outline.length <= next.size; at = next.get(key(at)) ?? null) {
    if (outline.length > 0 && key(at) === key(outline[0])) {
      break;
    }
    outline.push(at);
  }
  return outline;
}

/** How many whole steps of cells a ring of `radius` px takes (see cellsOutline): the cells whose centers it reaches. */
export function ringSteps(radius: number, dpi: number): number {
  return Math.max(0, Math.floor(radius / dpi + 1e-6));
}

/** The corner of the cell at `cell` nearest to the offset `d` from its center, and the three cells around it (offsets from the corner). */
function nearestCorner(d: Point, shape: HexShape): { corner: Point; cells: Point[] } {
  const first = shape === "hexHorizontal" ? 0 : 30;
  const angle = (Math.atan2(d.y, d.x) * 180) / Math.PI;
  const corner = first + 60 * Math.round((angle - first) / 60);
  const unit = (deg: number) => ({ x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) });
  const at = { x: CIRCUMRADIUS * unit(corner).x, y: CIRCUMRADIUS * unit(corner).y };
  // Its own cell, and the two neighbours either side of the corner's direction.
  const cells = [{ x: 0, y: 0 }, unit(corner - 30), unit(corner + 30)].map((c) => ({ x: c.x - at.x, y: c.y - at.y }));
  return { corner: at, cells };
}

/**
 * Where a free point measures from on a hex grid, and the cells that are
 * its Origen: the center of its cell (that cell), or — within CORNER_PICK of
 * a corner — the corner (the three cells around it). `gridCenter` is one
 * cell's center.
 */
export function snapToOrigin(point: Point, gridCenter: Point, dpi: number, shape: HexShape): { point: Point; cells: Point[] } {
  const local = { x: (point.x - gridCenter.x) / dpi, y: (point.y - gridCenter.y) / dpi };
  const cell = nearestCell(local.x, local.y, shape);
  const d = { x: local.x - cell.x, y: local.y - cell.y };
  const { corner, cells } = nearestCorner(d, shape);
  const onCorner = Math.hypot(d.x - corner.x, d.y - corner.y) < CORNER_PICK;
  const at = onCorner ? { x: cell.x + corner.x, y: cell.y + corner.y } : cell;
  return { point: { x: gridCenter.x + at.x * dpi, y: gridCenter.y + at.y * dpi }, cells: onCorner ? cells : CENTER };
}

/**
 * The cells an Origen at `center` is made of, read back from where it is:
 * the three around a corner if it's on one, else its own cell. What every
 * client works out from a Medición's center alone.
 */
export function originCellsAt(center: Point, gridCenter: Point, dpi: number, shape: HexShape): Point[] {
  const local = { x: (center.x - gridCenter.x) / dpi, y: (center.y - gridCenter.y) / dpi };
  const cell = nearestCell(local.x, local.y, shape);
  const d = { x: local.x - cell.x, y: local.y - cell.y };
  const { corner, cells } = nearestCorner(d, shape);
  return Math.hypot(d.x - corner.x, d.y - corner.y) < 1e-3 ? cells : CENTER;
}

/**
 * A point moved to the center of the cell it's in, given one cell's center
 * (`gridCenter`) and the cell size: where a Medición from a free point on a
 * hex grid measures from.
 */
export function snapToCell(point: Point, gridCenter: Point, dpi: number, shape: HexShape): Point {
  const cell = nearestCell((point.x - gridCenter.x) / dpi, (point.y - gridCenter.y) / dpi, shape);
  return { x: gridCenter.x + cell.x * dpi, y: gridCenter.y + cell.y * dpi };
}
