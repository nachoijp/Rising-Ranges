import OBR from "@owlbear-rodeo/sdk";
import { axonometryOf } from "../engine/axonometry";

// Kept up to date from grid.onChange rather than asked for each time: it's
// read at the start of every Medición, where each round trip to Owlbear
// delays the press it answers.

let cached: number | null = null;
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
    cached = axonometryOf(grid.type);
  });
  OBR.scene.onReadyChange((ready) => {
    version++;
    cached = null;
    if (ready) {
      prefetchGridAxonometry();
    }
  });
}

/** Fetches it ahead of its first use (with no scene yet, once one opens). */
export function prefetchGridAxonometry() {
  getGridAxonometry().catch(() => {});
}

/** The scene grid's rhombus ratio, 0 on a flat grid (see axonometry.ts). */
export async function getGridAxonometry(): Promise<number> {
  watch();
  if (cached !== null) {
    return cached;
  }
  const asked = version;
  const value = axonometryOf(await OBR.scene.grid.getType());
  if (asked === version) {
    cached = value;
  }
  return value;
}
