import type { AttachmentBehavior, Item } from "@owlbear-rodeo/sdk";

// Items attached to others (attachedTo), as Owlbear treats them: each takes its parent's position,
// visibility, lock, deletion, copying… unless it's set not to (the Constraints of its menu:
// disableAttachmentBehavior). Visibility and lock as Owlbear shows them, not as stored.

/** Whether an attached item follows its parent in `behavior` (not if it was set not to). */
export function follows(item: Item, behavior: AttachmentBehavior): boolean {
  return !item.disableAttachmentBehavior?.includes(behavior);
}

/**
 * The items attached to one, and to those, and so on (not itself). With `behavior`: only along the
 * attachments that follow their parent in it (one that doesn't takes none of its own along).
 */
export function attachedUnder(items: Item[], id: string, behavior?: AttachmentBehavior): Set<string> {
  const under = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of items) {
      if (item.attachedTo && (item.attachedTo === id || under.has(item.attachedTo)) && !under.has(item.id) && (!behavior || follows(item, behavior))) {
        under.add(item.id);
        grew = true;
      }
    }
  }
  return under;
}

/** An item's parents up its chain of attachments, while each follows the next in `behavior` (a loop stops it). */
function* inheritedFrom(byId: Map<string, Item>, item: Item, behavior: AttachmentBehavior): Generator<Item> {
  const seen = new Set([item.id]);
  let at = item;
  while (at.attachedTo && follows(at, behavior)) {
    const parent = byId.get(at.attachedTo);
    if (!parent || seen.has(parent.id)) {
      return;
    }
    seen.add(parent.id);
    yield parent;
    at = parent;
  }
}

/** Whether an item is shown to the players: itself visible, and every parent it follows in that too. */
export function visibleNow(byId: Map<string, Item>, item: Item): boolean {
  if (!item.visible) {
    return false;
  }
  for (const parent of inheritedFrom(byId, item, "VISIBLE")) {
    if (!parent.visible) {
      return false;
    }
  }
  return true;
}

/** Whether an item is locked: itself, or a parent it follows in that. */
export function lockedNow(byId: Map<string, Item>, item: Item): boolean {
  if (item.locked) {
    return true;
  }
  for (const parent of inheritedFrom(byId, item, "LOCKED")) {
    if (parent.locked) {
      return true;
    }
  }
  return false;
}
