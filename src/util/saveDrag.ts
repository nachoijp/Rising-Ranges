import OBR, { type Item, type Vector2 } from "@owlbear-rodeo/sdk";
import type { DragPath } from "./dragPath";

// Owlbear refuses bursts of scene writes ("Too many requests"). The waits
// grow, so a short limit costs little and a longer one still gets a chance.
const SAVE_RETRY_DELAYS_MS = [50, 100, 200];

/** A write, tried again after each wait while it's refused; throws the last refusal if every try fails. */
async function retried(write: () => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    try {
      await write();
      return;
    } catch (error) {
      if (attempt >= SAVE_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, SAVE_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * Saves a token dragged by an extension where it's let go (`final`, as the
 * drag's interaction has it): along the way it was dragged (see
 * dragPath.ts), then at its end with its attachments, all brought to the
 * top. Each write is retried while Owlbear refuses it; a step on the way
 * that still fails is given up for the end itself. Returns where it landed,
 * or null if it couldn't be saved (ending the drag then puts it back where
 * it started). The drag's interaction is the caller's to end.
 */
export async function saveDraggedToken(final: Item, path: DragPath): Promise<Vector2 | null> {
  try {
    const dpi = await OBR.scene.grid.getDpi();
    for (const step of path.steps(final.position, dpi * 0.3).slice(0, -1)) {
      await retried(() =>
        OBR.scene.items.updateItems([final.id], (items) => {
          for (const item of items) {
            item.position = step;
          }
        })
      );
    }
  } catch (error) {
    console.warn("Rising Ranges: couldn't save a dragged token along its way, saving where it ends", error);
  }
  try {
    await retried(async () => {
      const withAttachments = await OBR.scene.items.getItemAttachments([final.id]);
      withAttachments.sort((a, b) => a.zIndex - b.zIndex);
      await OBR.scene.items.updateItems(withAttachments, (items) => {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.id === final.id) {
            item.position = final.position;
          }
          if (!item.disableAutoZIndex) {
            item.zIndex = Date.now() + i;
          }
        }
      });
    });
    return final.position;
  } catch (error) {
    console.error("Rising Ranges: failed to save the dragged token's position", error);
    return null;
  }
}
