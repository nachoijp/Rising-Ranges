import OBR, { type Item } from "@owlbear-rodeo/sdk";
import { isTemplateItem, isTemplateLook, setTemplateEffect, templateEffect, templateLookKey, templateOf } from "../vistazo/templateItems";

// The templates' moving looks on the map (see vistazo/templateItems.ts): Owlbear keeps effects local,
// so each client puts its own on every template the scene has, attached to it (they move and turn
// with it), told again when its shape changes (a cone tilted) or the grid's size does, taken away with
// it. A player's client puts none on a hidden one (its outline is barely seen; the look would show it);
// the GM's does, as Owlbear shows the GM what's hidden.

/** Each template's look here: its effect's id, what it was told, and its place among the drawings. */
const looks = new Map<string, { id: string; key: string; zIndex: number }>();
let queue: Promise<void> = Promise.resolve();
let dpi = 150;
let gm = false;
/** The scene's items as last seen (a grid change syncs again from them). */
let lastItems: Item[] = [];
/** What the looks were last made from (nothing else changed: nothing to do). */
let lastKey = "";

/** Each look wanted: its template's item, what it's told, and above it. */
function wantedOf(items: Item[]) {
  const wanted = new Map<string, { item: Item; key: string; zIndex: number }>();
  for (const item of items) {
    if (isTemplateItem(item) && (item.visible || gm)) {
      wanted.set(item.id, { item, key: templateLookKey(templateOf(item, () => 0, true)!, dpi), zIndex: item.zIndex + 1 });
    }
  }
  return wanted;
}

async function sync(items: Item[]) {
  const wanted = wantedOf(items);
  const key = JSON.stringify([dpi, ...[...wanted].map(([id, want]) => [id, want.key, want.zIndex])]);
  if (key === lastKey) {
    return;
  }
  lastKey = key;
  const gone = [...looks].filter(([parent]) => !wanted.has(parent));
  if (gone.length > 0) {
    for (const [parent] of gone) looks.delete(parent);
    await OBR.scene.local.deleteItems(gone.map(([, look]) => look.id)).catch(() => {});
  }
  const changed = [...wanted].filter(([parent, want]) => {
    const look = looks.get(parent);
    return look && (look.key !== want.key || look.zIndex !== want.zIndex);
  });
  if (changed.length > 0) {
    const byLook = new Map(changed.map(([parent, want]) => [looks.get(parent)!.id, want]));
    await OBR.scene.local
      .updateItems([...byLook.keys()], (drafts) => {
        for (const draft of drafts) {
          const want = byLook.get(draft.id)!;
          setTemplateEffect(draft, templateOf(want.item, () => 0, true)!, dpi);
          draft.zIndex = want.zIndex;
        }
      })
      .catch((error) => console.error("Rising Ranges: couldn't update a template's look", error));
    for (const [parent, want] of changed) looks.set(parent, { id: looks.get(parent)!.id, key: want.key, zIndex: want.zIndex });
  }
  const added = [...wanted].filter(([parent]) => !looks.has(parent));
  if (added.length > 0) {
    const effects = added.map(([, want]) => ({ ...templateEffect(templateOf(want.item, () => 0, true)!, dpi), zIndex: want.zIndex }));
    try {
      await OBR.scene.local.addItems(effects);
      added.forEach(([parent, want], i) => looks.set(parent, { id: effects[i].id, key: want.key, zIndex: want.zIndex }));
    } catch (error) {
      // Made again at the next change.
      lastKey = "";
      console.error("Rising Ranges: couldn't put the templates' looks on the map", error);
    }
  }
}

/** One at a time, in order (each from the scene as it is then). */
function later(items: Item[]) {
  lastItems = items;
  queue = queue.then(() => sync(items)).catch(() => {});
}

async function sceneOpened() {
  looks.clear();
  lastKey = "";
  [dpi, gm] = await Promise.all([OBR.scene.grid.getDpi(), OBR.player.getRole().then((role) => role === "GM")]);
  // Left from before (the page reloaded with the scene open): made again.
  const left = await OBR.scene.local.getItems(isTemplateLook);
  if (left.length > 0) {
    await OBR.scene.local.deleteItems(left.map((item) => item.id)).catch(() => {});
  }
  later(await OBR.scene.items.getItems());
}

export async function startTemplateLooks() {
  OBR.scene.onReadyChange((ready) => {
    if (ready) {
      queue = queue.then(sceneOpened).catch(() => {});
    } else {
      looks.clear();
      lastKey = "";
    }
  });
  OBR.scene.items.onChange(later);
  // The grid's size (the looks are drawn in it) and the player's role (the GM sees the hidden ones).
  OBR.scene.grid.onChange((grid) => {
    if (grid.dpi !== dpi) {
      dpi = grid.dpi;
      later(lastItems);
    }
  });
  OBR.player.onChange((player) => {
    if ((player.role === "GM") !== gm) {
      gm = player.role === "GM";
      later(lastItems);
    }
  });
  if (await OBR.scene.isReady()) {
    queue = queue.then(sceneOpened).catch(() => {});
  }
}
