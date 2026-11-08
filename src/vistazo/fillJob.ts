import type { MultiPolygon } from "polygon-clipping";
import { fillFromPixels, type BridgeFill } from "./view/bridgeFill";

// The page's end of the bridges' fills' worker (see fillWorker): a fill asked for, answered once it's
// worked out there, the page drawing meanwhile. Where workers can't be made (or it died), worked out
// on the page, as before.

export type FillFrame = { x0: number; y0: number; step: number; cols: number; rows: number };
export type FillMessage = { id: number; shape: MultiPolygon; bytes: Uint8ClampedArray; frame: FillFrame; grow: number };
export type FillAnswer = { id: number; fill: BridgeFill } | { id: number; failed: string };

export class FillJobs {
  private worker: Worker | null = null;
  private next = 0;
  private readonly waiting = new Map<number, (fill: BridgeFill | null) => void>();
  private dead = false;

  /** A fill from the map's pixels over its box (see fillFromPixels): away from the page if it can be. */
  ask(shape: MultiPolygon, bytes: Uint8ClampedArray, frame: FillFrame, grow: number): Promise<BridgeFill | null> {
    const worker = this.start();
    if (!worker) {
      return Promise.resolve(fillFromPixels(shape, bytes, frame, grow));
    }
    const id = ++this.next;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      worker.postMessage({ id, shape, bytes, frame, grow } satisfies FillMessage, [bytes.buffer]);
    });
  }

  private start(): Worker | null {
    if (this.worker || this.dead) {
      return this.worker;
    }
    try {
      const worker = new Worker(new URL("./fillWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<FillAnswer>) => {
        const resolve = this.waiting.get(event.data.id);
        this.waiting.delete(event.data.id);
        resolve?.("fill" in event.data ? event.data.fill : null);
      };
      // Failed to load or died: what's waiting gets nothing (drawn as it is), what follows is worked out here.
      worker.onerror = worker.onmessageerror = (event: Event) => {
        event.preventDefault();
        this.dead = true;
        this.worker = null;
        for (const resolve of this.waiting.values()) {
          resolve(null);
        }
        this.waiting.clear();
      };
      this.worker = worker;
    } catch {
      this.dead = true;
    }
    return this.worker;
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
  }
}
