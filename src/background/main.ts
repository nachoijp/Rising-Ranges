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
import { startReliefs } from "../relief/live";
import { SYNC_CHANNEL, type SyncMessage } from "../vistazo/sync";
import { isVistazoShown, openVistazoPanel, vistazoClosedAt, watchVistazoPanel } from "../vistazo/panel";
import { globalSettingsFromMetadata, vistazoAccess } from "../settings/globalSettings";

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
  // The reliefs kept on this device: handed to the relief editor and the other windows that ask.
  startReliefs();

  // The toolbar follows the scene's settings (see toolbar.ts); with no scene
  // yet, it starts from the defaults.
  const sceneReady = await waitUntilSceneReady(SCENE_READY_TIMEOUT_MS);
  registerToolbar(sceneReady ? await OBR.scene.getMetadata() : {});
  watchToolbar();
  watchSyncedView();
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

/**
 * A player's Vistazo opens by itself when the GM syncs their view (see
 * vistazo/sync.ts), if the scene lets players have it; the page then
 * follows the camera. Not while it shows (the panel, or full screen), and
 * not again in a sync the player closed it during: only when the GM syncs
 * anew. Who's playing and what the scene allows are kept as they change
 * (the camera comes several times a second).
 */
function watchSyncedView() {
  watchVistazoPanel();
  let role: string | null = null;
  let everyone = false;
  const readAccess = (metadata: Record<string, unknown>) => {
    everyone = vistazoAccess(globalSettingsFromMetadata(metadata)) === "everyone";
  };
  const loadAccess = () => {
    OBR.scene.getMetadata().then(readAccess, () => {
      everyone = false;
    });
  };
  OBR.player.getRole().then((value) => {
    role = value;
  }, () => {});
  OBR.player.onChange((player) => {
    role = player.role;
  });
  loadAccess();
  OBR.scene.onMetadataChange(readAccess);
  OBR.scene.onReadyChange((ready) => (ready ? loadAccess() : (everyone = false)));
  // The sync followed (when the GM began it) and when it was first heard here.
  let since = 0;
  let heardAt = 0;
  let opening = false;
  OBR.broadcast.onMessage(SYNC_CHANNEL, async (event) => {
    const message = event.data as SyncMessage;
    if (message.type !== "camera") {
      return;
    }
    if (message.since !== since) {
      since = message.since;
      heardAt = Date.now();
    }
    if (opening || isVistazoShown() || role !== "PLAYER" || !everyone || vistazoClosedAt() > heardAt) {
      return;
    }
    opening = true;
    try {
      await openVistazoPanel();
    } catch {
      // Not now; the next camera tries again.
    } finally {
      opening = false;
    }
  });
}

init().catch((error) => {
  console.error("Rising Ranges: failed to initialize", error);
});
