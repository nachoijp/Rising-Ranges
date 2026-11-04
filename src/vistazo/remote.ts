import type { Vector2 } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";

// What someone else is measuring and moving, shown in the Vistazo of every other client, as their map
// shows it (the Medición's mirror, see background/measureMirror.ts; the token moving, which Owlbear
// draws on the map but tells no extension of till it's dropped).
//
// - The token being dragged (with the Medición, or in a Vistazo) goes out over REMOTE_DRAG_CHANNEL, a
//   few times a second, and only while some other client has its Vistazo open (see WATCHING_KEY): a
//   Medición's drag is everyday, a Vistazo watching it isn't. Only the latest position matters: a lost
//   one is made up for by the next (none is sent again), an "end" is retried. Never a hidden token's.
// - So does a Vistazo's free point (the Medición from a point of the map's): while it's there, and
//   again every couple of seconds, for whoever opens their Vistazo later.
// - What's measured from (a token, or a point) comes from the Medición's own mirror, which every client
//   gets anyway; a Vistazo's drag, which has none, is measured from the token dragged.
// - Bursts are spaced (Owlbear rejects them: "RateLimitHit"), wider for the rest of the session once
//   it does, as the mirror's. What's held still is sent again now and then, so a receiver can tell a
//   sender that's gone (closed, crashed: no "end") from one that isn't moving: see DRAG_TIMEOUT_MS.

export const REMOTE_DRAG_CHANNEL = getPluginId("vistazo/remoteDrag");
/** The Medición's mirror (see measureMirror.ts): listened to here, never sent. */
export const MIRROR_CHANNEL = getPluginId("measureMirror");
/**
 * From this client's map to its Vistazo, on this client only: what its own Medición measures from while
 * it's up (null: it's over); the Medición fija shown on this screen (the room's, or this GM's secret
 * one; null: none); and the Vistazo's hello, opened meanwhile, answered with both.
 */
export const OWN_CHANNEL = getPluginId("vistazo/ownMedicion");
/** A Medición fija: where it measures from (px), the Origen's height over its ground and radius (grid units, 0: a point). */
export type Fixed = { center: Vector2; height: number; radius: number };
export type OwnMessage = { type: "own"; measured: Measured | null } | { type: "fixed"; fixed: Fixed | null } | { type: "hello" };
/** In a player's metadata: whether their Vistazo is open (the drags are only sent to be seen). */
export const WATCHING_KEY = getPluginId("vistazo/watching");

/** A free point measured from: scene px, and its own height over the ground there (grid units). */
export type RemotePoint = { x: number; y: number; own: number };

/**
 * `drag`: one drag's id (a new one, a new drag: an "end" of another is old news); an end's `at`: where
 * it was left (saved there), or null: back where it began. A point's `id`: one point's (put down, moved,
 * taken away: null).
 */
export type RemoteDrag =
  | { type: "move"; drag: string; tokenId: string; position: Vector2 }
  | { type: "end"; drag: string; tokenId: string; at: Vector2 | null }
  | { type: "point"; id: string; point: RemotePoint | null };

export const DRAG_INTERVAL_MS = 120;
export const DRAG_BACKOFF_MS = 300;
/** A drag held still, sent again this often. */
export const DRAG_KEEPALIVE_MS = 1000;
/** Nothing heard of a drag for this long: its sender is gone, it's dropped. */
export const DRAG_TIMEOUT_MS = 3500;
/** A drag not moved for this long is taken for one whose end was never told (a page that failed): over. */
export const DRAG_IDLE_MS = 120000;
/** A free point, sent again this often while it's there; and dropped if not heard of for this long. */
export const POINT_HEARTBEAT_MS = 2000;
export const POINT_TIMEOUT_MS = 6000;

export function isRateLimitError(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : JSON.stringify(error);
  return /rate ?limit|too many/i.test(text ?? "");
}

