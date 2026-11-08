import OBR, { type Item } from "@owlbear-rodeo/sdk";
import type { RampSlope, TerrainShape, TerrainZone } from "../terrain/terrain";
import { cellToScene, type Anchor } from "./anchor";
import { mapAnchors, reliefZones } from "./measure";
import { area, inShape, type Box } from "./geom";
import { Relief } from "./relief";
// Measured with every door a way through (see doorCut.ts).
import { stackCut } from "./doorCut";
import type { Pt } from "./types";
import type { Stacked } from "./stack";
import { startReliefService } from "./store";

// The background page's reliefs, worked out: one a map image of the room,
// as they're kept on this device (see store.ts), kept up to date as the
// editor saves them. What's measured here asks them (see withReliefs).

export const reliefs = new Map<string, Relief>();

/** The scene's visible map images, where they are (as the Vistazo takes them). */
let anchors = new Map<string, Anchor>();
let anchorsKey = "";
let dpi = 150;
/** Bumped with every change of the reliefs or their images (for what's drawn from them). */
let version = 0;
const listeners = new Set<() => void>();

/** Something measured here changes with the reliefs: told when one, or the image it follows, does. */
export function onReliefsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const changed = () => {
  version++;
  listeners.forEach((listener) => listener());
};

/** Changes with the reliefs, or the images they follow. */
export const reliefsVersion = () => version;

function takeItems(items: Item[]) {
  const next = mapAnchors(items);
  const key = JSON.stringify([...next.values()]);
  if (key !== anchorsKey) {
    anchors = next;
    anchorsKey = key;
    changed();
  }
}

/** The terrain measured here: the reliefs' (see measure.ts). */
export function terrainNow(): TerrainZone[] {
  return reliefZones(reliefs, anchors, dpi);
}

/** Below this rise a cell, a shape is drawn flat. */
const FLAT = 0.05;
const SAMPLES = 9;

/**
 * How a shape's surface goes, for drawing it: flat at one height, or a slope
 * (the plane nearest its heights, sampled over it) from its low end to its high one.
 */
function lie(height: (x: number, y: number) => number, ring: Pt[], holes: Pt[][], box: Box): { low: number; high: number; from: Pt; to: Pt } {
  const samples: [number, number, number][] = [];
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      const x = box.x0 + ((box.x1 - box.x0) * (i + 0.5)) / SAMPLES;
      const y = box.y0 + ((box.y1 - box.y0) * (j + 0.5)) / SAMPLES;
      if (inShape(x, y, ring, holes)) {
        samples.push([x, y, height(x, y)]);
      }
    }
  }
  if (samples.length === 0) {
    const [x, y] = ring[0];
    samples.push([x, y, height(x, y)]);
  }
  const n = samples.length;
  const mean = samples.reduce((t, [x, y, h]) => [t[0] + x / n, t[1] + y / n, t[2] + h / n], [0, 0, 0]);
  // h − mean = a·(x − mx) + b·(y − my), least squares.
  let [sxx, sxy, syy, sxh, syh] = [0, 0, 0, 0, 0];
  for (const [x, y, h] of samples) {
    const [dx, dy, dh] = [x - mean[0], y - mean[1], h - mean[2]];
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    sxh += dx * dh;
    syh += dy * dh;
  }
  const det = sxx * syy - sxy * sxy;
  const [a, b] = Math.abs(det) > 1e-9 ? [(sxh * syy - syh * sxy) / det, (syh * sxx - sxh * sxy) / det] : [0, 0];
  const g = Math.hypot(a, b);
  const centre: Pt = [mean[0], mean[1]];
  if (g < FLAT) {
    return { low: mean[2], high: mean[2], from: centre, to: centre };
  }
  // Its ends along the slope: the outline's farthest points that way.
  const [ux, uy] = [a / g, b / g];
  const along = ([x, y]: Pt) => (x - mean[0]) * ux + (y - mean[1]) * uy;
  const ts = ring.map(along);
  const [t0, t1] = [Math.min(...ts), Math.max(...ts)];
  return { low: mean[2] + g * t0, high: mean[2] + g * t1, from: [mean[0] + ux * t0, mean[1] + uy * t0], to: [mean[0] + ux * t1, mean[1] + uy * t1] };
}

/**
 * The reliefs' shapes as terrain zones are drawn (see terrainView.ts), in
 * the scene: the one on top first (slabs, then the shapes from the top
 * down), so each shows only what nothing over it covers; a sloping one with
 * its slope. `follow`: the map image, which they move with.
 */
export function reliefShapes(): (TerrainShape & { follow: string })[] {
  const shapes: (TerrainShape & { follow: string })[] = [];
  // The one on top first, each over those under it (see stack.ts).
  const stack: Stacked[] = [...anchors].flatMap(([id, anchor]) => {
    const relief = reliefs.get(id);
    return relief ? [{ id, relief, anchor }] : [];
  });
  // Doors cut through (see doorCut.ts), as the Vistazo shows them.
  for (const { id, relief, anchor } of stackCut(stack, dpi).reverse()) {
    const toScene = ([x, y]: Pt): [number, number] => {
      const p = cellToScene(anchor, dpi, x, y);
      return [p.x, p.y];
    };
    // A cell's area in the scene (px²).
    const scale = Math.abs(anchor.scaleX * anchor.scaleY) * dpi * dpi;
    const add = (key: string, ring: Pt[], holes: Pt[][], box: Box, height: (x: number, y: number) => number) => {
      const { low, high, from, to } = lie(height, ring, holes, box);
      const [o, e] = [toScene(from), toScene(to)];
      const slope: RampSlope | undefined = high - low >= FLAT ? { low, origin: { x: o[0], y: o[1] }, axis: { x: e[0] - o[0], y: e[1] - o[1] } } : undefined;
      shapes.push({ id: `relief:${id}:${key}`, follow: id, height: high, area: Math.abs(area(ring)) * scale, rings: [ring, ...holes].map((loop) => loop.map(toScene)), slope });
    };
    for (const layer of [...relief.slabLayers].reverse()) {
      add(`slab${layer.si}`, layer.ring, layer.holes, layer.box, (x, y) => relief.surface(layer, x, y));
    }
    for (const layer of [...relief.layers].reverse()) {
      add(`${layer.si}`, layer.ring, layer.holes, layer.box, (x, y) => relief.surface(layer, x, y));
    }
  }
  return shapes;
}

export function startReliefs() {
  startReliefService((image, data) => {
    if (data) {
      // As it is: its doors cut once it's stacked (see stackCut).
      reliefs.set(image, new Relief(data));
    } else {
      reliefs.delete(image);
    }
    changed();
  }).catch((error) => console.error("Rising Ranges: the reliefs couldn't be started", error));
  OBR.scene.items.onChange(takeItems);
  OBR.scene.grid.onChange(async () => {
    dpi = await OBR.scene.grid.getDpi();
    changed();
  });
  const load = async () => {
    [dpi] = await Promise.all([OBR.scene.grid.getDpi(), OBR.scene.items.getItems().then(takeItems)]);
    changed();
  };
  OBR.scene.onReadyChange((ready) => {
    if (ready) {
      load().catch((error) => console.error("Rising Ranges: the reliefs' map images couldn't be read", error));
    }
  });
  OBR.scene
    .isReady()
    .then((ready) => (ready ? load() : undefined))
    .catch((error) => console.error("Rising Ranges: the reliefs' map images couldn't be read", error));
}
