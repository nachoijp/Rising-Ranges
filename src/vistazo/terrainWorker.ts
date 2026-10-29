import "./workerShim";
import { Relief } from "../relief/relief";
import { buildScene, type VistazoScene } from "./scene";
import { clearOf, type Fog } from "./fog";
import { computeTerrain, terrainTransfers } from "./view/terrainBuffers";
import { FineSurfaces } from "./view/surfaces";
import type { MapColors } from "./view/mapColors";
import { packWalls } from "./view/wallPack";
import type { TerrainAnswer, TerrainMessage } from "./terrainJob";

// The terrain worked out away from the page (see terrainJob): the scene built again from what the page
// built it from, and its terrain's numbers worked out (see computeTerrain), handed back without copying
// them. The page meanwhile goes on drawing what it has, and moving.

const fine = new FineSurfaces();
let previous: VistazoScene | undefined;
const reliefs = new Map<string, { version: number; relief: Relief }>();
let colors: { key: string; colors: MapColors } | null = null;

self.onmessage = (event: MessageEvent<TerrainMessage>) => {
  const job = event.data;
  if (job.kind === "colors") {
    colors = { key: job.key, colors: job.colors };
    return;
  }
  const started = performance.now();
  try {
    for (const [image, version, data] of job.reliefData) {
      reliefs.set(image, { version, relief: new Relief(data) });
    }
    const wanted = new Set(job.reliefs.map(([image]) => image));
    for (const image of [...reliefs.keys()]) {
      if (!wanted.has(image)) {
        reliefs.delete(image);
      }
    }
    const byImage = new Map(job.reliefs.map(([image]) => [image, reliefs.get(image)!.relief]));
    const { recipe } = job;
    const fog = recipe.fog;
    const sight = fog ? { key: fog.key, clear: (world: Parameters<typeof clearOf>[1]) => clearOf(fog as unknown as Fog, world) } : null;
    const stages: Record<string, number> = {};
    const built = performance.now();
    const scene = buildScene(recipe.metadata, recipe.items, recipe.dpi, recipe.scale, recipe.gridType, previous, recipe.hexCenter, recipe.playerView, sight, {
      byImage,
      key: recipe.reliefKey,
      surfaced: recipe.surfaced,
    });
    previous = scene;
    stages.scene = performance.now() - built;
    const terrain = computeTerrain(scene, job.base, { ...job.context, colors: job.colorsKey && colors?.key === job.colorsKey ? colors.colors : null }, fine, undefined, job.lite, stages, job.lite);
    const walls = packWalls(terrain.walls);
    const answer: TerrainAnswer = { request: job.request, terrainKey: scene.terrainKey, terrain: { ...terrain, walls: [] }, walls, took: performance.now() - started, stages };
    (self as unknown as Worker).postMessage(answer, [...terrainTransfers(terrain), walls.numbers.buffer, walls.segs.buffer, walls.looks.buffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({ request: job.request, failed: String(error) } satisfies TerrainAnswer);
  }
};
