import { fillFromPixels } from "./view/bridgeFill";
import type { FillAnswer, FillMessage } from "./fillJob";

// Bridges' fills worked out away from the page (see fillJob): the map's pixels over each one's box in,
// its fill out, handed back without copying it.

self.onmessage = (event: MessageEvent<FillMessage>) => {
  const { id, shape, bytes, frame, grow } = event.data;
  try {
    const fill = fillFromPixels(shape, bytes, frame, grow);
    (self as unknown as Worker).postMessage({ id, fill } satisfies FillAnswer, [fill.pixels.buffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, failed: String(error) } satisfies FillAnswer);
  }
};
