import OBR, { type GridType, type Vector2 } from "@owlbear-rodeo/sdk";
import { axonometryOf } from "../engine/axonometry";
import { isHexShape, originCellsAt } from "../engine/hex";
import type { BandShape } from "../engine/types";

// Kept up to date from grid.onChange rather than asked for each time: it's
// read at the start of every Medición, where each round trip to Owlbear
// delays the press it answers. One query answers both the grid's type and
// its axonometry.

let cached: GridType | null = null;
/** One cell's center on a hex grid, where its cells start from (see snapToCell); null until known. */
let hexCenter: Vector2 | null = null;
let pending: Promise<GridType> | null = null;
/** Bumped whenever the grid may have changed, so an answer from before is dropped. */
let version = 0;
let watching = false;

function watch() {
  if (watching) {
    return;
  }
  watching = true;
  OBR.scene.grid.onChange((grid) => {
    version++;
    pending = null;
    cached = grid.type;
    hexCenter = null;
    fetchHexCenter(grid.type);
  });
  OBR.scene.onReadyChange((ready) => {
    version++;
    pending = null;
    cached = null;
    hexCenter = null;
    if (ready) {
      prefetchGridAxonometry();
    }
  });
}

/** Fetches it ahead of its first use (with no scene yet, once one opens). */
export function prefetchGridAxonometry() {
  getGridType()
    .then(fetchHexCenter)
    .catch(() => {});
}

function fetchHexCenter(type: GridType) {
  if (type !== "HEX_HORIZONTAL" && type !== "HEX_VERTICAL") {
    return;
  }
  const asked = version;
  OBR.scene.grid
    .snapPosition({ x: 0, y: 0 }, 1, false, true)
    .then((center) => {
      if (asked === version) {
        hexCenter = center;
      }
    })
    .catch(() => {});
}

/**
 * The cells a hex Medición at `center` measures from (see originCellsAt):
 * undefined off a hex shape, its own cell while the grid isn't known yet.
 */
export function originCells(center: Vector2, dpi: number, shape: BandShape): Vector2[] | undefined {
  if (!isHexShape(shape)) {
    return undefined;
  }
  return hexCenter && dpi ? originCellsAt(center, hexCenter, dpi, shape) : undefined;
}

/** One cell's center on a hex grid, if it's known yet (fetched ahead, see prefetchGridAxonometry). */
export function knownHexCenter(): Vector2 | null {
  return hexCenter;
}

/** The scene grid's type, from the cache when it's known. */
export async function getGridType(): Promise<GridType> {
  watch();
  if (cached !== null) {
    return cached;
  }
  if (!pending) {
    const asked = version;
    pending = OBR.scene.grid.getType().then((type) => {
      if (asked === version) {
        cached = type;
      }
      return type;
    });
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}

/** The scene grid's rhombus ratio, 0 on a flat grid (see axonometry.ts). */
export async function getGridAxonometry(): Promise<number> {
  return axonometryOf(await getGridType());
}
