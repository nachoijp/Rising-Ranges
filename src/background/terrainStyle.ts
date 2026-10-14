import OBR, { isCurve, isPath, isShape, type Curve, type GridType, type Item, type Path, type Shape } from "@owlbear-rodeo/sdk";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import { globalSettingsFromMetadata, terrainOn, terrainVisibility, type TerrainVisibility } from "../settings/globalSettings";
import { getGridType } from "../util/gridAxonometry";
import { canBeTerrain, getTerrainHeight } from "../terrain/terrain";
import { markerBaseColor } from "../tokenHeight/markers";
import { getStoredTheme, THEME_STORAGE_KEYS } from "../theme/themes";
import { getColorString } from "../util/color";
import { getPluginId } from "../util/getPluginId";
import { isPlainObject } from "../util/isPlainObject";

// How terrain zones look (see terrain.ts): their outline in the color of
// their height, as a height marker of that height would be, and who sees
// them, one choice for the whole scene (GlobalSettings.terrainVisibility).
// "hidden" draws them transparent and not clickable — so they don't catch a
// drag meant for a token — and "gm" hides them in Owlbear, which the GM
// still sees faded.
//
// What it changes of a shape is kept in its metadata the first time, and
// put back when it stops being terrain (untagged, or moved off the Map
// layer), or heights or terrain are turned off, or on an isometric or
// dimetric grid (see terrainOn).
//
// These are writes to the shapes themselves, so like isoLift.ts only the
// GM's client makes them, and only for shapes that come out different. The
// colors are the GM's theme's.

const ORIGINAL_KEY = getPluginId("terrainStyle");
/** A zone at ground level: a neutral outline. */
const GROUND_STROKE = "#9e9e9e";

type Styled = Shape | Curve | Path;
type Original = { strokeColor: string; strokeOpacity: number; fillOpacity: number; visible: boolean; disableHit: boolean };

let metadata: Record<string, unknown> = {};
let items: Item[] = [];
let isGm = false;
let gridType: GridType = "SQUARE";
let sceneReady = false;
let running = false;
let dirty = false;

function styled(item: Item): item is Styled {
  return isShape(item) || isCurve(item) || isPath(item);
}

function getOriginal(item: Item): Original | undefined {
  const stored = item.metadata[ORIGINAL_KEY];
  if (
    isPlainObject(stored) &&
    typeof stored.strokeColor === "string" &&
    typeof stored.strokeOpacity === "number" &&
    typeof stored.fillOpacity === "number" &&
    typeof stored.visible === "boolean" &&
    typeof stored.disableHit === "boolean"
  ) {
    return stored as Original;
  }
  return undefined;
}

function originalOf(item: Styled): Original {
  return {
    strokeColor: item.style.strokeColor,
    strokeOpacity: item.style.strokeOpacity,
    fillOpacity: item.style.fillOpacity,
    visible: item.visible,
    disableHit: item.disableHit ?? false,
  };
}

/** What the zone should look like now; its own fill comes back (from `original`) unless it's hidden. */
function wantedLook(height: number, mode: TerrainVisibility, original: Original) {
  const bandSet = bandSetFromMetadata(metadata);
  const strokeColor = height ? getColorString(markerBaseColor(height, bandSet, getStoredTheme())) : GROUND_STROKE;
  if (mode === "hidden") {
    return { strokeColor, strokeOpacity: 0, fillOpacity: 0, visible: true, disableHit: true };
  }
  return {
    strokeColor,
    strokeOpacity: 1,
    fillOpacity: original.fillOpacity,
    visible: mode === "everyone",
    disableHit: original.disableHit,
  };
}

function lookOf(item: Styled) {
  return {
    strokeColor: item.style.strokeColor,
    strokeOpacity: item.style.strokeOpacity,
    fillOpacity: item.style.fillOpacity,
    visible: item.visible,
    disableHit: item.disableHit ?? false,
  };
}

const sameLook = (a: ReturnType<typeof lookOf>, b: ReturnType<typeof lookOf>) =>
  a.strokeColor === b.strokeColor &&
  a.strokeOpacity === b.strokeOpacity &&
  a.fillOpacity === b.fillOpacity &&
  a.visible === b.visible &&
  a.disableHit === b.disableHit;

/** What a shape needs written, or null when it's already right. */
function plan(item: Item): { look: ReturnType<typeof lookOf>; original: Original | undefined } | null {
  if (!styled(item)) {
    return null;
  }
  const settings = globalSettingsFromMetadata(metadata);
  const height = getTerrainHeight(item);
  const original = getOriginal(item);
  const isTerrain = terrainOn(settings, gridType) && height !== undefined && canBeTerrain(item);
  if (!isTerrain) {
    // Put back as it was, and forget it.
    return original ? { look: original, original: undefined } : null;
  }
  const mode = terrainVisibility(settings);
  const base = original ?? originalOf(item);
  // A fill changed by hand while shown is its own now.
  const keep = mode === "hidden" ? base : { ...base, fillOpacity: item.style.fillOpacity };
  const look = wantedLook(height, mode, keep);
  const sameOriginal = original && JSON.stringify(original) === JSON.stringify(keep);
  return sameLook(lookOf(item), look) && sameOriginal ? null : { look, original: keep };
}

async function reconcile() {
  if (!isGm || !sceneReady) {
    return;
  }
  const ids = items.filter((item) => plan(item) !== null).map((item) => item.id);
  if (ids.length === 0) {
    return;
  }
  await OBR.scene.items.updateItems(ids, (drafts) => {
    for (const draft of drafts) {
      // Planned again from the draft: the shape as it is now.
      const next = plan(draft);
      if (!next || !styled(draft)) {
        continue;
      }
      draft.style.strokeColor = next.look.strokeColor;
      draft.style.strokeOpacity = next.look.strokeOpacity;
      draft.style.fillOpacity = next.look.fillOpacity;
      draft.visible = next.look.visible;
      draft.disableHit = next.look.disableHit;
      if (next.original) {
        draft.metadata[ORIGINAL_KEY] = next.original;
      } else {
        delete draft.metadata[ORIGINAL_KEY];
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
        console.error("Rising Ranges: failed to style terrain", error);
      }
    }
    running = false;
  })();
}

async function loadScene() {
  const [nextMetadata, nextItems, nextGridType] = await Promise.all([
    OBR.scene.getMetadata(),
    OBR.scene.items.getItems(),
    getGridType(),
  ]);
  gridType = nextGridType;
  metadata = nextMetadata;
  items = nextItems;
  sceneReady = true;
  schedule();
}

export async function startTerrainStyle() {
  OBR.scene.onReadyChange((ready) => {
    sceneReady = false;
    if (ready) {
      loadScene().catch((error) => console.error("Rising Ranges: failed to load terrain", error));
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
  OBR.scene.grid.onChange((grid) => {
    gridType = grid.type;
    schedule();
  });
  // The outline colors are the GM's theme's.
  window.addEventListener("storage", (event) => {
    if (event.key && THEME_STORAGE_KEYS.includes(event.key)) {
      schedule();
    }
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
