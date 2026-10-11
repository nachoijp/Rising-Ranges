import OBR, { isImage, type Image, type Item } from "@owlbear-rodeo/sdk";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import { globalSettingsFromMetadata, liftsTokens } from "../settings/globalSettings";
import { getTokenHeight, isTokenHeightMarker } from "../tokenHeight/markers";
import { applyPlannedLift, getTokenLift, plannedLift } from "../tokenHeight/lift";
import { axonometryOf } from "../engine/axonometry";
import { getGridAxonometry } from "../util/gridAxonometry";

// Draws raised tokens raised on an axonometric grid, by moving each one's
// image (see lift.ts) — and puts every one back the moment it shouldn't be:
// the option is off, the height feature is off, the grid isn't axonometric,
// or the token is back on the ground.
//
// These are writes to the tokens themselves, so like the markers' refresh
// (markerRefresh.ts) only the GM's client makes them, and only for tokens
// that come out different. Every GM's client computes the same thing from
// the same scene, so two GMs at once write the same values.

let metadata: Record<string, unknown> = {};
let items: Item[] = [];
let dpi = 0;
let axonometry = 0;
let isGm = false;
let sceneReady = false;
let running = false;
let dirty = false;

/** tokenId -> how far up to draw it, px on screen (0 = in its own place). */
function wantedLifts(): Map<string, number> {
  const wanted = new Map<string, number>();
  const settings = globalSettingsFromMetadata(metadata);
  const lifting = liftsTokens(settings, axonometry);
  const bandSet = bandSetFromMetadata(metadata);
  const heights = new Map<string, number>();
  if (lifting) {
    for (const item of items) {
      if (isTokenHeightMarker(item) && item.attachedTo && !heights.has(item.attachedTo)) {
        heights.set(item.attachedTo, getTokenHeight(item, bandSet) ?? 0);
      }
    }
  }
  for (const item of items) {
    if (!isImage(item)) {
      continue;
    }
    const height = heights.get(item.id) ?? 0;
    // Only what Owlbear has to change: a raised token, or one to put back.
    if (height || getTokenLift(item)) {
      // Whole px: the same on every client, and no rewrite over float noise.
      wanted.set(item.id, Math.round(height * dpi));
    }
  }
  return wanted;
}

async function reconcile() {
  if (!isGm || !sceneReady || !dpi) {
    return;
  }
  const wanted = wantedLifts();
  const ids = items
    .filter((item): item is Image => isImage(item) && wanted.has(item.id))
    .filter((token) => plannedLift(token, wanted.get(token.id) ?? 0, dpi) !== null)
    .map((token) => token.id);
  if (ids.length === 0) {
    return;
  }
  await OBR.scene.items.updateItems(ids, (drafts) => {
    for (const draft of drafts) {
      if (!isImage(draft)) {
        continue;
      }
      // Planned again from the draft: the token as it is now.
      const plan = plannedLift(draft, wanted.get(draft.id) ?? 0, dpi);
      if (plan) {
        applyPlannedLift(draft, plan);
      }
    }
  });
}

/** One pass at a time; a change landing mid-pass gets one more pass afterwards. */
function schedule() {
  dirty = true;
  if (running) {
    return;
  }
  running = true;
  (async () => {
    while (dirty) {
      dirty = false;
      try {
        await reconcile();
      } catch (error) {
        console.error("Rising Ranges: failed to raise tokens", error);
      }
    }
    running = false;
  })();
}

async function loadScene() {
  const [nextMetadata, nextItems, nextDpi, nextAxonometry] = await Promise.all([
    OBR.scene.getMetadata(),
    OBR.scene.items.getItems(),
    OBR.scene.grid.getDpi(),
    getGridAxonometry(),
  ]);
  metadata = nextMetadata;
  items = nextItems;
  dpi = nextDpi;
  axonometry = nextAxonometry;
  sceneReady = true;
  schedule();
}

export async function startIsoLift() {
  OBR.scene.onReadyChange((ready) => {
    sceneReady = false;
    if (ready) {
      loadScene().catch((error) => console.error("Rising Ranges: failed to load raised tokens", error));
    }
  });
  OBR.scene.items.onChange((next) => {
    items = next;
    schedule();
  });
  OBR.scene.onMetadataChange((next) => {
    metadata = next;
    schedule();
  });
  OBR.scene.grid.onChange(async (grid) => {
    [dpi, axonometry] = await Promise.all([OBR.scene.grid.getDpi(), axonometryOf(grid.type)]);
    schedule();
  });
  OBR.player.onChange((player) => {
    const becameGm = player.role === "GM" && !isGm;
    isGm = player.role === "GM";
    if (becameGm) {
      schedule();
    }
  });
  isGm = (await OBR.player.getRole()) === "GM";
  if (await OBR.scene.isReady()) {
    await loadScene();
  }
}
