import { type Image, type Path, type Vector2 } from "@owlbear-rodeo/sdk";
import { BandSet } from "../engine/types";
import {
  clearTokenHeightMarker,
  setTokenHeightMarker,
  type MarkerLook,
} from "../tokenHeight/markers";

// Writes the height marker of the token a Medición was started on, as Z/X
// change it and when the Medición ends. Each request carries everything the
// write needs, so it doesn't depend on the Medición still being active.

/** One write: set the token's height, or clear its marker when `height` is 0. */
export type OriginMarkerRequest = {
  token: Image;
  height: number;
  bandSet: BandSet;
  dpi: number;
  look: MarkerLook;
  attempt: number;
  /** Mid-drag: where the token is still stored (`token` is where it's being dragged). */
  draggedFrom?: Vector2;
};

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;

// The token's marker as of the last confirmed write, so a burst of Z/X
// presses on the same token doesn't look it up before every write. Keyed by
// token: writes can land after a new Medición started on another token.
// Cleared after a failed write — it may have landed anyway, and trusting a
// stale "no marker" would add a duplicate.
let cache: { tokenId: string; markers: Path[] } | undefined;
// Counts writes as they start, so a marker list fetched earlier can tell
// whether a write may have changed things since (see seedCache).
let writesStarted = 0;

// At most one write in flight, plus the latest request waiting behind it:
// a fast burst of presses writes only the first and the last.
let latest: OriginMarkerRequest | null = null;
let tail: Promise<void> = Promise.resolve();
let draining = false;

export function writesSoFar() {
  return writesStarted;
}

/**
 * Seeds the cache from a marker list fetched when `writesBeforeFetch` writes
 * had started — unless a write started since, which could make it stale.
 */
export function seedCache(tokenId: string, markers: Path[], writesBeforeFetch: number) {
  cache = writesBeforeFetch === writesStarted ? { tokenId, markers } : undefined;
}

export function forgetCache() {
  cache = undefined;
}

/** Returns whether the write was confirmed. */
async function write(request: OriginMarkerRequest): Promise<boolean> {
  const tokenId = request.token.id;
  const known = cache?.tokenId === tokenId ? cache.markers : undefined;
  writesStarted++;
  try {
    const from = request.draggedFrom;
    const to = request.token.position;
    const drag = from && (from.x !== to.x || from.y !== to.y) ? { from, to } : undefined;
    // Mid-drag, even the ground is written: see TokenHeightState.
    if (request.height !== 0 || drag) {
      const markers = await setTokenHeightMarker(
        [request.token],
        request.height,
        request.bandSet,
        request.dpi,
        known,
        request.look,
        drag
      );
      cache = { tokenId, markers };
    } else {
      await clearTokenHeightMarker([tokenId], known);
      cache = { tokenId, markers: [] };
    }
    return true;
  } catch (error) {
    console.error("Rising Ranges: failed to sync token height marker", error);
    cache = undefined;
    return false;
  }
}

/**
 * Queues a write. Resolves once every queued write has settled. A failed
 * write is retried a couple of times, unless a newer request replaced it.
 */
export function enqueueOriginMarkerWrite(request: OriginMarkerRequest | null): Promise<void> {
  if (!request) {
    return tail;
  }
  latest = request;
  if (draining) {
    return tail;
  }
  draining = true;
  tail = (async () => {
    for (;;) {
      const next: OriginMarkerRequest | null = latest;
      if (!next) {
        break;
      }
      latest = null;
      const ok = await write(next);
      if (!ok && !latest && next.attempt + 1 < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        if (!latest) {
          latest = { ...next, attempt: next.attempt + 1 };
        }
      }
    }
    draining = false;
  })();
  return tail;
}

/** Puts a token's marker back as it was (a cancelled Medición), after any queued write — which would otherwise overwrite it. */
export async function restoreOriginMarker(request: OriginMarkerRequest | null) {
  if (!request) {
    return;
  }
  await tail;
  await write(request);
}
