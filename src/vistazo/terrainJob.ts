import type { GridScale, GridType, Item } from "@owlbear-rodeo/sdk";
import type { Relief } from "../relief/relief";
import type { ReliefData } from "../relief/types";
import type { Reliefs } from "./scene";
import type { MapColors } from "./view/mapColors";
import type { TerrainBuffers, TerrainContext } from "./view/terrainBuffers";

// The terrain worked out away from the page (see terrainWorker): what's asked of it, and the page's end
// of it. A scene carries what it was built from (its recipe), for the worker to build the same one.

/** What a scene was built from (buildScene's arguments, the fog as plain numbers): the worker builds the same scene from it. */
export type SceneRecipe = {
  metadata: Record<string, unknown>;
  items: Item[];
  dpi: number;
  scale: GridScale;
  gridType: GridType;
  hexCenter: { x: number; y: number } | null;
  playerView: boolean;
  fog: { key: string; filled: boolean; shapes: [number, number][][]; lit: [number, number][][] } | null;
  reliefs: Reliefs;
};

/** A message to the worker: the map's colours (sent once, when they change); or a terrain to work out. */
export type TerrainMessage =
  | { kind: "colors"; key: string; colors: MapColors }
  | {
      kind: "terrain";
      request: number;
      recipe: Omit<SceneRecipe, "reliefs"> & { reliefKey: string; surfaced: boolean };
      /** Each map image's relief by version; the data of those the worker hasn't been sent yet. */
      reliefs: [string, number][];
      reliefData: [string, number, ReliefData][];
      base: number;
      context: Omit<TerrainContext, "colors">;
      colorsKey: string | null;
    };

/** The worker's answer: the terrain for a request, and the scene's terrain key it was worked out for. */
export type TerrainAnswer = { request: number; terrainKey: string; terrain: TerrainBuffers } | { request: number; failed: string };

/**
 * The page's end of the terrain's worker: asks it for a scene's terrain (only the last asked is
 * answered: an earlier one's answer is dropped), sending the reliefs and the map's colours it doesn't
 * have yet. None where workers can't be made: the page works it out itself then.
 */
export class TerrainJobs {
  private readonly worker: Worker;
  private request = 0;
  private waiting: ((answer: TerrainAnswer) => void) | null = null;
  private readonly versions = new WeakMap<Relief, number>();
  private version = 0;
  private readonly sent = new Map<string, number>();
  private colorsKey: string | null = null;

  static make(): TerrainJobs | null {
    try {
      return new TerrainJobs(new Worker(new URL("./terrainWorker.ts", import.meta.url), { type: "module" }));
    } catch {
      return null;
    }
  }

  private constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (event: MessageEvent<TerrainAnswer>) => {
      if (event.data.request === this.request) {
        const waiting = this.waiting;
        this.waiting = null;
        waiting?.(event.data);
      }
    };
  }

  /** The map's colours, sent if the worker doesn't have them (`key`: which they are). */
  colors(key: string, colors: MapColors) {
    if (key !== this.colorsKey) {
      this.colorsKey = key;
      this.worker.postMessage({ kind: "colors", key, colors } satisfies TerrainMessage);
    }
  }

  /** A scene's terrain asked for; answered (once worked out) unless another's asked first. */
  ask(recipe: SceneRecipe, base: number, context: TerrainContext, colorsKey: string | null): Promise<TerrainAnswer> {
    const { reliefs, ...rest } = recipe;
    const list: [string, number][] = [];
    const data: [string, number, ReliefData][] = [];
    for (const [image, relief] of reliefs.byImage) {
      let version = this.versions.get(relief);
      if (version === undefined) {
        version = ++this.version;
        this.versions.set(relief, version);
      }
      list.push([image, version]);
      if (this.sent.get(image) !== version) {
        this.sent.set(image, version);
        data.push([image, version, relief.data]);
      }
    }
    const { colors: _colors, ...plain } = context;
    void _colors;
    const request = ++this.request;
    this.waiting = null;
    const message: TerrainMessage = { kind: "terrain", request, recipe: { ...rest, reliefKey: reliefs.key, surfaced: !!reliefs.surfaced }, reliefs: list, reliefData: data, base, context: plain, colorsKey };
    this.worker.postMessage(message);
    return new Promise((resolve) => (this.waiting = resolve));
  }

  stop() {
    this.worker.terminate();
  }
}
