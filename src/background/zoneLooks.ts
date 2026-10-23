import OBR, { isCurve, isPath, isShape, type Item } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { isPlainObject } from "../util/isPlainObject";

// The old terrain zones (shapes tagged with a height) were drawn by
// restyling the shapes themselves: an outline in their height's colour,
// hidden or see-through by the terrain's visibility, what they were kept in
// their metadata. The terrain is the reliefs' now (the zones can be brought
// into one, see relief/zones.ts): each such shape is put back as it was,
// once, by the GM's client (they're writes to the shapes).

const ORIGINAL_KEY = getPluginId("terrainStyle");

type Original = { strokeColor: string; strokeOpacity: number; fillOpacity: number; visible: boolean; disableHit: boolean };

function originalOf(item: Item): Original | undefined {
  const stored = item.metadata[ORIGINAL_KEY];
  if (
    (isShape(item) || isCurve(item) || isPath(item)) &&
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

let running = false;

async function restore(items: Item[]) {
  const ids = items.filter((item) => item.metadata[ORIGINAL_KEY] !== undefined).map((item) => item.id);
  if (running || ids.length === 0 || (await OBR.player.getRole()) !== "GM") {
    return;
  }
  running = true;
  try {
    await OBR.scene.items.updateItems(ids, (drafts) => {
      for (const draft of drafts) {
        const original = originalOf(draft);
        if (original && (isShape(draft) || isCurve(draft) || isPath(draft))) {
          draft.style.strokeColor = original.strokeColor;
          draft.style.strokeOpacity = original.strokeOpacity;
          draft.style.fillOpacity = original.fillOpacity;
          draft.visible = original.visible;
          draft.disableHit = original.disableHit;
        }
        delete draft.metadata[ORIGINAL_KEY];
      }
    });
  } catch (error) {
    console.error("Rising Ranges: the old terrain zones couldn't be put back as they were", error);
  } finally {
    running = false;
  }
}

export async function startZoneLooks() {
  OBR.scene.onReadyChange((ready) => {
    if (ready) {
      OBR.scene.items.getItems().then(restore, () => {});
    }
  });
  // A shape pasted from another scene, or brought back by an undo.
  OBR.scene.items.onChange((items) => void restore(items));
  if (await OBR.scene.isReady()) {
    await restore(await OBR.scene.items.getItems());
  }
}
