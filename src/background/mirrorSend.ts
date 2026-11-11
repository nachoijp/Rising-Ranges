import OBR, { type Item, type Vector2 } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import type { LecturaContext, LecturaState } from "../render/lecturaItems";
import { isRateLimitError } from "../vistazo/remote";

// A Medición as it's sent to the other clients' maps (see measureMirror.ts, which draws them): from the
// map's Medición, and from a Vistazo's drag or free point (see vistazo/mirrorOut.ts).

export const MIRROR_CHANNEL = getPluginId("measureMirror");
// OBR.broadcast rejects bursts ("RateLimitHit"). Messages only go out when
// something changed, and bursts are spaced this far apart; if Owlbear still
// rate-limits, the gap widens for the rest of the session and what was
// lost is sent again.
const SEND_INTERVAL_MS = 80;
const BACKOFF_SEND_INTERVAL_MS = 200;

export type StartMessage = {
  type: "start";
  sessionId: number;
  ctx: LecturaContext;
  states: Record<string, LecturaState>;
  /** The sender's gradient, for receivers before 1.2.0; newer ones draw their own from `origin`. */
  shaders: Item[];
  /** The item everything here attaches to: the Origen's anchor (a ring before 1.2.0). */
  ringId: string;
  heightLabel: { center: Vector2; text: string } | null;
  /** Missing from senders before 1.2.0, whose rings are visible themselves. */
  origin?: { center: Vector2; radius: number };
  /** The token measured from, if it's one (the Vistazo measures from it, see vistazo/remote.ts). Missing from senders before 2.0.0. */
  originTokenId?: string;
  /** Sent by a Vistazo (its drag or free point), which the Vistazos have from it already (see vistazo/remote.ts): only for the maps. */
  glance?: true;
};
export type UpdateMessage = {
  type: "update";
  sessionId: number;
  states?: Record<string, LecturaState>;
  heightText?: string;
};
export type EndMessage = { type: "end"; sessionId: number };
/** The Medición was left in place as this Medición fija: shown before the Medición goes (receivers before 1.3.0 ignore it). */
export type PinMessage = { type: "pin"; sessionId: number; fixed: unknown };
/**
 * A free hex Medición's Origen moved from a cell's center to a corner or
 * back: its rings and gradient take the new shape (see reshapeOrigin).
 * Receivers before 1.4.0 ignore it.
 */
export type ReshapeMessage = { type: "reshape"; sessionId: number; center: Vector2 };
export type MirrorMessage = StartMessage | UpdateMessage | EndMessage | PinMessage | ReshapeMessage;

/**
 * One page's Mediciones, sent one at a time. `destination`: Owlbear's (the map's own client draws its
 * Medición itself; a Vistazo's goes to its own client's map too). `firstSession`: where its sessions'
 * numbers start (a client's map and its Vistazo send on the same connection: apart, an end of one's
 * isn't taken for the other's).
 */
export class MirrorSender {
  private nextSessionId: number;
  private activeSessionId = 0;
  private pendingStates: Record<string, LecturaState> = {};
  private pendingHeightText: string | undefined;
  private lastSendTime = 0;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private sendIntervalMs = SEND_INTERVAL_MS;
  // Other clients drop any update for a session they haven't started yet, so
  // updates wait here (accumulating in pendingStates/pendingHeightText) until
  // the start has actually gone through — otherwise a rate-limited start,
  // resent later with click-time states, would leave them showing stale
  // Lecturas with the in-between updates already lost.
  private startConfirmed = false;

  constructor(
    private readonly destination: "REMOTE" | "ALL",
    firstSession = 1
  ) {
    this.nextSessionId = firstSession;
  }

  private send(message: MirrorMessage, attempt = 0) {
    this.lastSendTime = Date.now();
    OBR.broadcast
      .sendMessage(MIRROR_CHANNEL, message, { destination: this.destination })
      .then(() => {
        if (message.type === "start" && message.sessionId === this.activeSessionId) {
          this.startConfirmed = true;
          this.scheduleFlush();
        }
      })
      .catch((error) => {
        if (!isRateLimitError(error) || attempt >= 3) {
          console.error("Rising Ranges: failed to mirror Medición", error);
          return;
        }
        this.sendIntervalMs = BACKOFF_SEND_INTERVAL_MS;
        // An "end" is always retried: its session is already over locally,
        // but a lost one would leave it stuck on everyone else's screen.
        if (message.type !== "end" && message.sessionId !== this.activeSessionId) {
          return;
        }
        if (message.type === "update") {
          // Newer pending changes win over the lost ones for the same token.
          this.pendingStates = { ...message.states, ...this.pendingStates };
          if (this.pendingHeightText === undefined) {
            this.pendingHeightText = message.heightText;
          }
          this.scheduleFlush();
        } else {
          setTimeout(() => {
            if (message.type === "end" || message.sessionId === this.activeSessionId) {
              this.send(message, attempt + 1);
            }
          }, BACKOFF_SEND_INTERVAL_MS);
        }
      });
  }

  private flushPending() {
    this.sendTimer = null;
    if (!this.activeSessionId || !this.startConfirmed) {
      return;
    }
    const hasStates = Object.keys(this.pendingStates).length > 0;
    if (!hasStates && this.pendingHeightText === undefined) {
      return;
    }
    this.send({
      type: "update",
      sessionId: this.activeSessionId,
      states: hasStates ? this.pendingStates : undefined,
      heightText: this.pendingHeightText,
    });
    this.pendingStates = {};
    this.pendingHeightText = undefined;
  }

  private scheduleFlush() {
    if (this.sendTimer) {
      return;
    }
    const wait = Math.max(0, this.lastSendTime + this.sendIntervalMs - Date.now());
    this.sendTimer = setTimeout(() => this.flushPending(), wait);
  }

  start(message: Omit<StartMessage, "type" | "sessionId">) {
    this.activeSessionId = this.nextSessionId++;
    this.startConfirmed = false;
    this.pendingStates = {};
    this.pendingHeightText = undefined;
    this.send({ type: "start", sessionId: this.activeSessionId, ...message });
  }

  states(changed: Record<string, LecturaState>) {
    if (!this.activeSessionId) {
      return;
    }
    Object.assign(this.pendingStates, changed);
    this.scheduleFlush();
  }

  heightText(text: string) {
    if (!this.activeSessionId) {
      return;
    }
    this.pendingHeightText = text;
    this.scheduleFlush();
  }

  reshape(center: Vector2) {
    if (!this.activeSessionId) {
      return;
    }
    this.send({ type: "reshape", sessionId: this.activeSessionId, center });
  }

  pinned(fixed: unknown) {
    if (!this.activeSessionId) {
      return;
    }
    this.send({ type: "pin", sessionId: this.activeSessionId, fixed });
  }

  end() {
    if (!this.activeSessionId) {
      return;
    }
    if (this.sendTimer) {
      clearTimeout(this.sendTimer);
      this.sendTimer = null;
    }
    this.pendingStates = {};
    this.pendingHeightText = undefined;
    this.send({ type: "end", sessionId: this.activeSessionId });
    this.activeSessionId = 0;
  }
}
