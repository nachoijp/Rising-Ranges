import OBR, { type Item, type Vector2 } from "@owlbear-rodeo/sdk";
import { stopAtWalls, wallReach } from "../vistazo/fog";
import type { DragPath } from "./dragPath";

// Owlbear refuses bursts of scene writes ("Too many requests"). The waits
// grow, so a short limit costs little and a longer one still gets a chance;
// the end's waits longer still (it's what matters).
const SAVE_RETRY_DELAYS_MS = [100, 250, 500];
const END_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000];
/** A pause between the steps' writes: a few in a row, not a burst. */
const STEP_PAUSE_MS = 40;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A write, tried again after each wait while it's refused; throws the last refusal if every try fails. */
async function retried(write: () => Promise<void>, delays = SAVE_RETRY_DELAYS_MS) {
  for (let attempt = 0; ; attempt++) {
    try {
      await write();
      return;
    } catch (error) {
      if (attempt >= delays.length) {
        throw error;
      }
      await wait(delays[attempt]);
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
    // The walls Owlbear stops a token at (the scene's, and this client's own: Smoke & Spectre's), as near
    // as it lets it come (see wallReach); none for a token they don't stop (no light, hidden).
    const [items, local] = final.visible ? await Promise.all([OBR.scene.items.getItems(), OBR.scene.local.getItems().catch(() => [])]) : [[], []];
    const reach = wallReach(final, items, local);
    const clear = (from: Vector2, to: Vector2) => {
      if (reach === null) {
        return true;
      }
      const reached = stopAtWalls(from, to, items, local, reach);
      if (Math.hypot(reached.x - to.x, reached.y - to.y) < 0.5) {
        return true;
      }
      // From within a wall's reach already (a drag on the map, which isn't kept off them: see
      // createMeasureTool.ts), stopped at once: not through a wall is enough, or every point of a way
      // along it would be a step of its own (as many writes).
      if (Math.hypot(reached.x - from.x, reached.y - from.y) < 0.5) {
        const crossed = stopAtWalls(from, to, items, local, 0);
        return Math.hypot(crossed.x - to.x, crossed.y - to.y) < 0.5;
      }
      return false;
    };
    const steps = path.steps(final.position, clear);
    for (const step of steps.slice(0, -1)) {
      await retried(() =>
        OBR.scene.items.updateItems([final.id], (items) => {
          for (const item of items) {
            item.position = step;
          }
        })
      );
      await wait(STEP_PAUSE_MS);
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
    }, END_RETRY_DELAYS_MS);
    return final.position;
  } catch (error) {
    console.error("Rising Ranges: failed to save the dragged token's position", error);
    return null;
  }
}
