import OBR, { isCurve, isPath, isShape, type Item } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { isPlainObject } from "../util/isPlainObject";
import { terrainZones } from "../terrain/terrain";
import { reliefsIn } from "../relief/sceneItems";
import { translate } from "../i18n/translate";
import { languageFromMetadata } from "../i18n/language";

// The old terrain zones (shapes tagged with a height) were drawn by
// restyling the shapes themselves: an outline in their height's colour,
// hidden or see-through by the terrain's visibility, what they were kept in
// their metadata. The terrain is the reliefs' now (the zones can be brought
// into one, see relief/zones.ts): each such shape gets its look back, once,
// by the GM's client (they're writes to the shapes). Not its visibility: one
// hidden from the players stays hidden (a pit, a secret ledge), whatever it
// was before it was terrain.

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

/** The scenes (by their map images) whose GM was told of their old zones, on this device. */
const TOLD_KEY = "rising-ranges/old-zones-told";

/**
 * A scene with old zones and no relief measures as flat now (only reliefs are): its GM told so, once
 * a scene, and where to bring them in (the editor's "Traer zonas").
 */
async function tellOldZones(items: Item[]) {
  if (terrainZones(items).length === 0 || reliefsIn(items).size > 0 || (await OBR.player.getRole()) !== "GM") {
    return;
  }
  const scene = items
    .filter((item) => item.type === "IMAGE" && item.layer === "MAP")
    .map((item) => item.id)
    .sort()
    .join(",");
  let told: string[] = [];
  try {
    told = JSON.parse(localStorage.getItem(TOLD_KEY) ?? "[]");
  } catch {
    // Not told yet, then.
  }
  if (told.includes(scene)) {
    return;
  }
  const language = languageFromMetadata(await OBR.scene.getMetadata());
  void OBR.notification.show(translate(language, "relief.oldZones"), "WARNING");
  try {
    localStorage.setItem(TOLD_KEY, JSON.stringify([...told, scene].slice(-200)));
  } catch {
    // Told again next time.
  }
}

const sceneRead = (items: Item[]) => {
  void restore(items);
  tellOldZones(items).catch(() => {});
};

export async function startZoneLooks() {
  OBR.scene.onReadyChange((ready) => {
    if (ready) {
      OBR.scene.items.getItems().then(sceneRead, () => {});
    }
  });
  // A shape pasted from another scene, or brought back by an undo.
  OBR.scene.items.onChange((items) => void restore(items));
  if (await OBR.scene.isReady()) {
    sceneRead(await OBR.scene.items.getItems());
  }
}