type Send = (message: RemoteDrag) => Promise<unknown>;

const newId = () => Math.random().toString(36).slice(2, 10);

/**
 * This page's drag (one at a time: a new one ends the last) and free point, out to the others, one
 * message at a time. `watched`: whether anyone's watching (asked before each: one who opens their
 * Vistazo meanwhile gets them from then on).
 */
export class DragSender {
  private drag: { id: string; tokenId: string; position: Vector2 | null; sent: boolean; moved: number } | null = null;
  private dirty = false;
  private lastDragSent = -Infinity;
  private pt: { id: string; value: RemotePoint; dirty: boolean; sent: boolean; lastSent: number } | null = null;
  private interval = DRAG_INTERVAL_MS;
  private lastSent = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly send: Send,
    private readonly watched: () => boolean,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** The token dragged is at `position` now; `shared`: whether it may be seen (not a hidden token). */
  move(tokenId: string, position: Vector2, shared: boolean) {
    if (!shared) {
      // Hidden now (or always): whatever was sent of it ends.
      if (this.drag?.tokenId === tokenId) {
        this.end(tokenId);
      }
      return;
    }
    if (this.drag && this.drag.tokenId !== tokenId) {
      this.end(this.drag.tokenId);
    }
    this.drag ??= { id: newId(), tokenId, position: null, sent: false, moved: 0 };
    this.drag.position = { x: position.x, y: position.y };
    this.drag.moved = this.now();
    this.dirty = true;
    this.schedule();
    this.keepAlive();
  }

  /**
   * The drag over: dropped, and saved at `at` (the scene has it there); null, back where it began.
   * Nothing goes if nothing was sent.
   */
  end(tokenId: string, at: Vector2 | null = null) {
    const drag = this.drag;
    if (!drag || drag.tokenId !== tokenId) {
      return;
    }
    this.drag = null;
    this.dirty = false;
    this.idle();
    if (drag.sent) {
      this.out({ type: "end", drag: drag.id, tokenId, at: at && { x: at.x, y: at.y } }, 0);
    }
  }

  /** The free point, where it is now (moved, its height changed), or taken away (null). */
  point(value: RemotePoint | null) {
    if (!value) {
      const pt = this.pt;
      this.pt = null;
      this.idle();
      if (pt?.sent) {
        this.out({ type: "point", id: pt.id, point: null }, 0);
      }
      return;
    }
    this.pt ??= { id: newId(), value, dirty: true, sent: false, lastSent: -Infinity };
    this.pt.value = { x: value.x, y: value.y, own: value.own };
    this.pt.dirty = true;
    this.schedule();
    this.keepAlive();
  }

  /** Now and then while there's a drag or a point: sent again if it's been a while (see DRAG_TIMEOUT_MS); a drag left for good, ended. */
  private keepAlive() {
    this.keepalive ??= setInterval(() => {
      const now = this.now();
      if (this.drag && now - this.drag.moved > DRAG_IDLE_MS) {
        this.end(this.drag.tokenId, null);
      } else if (this.drag && now - this.lastDragSent >= DRAG_KEEPALIVE_MS) {
        this.dirty = true;
      }
      if (this.pt && now - this.pt.lastSent >= POINT_HEARTBEAT_MS) {
        this.pt.dirty = true;
      }
      if (this.dirty || this.pt?.dirty) {
        this.schedule();
      }
    }, DRAG_KEEPALIVE_MS / 2);
  }

  /** Nothing left to send: the timers stop. */
  private idle() {
    if (this.drag || this.pt) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }

