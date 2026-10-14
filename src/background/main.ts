import OBR from "@owlbear-rodeo/sdk";
import { syncSettings } from "./syncSettings";
import { startMeasureMirrorReceiver } from "./measureMirror";
import { startHeightOverlays } from "./heightOverlays";
import { startMarkerRefresh } from "./markerRefresh";
import { startFixedMedicion } from "./fixedMedicion";
import { startIsoLift } from "./isoLift";
import { registerToolbar, watchToolbar } from "./toolbar";
import { prefetchPanels } from "./prefetchPanels";
import { startTerrainStyle } from "./terrainStyle";
import { startTerrainView } from "./terrainView";

async function waitUntilOBRReady() {
  return new Promise<void>((resolve) => {
    OBR.onReady(() => {
      resolve();
    });
  });
}

/**
 * Waits for a scene: OBR.onReady() doesn't mean one has loaded, and
 * OBR.scene.* throws ("No scene found") until it has. A room with no scene
 * open is valid too, so with `timeoutMs` this gives up after that long and
 * resolves false.
 */
async function waitUntilSceneReady(timeoutMs?: number): Promise<boolean> {
  if (await OBR.scene.isReady()) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (ready: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      unsubscribe();
      resolve(ready);
    };
    const unsubscribe = OBR.scene.onReadyChange((ready) => {
      if (ready) {
        finish(true);
      }
    });
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => finish(false), timeoutMs);
    }
  });
}

// The SDK's own call timeout: plenty for a scene that's still loading, short
// enough that a room with no scene doesn't wait long for its toolbar.
const SCENE_READY_TIMEOUT_MS = 5000;

async function init() {
  await waitUntilOBRReady();
  syncSettings();
  startMeasureMirrorReceiver();

  // The toolbar follows the scene's settings (see toolbar.ts); with no scene
  // yet, it starts from the defaults.
  const sceneReady = await waitUntilSceneReady(SCENE_READY_TIMEOUT_MS);
  registerToolbar(sceneReady ? await OBR.scene.getMetadata() : {});
  watchToolbar();
  prefetchPanels();

  // These work on scene items, so they wait for a scene themselves.
  startMarkerRefresh().catch((error) => {
    console.error("Rising Ranges: failed to start height marker refresh", error);
  });
  startHeightOverlays().catch((error) => {
    console.error("Rising Ranges: failed to start height extras", error);
  });
  startTerrainStyle().catch((error) => {
    console.error("Rising Ranges: failed to start terrain styling", error);
  });
  startTerrainView().catch((error) => {
    console.error("Rising Ranges: failed to start the terrain view", error);
  });
  startFixedMedicion().catch((error) => {
    console.error("Rising Ranges: failed to start the Medición fija", error);
  });
  startIsoLift().catch((error) => {
    console.error("Rising Ranges: failed to start raised tokens", error);
  });
}

init().catch((error) => {
  console.error("Rising Ranges: failed to initialize", error);
});
