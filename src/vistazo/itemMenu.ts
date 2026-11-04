import OBR, { type Item } from "@owlbear-rodeo/sdk";
import { isTokenHeightMarker } from "../tokenHeight/markers";
import { attachedUnder } from "../util/attachments";

export { attachedUnder };

/**
 * What the Glance's item menu (a right click on a token or a prop) does to the item, as Owlbear's own
 * menu would: through the scene's items, so every view (the map's too) shows it.
 */

/** Whether `child` can be attached to `parent`: another item, not one attached to it however (they'd go round). */
export async function canAttach(child: string, parent: string): Promise<boolean> {
  if (child === parent) {
    return false;
  }
  return !attachedUnder(await OBR.scene.items.getItems(), child).has(parent);
}

/** Attaches an item to another (null: detaches it). */
export async function attach(id: string, to: string | null) {
  await OBR.scene.items.updateItems([id], ([item]) => {
    item.attachedTo = to ?? undefined;
  });
}

export async function setLocked(id: string, locked: boolean) {
  await OBR.scene.items.updateItems([id], ([item]) => {
    item.locked = locked;
  });
}

export async function setVisible(id: string, visible: boolean) {
  await OBR.scene.items.updateItems([id], ([item]) => {
    item.visible = visible;
  });
}

/**
 * A copy of an item, `by` scene px aside, with what's attached to it (copied too, attached to the copy)
 * but what's set not to be copied with it (Copy, in its Constraints); not its height marker (the
 * marker's own code puts a new one under the copy). The copy's id.
 */
export async function duplicate(id: string, by: { x: number; y: number }): Promise<string | null> {
  const items = await OBR.scene.items.getItems();
  const under = attachedUnder(items, id, "COPY");
  const copied = items.filter((item) => (item.id === id || under.has(item.id)) && !isTokenHeightMarker(item));
  if (!copied.some((item) => item.id === id)) {
    return null;
  }
  const ids = new Map(copied.map((item) => [item.id, crypto.randomUUID()]));
  const now = Date.now();
  const copies = copied.map(
    (item, k): Item => ({
      ...structuredClone(item),
      id: ids.get(item.id)!,
      position: { x: item.position.x + by.x, y: item.position.y + by.y },
      attachedTo: item.id === id ? item.attachedTo : (ids.get(item.attachedTo ?? "") ?? item.attachedTo),
      // Over everything on its layer, in the order they were.
      zIndex: now + k,
    })
  );
  await OBR.scene.items.addItems(copies);
  return ids.get(id)!;
}

/** Deletes an item, with what's attached to it (as Owlbear's own Delete) but what's set not to go with it (Delete, in its Constraints). */
export async function remove(id: string) {
  await OBR.scene.items.deleteItems([id, ...attachedUnder(await OBR.scene.items.getItems(), id, "DELETE")]);
}