  private schedule() {
    if (this.timer) {
      return;
    }
    const wait = Math.max(0, this.lastSent + this.interval - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  /** One message: the drag's latest, else the point's; the other after the next gap. Nobody watching: kept till someone is. */
  private flush() {
    if (!this.watched()) {
      return;
    }
    const drag = this.drag;
    const pt = this.pt;
    if (drag?.position && this.dirty) {
      this.dirty = false;
      drag.sent = true;
      this.lastDragSent = this.now();
      this.out({ type: "move", drag: drag.id, tokenId: drag.tokenId, position: drag.position }, 0);
    } else if (pt?.dirty) {
      pt.dirty = false;
      pt.sent = true;
      pt.lastSent = this.now();
      this.out({ type: "point", id: pt.id, point: pt.value }, 0);
    }
    if (this.dirty || this.pt?.dirty) {
      this.schedule();
    }
  }

  private out(message: RemoteDrag, attempt: number) {
    this.lastSent = this.now();
    this.send(message).catch((error) => {
      if (!isRateLimitError(error)) {
        console.warn("Rising Ranges: couldn't send a drag to the other Vistazos", error);
        return;
      }
      this.interval = DRAG_BACKOFF_MS;
      if (message.type === "end" || (message.type === "point" && !message.point)) {
        // Retried: a lost one would leave it on the others' screens, till their timeout.
        if (attempt < 3) {
          setTimeout(() => this.out(message, attempt + 1), DRAG_BACKOFF_MS);
        }
      } else if (message.type === "move" && this.drag?.id === message.drag) {
        // The latest position, when it may be sent again.
        this.dirty = true;
        this.schedule();
      } else if (message.type === "point" && this.pt?.id === message.id) {
        this.pt.dirty = true;
        this.schedule();
      }
    });
  }
}

/**
 * What someone's measuring from: a token, or a point (scene px; `own`, its height over the ground;
 * `radius`, grid units, a token's that was there when a Medición fija was left: none, a cell's).
 */
export type Measured = { tokenId: string } | { point: Vector2; own?: number; radius?: number };

/** The mirror's messages, as far as they're read here (see measureMirror.ts; anything else, ignored). */
type Mirror = { type?: unknown; sessionId?: unknown; origin?: { center?: Vector2 }; originTokenId?: unknown };

type Sender = {
  mirror: { sessionId: number; measured: Measured; order: number } | null;
  drag: { id: string; tokenId: string; heard: number; order: number } | null;
  point: { id: string; value: RemotePoint; heard: number; order: number } | null;
};

const finite = (p: { x?: unknown; y?: unknown } | null | undefined): p is Vector2 => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * The others' Mediciones, drags and free points, as they come (`connectionId`: who from), told on as
 * `measured` (what's measured from, the one begun last: one at a time, as the mirror shows them),
 * `moved` (where a token being dragged is) and `dropped` (its drag over: where it was left, null if
 * it's back where it began or its sender's gone).
 */
export class RemoteWatch {
  private readonly senders = new Map<string, Sender>();
  private order = 1;
  private shown: string = JSON.stringify(null);

  constructor(
    private readonly measured: (what: Measured | null) => void,
    private readonly moved: (tokenId: string, position: Vector2) => void,
    private readonly dropped: (tokenId: string, at: Vector2 | null) => void,
    private readonly now: () => number = () => performance.now()
  ) {}

  private sender(connectionId: string): Sender {
    let sender = this.senders.get(connectionId);
    if (!sender) {
      sender = { mirror: null, drag: null, point: null };
      this.senders.set(connectionId, sender);
    }
    return sender;
  }

  mirror(connectionId: string, message: Mirror) {
    if (!message || typeof message.sessionId !== "number") {
      return;
    }
    const sender = this.sender(connectionId);
    if (message.type === "start") {
      const center = message.origin?.center;
      const measured: Measured | null =
        typeof message.originTokenId === "string" ? { tokenId: message.originTokenId } : finite(center) ? { point: { x: center.x, y: center.y } } : null;
      sender.mirror = measured ? { sessionId: message.sessionId, measured, order: this.order++ } : null;
    } else if ((message.type === "end" || message.type === "pin") && sender.mirror?.sessionId === message.sessionId) {
      // Pinned: a Medición fija from then on, which isn't shown here.
      sender.mirror = null;
    }
    this.tell();
  }

  drag(connectionId: string, message: RemoteDrag) {
    if (!message) {
      return;
    }
    if (message.type === "point") {
      this.takePoint(connectionId, message);
      return;
    }
    if (typeof message.drag !== "string" || typeof message.tokenId !== "string") {
      return;
    }
    const sender = this.sender(connectionId);
    if (message.type === "end") {
      if (sender.drag?.id === message.drag) {
        this.drop(sender, finite(message.at) ? { x: message.at.x, y: message.at.y } : null);
        this.tell();
      }
      return;
    }
    if (message.type !== "move" || !finite(message.position)) {
      return;
    }
    if (sender.drag && sender.drag.id !== message.drag) {
      this.drop(sender);
    }
    const first = !sender.drag;
    sender.drag ??= { id: message.drag, tokenId: message.tokenId, heard: 0, order: this.order++ };
    sender.drag.heard = this.now();
    // Measured from first, where it's still standing (its rings stay there), then moved.
    if (first) {
      this.tell();
    }
    this.moved(message.tokenId, { x: message.position.x, y: message.position.y });
  }

  private takePoint(connectionId: string, message: { id?: unknown; point?: RemotePoint | null }) {
    if (typeof message.id !== "string") {
      return;
    }
    const sender = this.sender(connectionId);
    const value = message.point;
    if (!value) {
      if (sender.point?.id === message.id) {
        sender.point = null;
        this.tell();
      }
      return;
    }
    if (!finite(value)) {
      return;
    }
    if (sender.point?.id !== message.id) {
      sender.point = { id: message.id, value, heard: 0, order: this.order++ };
    }
    sender.point.value = { x: value.x, y: value.y, own: Number.isFinite(value.own) ? value.own : 0 };
    sender.point.heard = this.now();
    this.tell();
  }

  /** Someone left (their messages stop): what they were doing goes. */
  left(connected: Set<string>) {
    for (const [connectionId, sender] of this.senders) {
      if (!connected.has(connectionId)) {
        this.drop(sender);
        this.senders.delete(connectionId);
      }
    }
    this.tell();
  }

  /** Drags and points not heard of for a while (their sender's gone without an "end"): dropped. Call now and then. */
  expire() {
    const now = this.now();
    let any = false;
    for (const sender of this.senders.values()) {
      if (sender.drag && now - sender.drag.heard > DRAG_TIMEOUT_MS) {
        this.drop(sender);
        any = true;
      }
      if (sender.point && now - sender.point.heard > POINT_TIMEOUT_MS) {
        sender.point = null;
        any = true;
      }
    }
    if (any) {
      this.tell();
    }
  }

  private drop(sender: Sender, at: Vector2 | null = null) {
    const drag = sender.drag;
    sender.drag = null;
    if (drag) {
      this.dropped(drag.tokenId, at);
    }
  }

  /** What's measured from now: of everyone's Mediciones, drags and free points, the one begun last. */
  current(): Measured | null {
    let best: { measured: Measured; order: number } | null = null;
    for (const sender of this.senders.values()) {
      const theirs = [
        sender.mirror,
        // A Medición's drag is that Medición's (as old as it); a Vistazo's, one of its own.
        !sender.mirror && sender.drag && { measured: { tokenId: sender.drag.tokenId }, order: sender.drag.order },
        sender.point && { measured: { point: { x: sender.point.value.x, y: sender.point.value.y }, own: sender.point.value.own }, order: sender.point.order },
      ];
      for (const one of theirs) {
        if (one && (!best || one.order > best.order)) {
          best = one;
        }
      }
    }
    return best?.measured ?? null;
  }

  private tell() {
    const now = this.current();
    const key = JSON.stringify(now);
    if (key !== this.shown) {
      this.shown = key;
      this.measured(now);
    }
  }
}
