import "./workerShim";
import { Relief } from "../relief/relief";
import { buildScene, terrainSource, type Reliefs, type VistazoScene } from "./scene";
import { cached, digest, keep } from "./terrainCache";
import { computeTerrain, terrainTransfers } from "./view/terrainBuffers";
import { FineSurfaces } from "./view/surfaces";
import type { MapColors } from "./view/mapColors";
import { packWalls } from "./view/wallPack";
import type { TerrainAnswer, TerrainMessage } from "./terrainJob";
import type { TerrainBuffers } from "./view/terrainBuffers";
import type { PackedWalls } from "./view/wallPack";

// The terrain worked out away from the page (see terrainJob): the scene built again from what the page
// built it from, and its terrain's numbers worked out (see computeTerrain), handed back without copying
// them. The page meanwhile goes on drawing what it has, and moving.

const fine = new FineSurfaces();
let previous: VistazoScene | undefined;
const reliefs = new Map<string, { version: number; relief: Relief; digest: string }>();
/** What's kept is in this shape (changed: what was kept before isn't read). */
const CACHE_FORMAT = 1;
let colors: { key: string; colors: MapColors } | null = null;

self.onmessage = async (event: MessageEvent<TerrainMessage>) => {
  const job = event.data;
  if (job.kind === "colors") {
    colors = { key: job.key, colors: job.colors };
    return;
  }
  const started = performance.now();
  try {
    // A relief sent again under the same key (changed where it is: a brush let go): the last scene isn't
    // reused (its terrain is the old relief's), whatever its key.
    if (job.reliefData.length > 0) {
      previous = undefined;
    }
    for (const [image, version, data] of job.reliefData) {
      // What's in it, for a key that lasts past this session (its version doesn't).
      reliefs.set(image, { version, relief: new Relief(data), digest: job.cache ? await digest(JSON.stringify(data)) : "" });
    }
    const wanted = new Set(job.reliefs.map(([image]) => image));
    for (const image of [...reliefs.keys()]) {
      if (!wanted.has(image)) {
        reliefs.delete(image);
      }
    }
    const byImage = new Map(job.reliefs.map(([image]) => [image, reliefs.get(image)!.relief]));
    const { recipe } = job;
    const stages: Record<string, number> = {};
    const sceneReliefs: Reliefs = { byImage, key: recipe.reliefKey, shutDoors: recipe.shutDoors, surfaced: recipe.surfaced };
    const jobColors = job.colorsKey && colors?.key === job.colorsKey ? colors.colors : null;
    // Kept from before (this session or another): read, not worked out. Not a drag's (drawn lightly, a
    // new one several times a second), nor with colours asked for that aren't here.
    let cacheKey = "";
    if (job.cache && !job.lite && (!job.colorsKey || jobColors)) {
      const looked = performance.now();
      const contents = job.reliefs.map(([image]) => `${image}:${reliefs.get(image)!.digest}`).join(",");
      const source = terrainSource(recipe.metadata, recipe.items, recipe.dpi, recipe.gridType, recipe.playerView, sceneReliefs, contents).key;
      cacheKey = await digest(JSON.stringify([self.location.href, CACHE_FORMAT, source, job.base, job.context, job.colorsKey]));
      const hit = await cached<{ terrain: TerrainBuffers; walls: PackedWalls }>(cacheKey);
      if (hit) {
        stages.cache = performance.now() - looked;
        const terrainKey = terrainSource(recipe.metadata, recipe.items, recipe.dpi, recipe.gridType, recipe.playerView, sceneReliefs).key;
        const answer: TerrainAnswer = { request: job.request, terrainKey, terrain: hit.terrain, walls: hit.walls, took: performance.now() - started, stages };
        (self as unknown as Worker).postMessage(answer, [...terrainTransfers(hit.terrain), hit.walls.numbers.buffer, hit.walls.segs.buffer, hit.walls.looks.buffer]);
        return;
      }
    }
    const built = performance.now();
    const scene = buildScene(recipe.metadata, recipe.items, recipe.dpi, recipe.scale, recipe.gridType, previous, recipe.hexCenter, recipe.playerView, sceneReliefs);
    previous = scene;
    stages.scene = performance.now() - built;
    const terrain = computeTerrain(scene, job.base, { ...job.context, colors: jobColors }, fine, undefined, job.lite, stages, job.lite);
    const walls = packWalls(terrain.walls);
    const answer: TerrainAnswer = { request: job.request, terrainKey: scene.terrainKey, terrain: { ...terrain, walls: [] }, walls, took: performance.now() - started, stages };
    if (cacheKey) {
      // Copied now (before its arrays are handed over below).
      keep(cacheKey, { terrain: answer.terrain, walls });
    }
    (self as unknown as Worker).postMessage(answer, [...terrainTransfers(terrain), walls.numbers.buffer, walls.segs.buffer, walls.looks.buffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({ request: job.request, failed: String(error) } satisfies TerrainAnswer);
  }
};
