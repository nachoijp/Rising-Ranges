import OBR, { type Vector2 } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";

// A token dragged with the Medición tool, as it moves: Owlbear only tells
// extensions where a token is once it's dropped, but the tool moving it
// knows. It tells the Vistazo (another page of this extension, on this
// client) with a local broadcast, a few dozen times a second.

export const LIVE_DRAG_CHANNEL = getPluginId("vistazo/drag");

/** `position`: the token's position now; null once it's dropped. */
export type LiveDrag = { tokenId: string; position: Vector2 | null };

const INTERVAL_MS = 33;
let lastSent = 0;
let pending: LiveDrag | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function send(message: LiveDrag) {
  lastSent = performance.now();
  OBR.broadcast.sendMessage(LIVE_DRAG_CHANNEL, message, { destination: "LOCAL" }).catch(() => {});
}

/** At most one message every INTERVAL_MS, the latest position always sent last; a drop goes at once. */
export function sendLiveDrag(message: LiveDrag) {
  clearTimeout(timer);
  if (!message.position) {
    pending = null;
    send(message);
    return;
  }
  const wait = INTERVAL_MS - (performance.now() - lastSent);
  if (wait <= 0) {
    send(message);
    return;
  }
  pending = message;
  timer = setTimeout(() => {
    if (pending) {
      send(pending);
      pending = null;
    }
  }, wait);
}
