import type { GridScale, GridType, Item } from "@owlbear-rodeo/sdk";
import type { Relief } from "../relief/relief";
import type { ReliefData } from "../relief/types";
import type { Reliefs } from "./scene";
import type { MapColors } from "./view/mapColors";
import type { TerrainBuffers, TerrainContext } from "./view/terrainBuffers";
import type { PackedWalls } from "./view/wallPack";
import { record, timingOn } from "../timing";

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
  reliefs: Reliefs;
};

/** A message to the worker: the map's colours (sent once, when they change); or a terrain to work out. */
export type TerrainMessage =
  | { kind: "colors"; key: string; colors: MapColors }
  | {
      kind: "terrain";
      request: number;
      recipe: Omit<SceneRecipe, "reliefs"> & { reliefKey: string; surfaced: boolean; shutDoors?: string[] };
      /** Each map image's relief by version; the data of those the worker hasn't been sent yet. */
      reliefs: [string, number][];
      reliefData: [string, number, ReliefData][];
      base: number;
      /** Drawn lightly (a drag): without the walls' shadows (see computeTerrain). */
      lite: boolean;
      context: Omit<TerrainContext, "colors">;
      colorsKey: string | null;
    };

/** The worker's answer: the terrain for a request (its walls packed, not in it: see wallPack), and the scene's terrain key it was worked out for. */
export type TerrainAnswer = { request: number; terrainKey: string; terrain: TerrainBuffers; walls: PackedWalls; took: number; stages: Record<string, number> } | { request: number; failed: string };

/**
 * The page's end of the terrain's worker: asks it for a scene's terrain (only the last asked is
 * answered: an earlier one's answer is dropped), sending the reliefs and the map's colours it doesn't
 * have yet. One at a time: asked again while it's working one out, only the last of those is sent once
 * it's done (a drag asks several times a second; the worker doesn't fall behind). None where workers
 * can't be made: the page works it out itself then.
 */
export class TerrainJobs {
  private readonly worker: Worker;
  private request = 0;
  private waiting: ((answer: TerrainAnswer) => void) | null = null;
  private readonly versions = new WeakMap<Relief, number>();
  private version = 0;
  /** What each image's relief was last sent as: the relief and the reliefs' key then (the editor changes its own relief in place). */
  private readonly sent = new Map<string, string>();
  private colorsKey: string | null = null;
  /** Being worked out by the worker now; what's to be sent once it's done (the last asked). */
  private busy = false;
  private queued: TerrainMessage | null = null;
  /** It failed to start or died (see the constructor): every ask answered as failed, for the page to work it out itself. */
  private dead = false;

  static make(): TerrainJobs | null {
    try {
      // Off by hand (to tell what's the worker's doing): localStorage "rising-ranges/worker" = "0".
      if (localStorage.getItem("rising-ranges/worker") === "0") {
        return null;
      }
      return new TerrainJobs(new Worker(new URL("./terrainWorker.ts", import.meta.url), { type: "module" }));
    } catch {
      return null;
    }
  }

  private constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (event: MessageEvent<TerrainAnswer>) => {
      this.busy = false;
      // How long the worker took (with the page's stopwatch on: see timing.ts).
      if (timingOn && "took" in event.data) {
        record("worker.terrain", event.data.took);
        for (const [stage, ms] of Object.entries(event.data.stages)) {
          record(`worker.${stage}`, ms);
        }
      }
      if (this.queued) {
        this.send(this.queued);
        this.queued = null;
      }
      if (event.data.request === this.request) {
        const waiting = this.waiting;
        this.waiting = null;
        waiting?.(event.data);
      }
    };
    // Its script didn't load (a stale chunk after a deploy), or it died (out of memory): what's waiting answered as failed.
    this.worker.onerror = this.worker.onmessageerror = (event: Event) => {
      event.preventDefault();
      this.dead = true;
      this.busy = false;
      this.queued = null;
      const waiting = this.waiting;
      this.waiting = null;
      waiting?.({ request: this.request, failed: "the worker stopped" });
    };
  }

  /** A relief changed where it is, its key kept (a brush let go that settles: see VistazoView.setScene): sent again next time. */
  touched() {
    this.sent.clear();
  }

  /** The map's colours, sent if the worker doesn't have them (`key`: which they are). */
  colors(key: string, colors: MapColors) {
    if (key !== this.colorsKey) {
      this.colorsKey = key;
      this.worker.postMessage({ kind: "colors", key, colors } satisfies TerrainMessage);
    }
  }

  /** A scene's terrain asked for; answered (once worked out) unless another's asked first. */
  ask(recipe: SceneRecipe, base: number, context: TerrainContext, colorsKey: string | null, lite = false): Promise<TerrainAnswer> {
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
      const as = `${version}|${reliefs.key}`;
      if (this.sent.get(image) !== as) {
        this.sent.set(image, as);
        data.push([image, version, relief.data]);
      }
    }
    const { colors: _colors, ...plain } = context;
    void _colors;
    const request = ++this.request;
    this.waiting = null;
    if (this.dead) {
      return Promise.resolve({ request, failed: "the worker stopped" });
    }
    const message: TerrainMessage = { kind: "terrain", request, recipe: { ...rest, reliefKey: reliefs.key, surfaced: !!reliefs.surfaced, shutDoors: reliefs.shutDoors }, reliefs: list, reliefData: data, base, lite, context: plain, colorsKey };
    if (this.busy) {
      // A queued one's reliefs that this one doesn't send again (sent then) go with it.
      if (this.queued?.kind === "terrain") {
        const sent = new Set(message.reliefData.map(([image]) => image));
        message.reliefData.push(...this.queued.reliefData.filter(([image]) => !sent.has(image)));
      }
      this.queued = message;
    } else {
      this.send(message);
    }
    return new Promise((resolve) => (this.waiting = resolve));
  }

  private send(message: TerrainMessage) {
    this.busy = true;
    this.worker.postMessage(message);
  }

  stop() {
    this.worker.terminate();
  }
}
