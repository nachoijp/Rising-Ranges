import OBR, { isImage, isLabel, type Image, type Item, type Vector2 } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import {
  applyLecturaState,
  buildHeightLabelItem,
  lecturaLabelScale,
  buildLecturaItems,
  getLecturaTokenId,
  heightLabelOffset,
  type LecturaContext,
  type LecturaState,
} from "../render/lecturaItems";
import { buildBandRingItems, buildGradientShaders } from "../render/bandRings";
import { getStoredTheme } from "../theme/themes";
import { showPinnedFixedMedicion } from "./fixedMedicion";

// Shows a Medición's rings, gradient, Lecturas and height label to every
// client, not just the one measuring, each in that client's own color theme.
//
// Only an invisible anchor at the Origen travels in an interaction (see
// buildOriginAnchor): an interaction only syncs position changes (not text,
// color or shape), and the gradient's shaders can't go in one at all. So:
// - Everything here is client-local (OBR.scene.local), on every client.
// - What follows the moving Origen (rings, gradient, height label) is
//   attachedTo the anchor, and Owlbear moves it along. That move is
//   render-only: the item's stored position never changes.
// - Lecturas sit on tokens that don't move, so only their content changes:
//   the measuring client broadcasts a Lectura's state only when it changes.

const CHANNEL = getPluginId("measureMirror");
// OBR.broadcast rejects bursts ("RateLimitHit"). Messages only go out when
// something changed, and bursts are spaced this far apart; if Owlbear still
// rate-limits, the gap widens for the rest of the session and what was
// lost is sent again.
const SEND_INTERVAL_MS = 80;
const BACKOFF_SEND_INTERVAL_MS = 200;
let sendIntervalMs = SEND_INTERVAL_MS;

type StartMessage = {
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
};
type UpdateMessage = {
  type: "update";
  sessionId: number;
  states?: Record<string, LecturaState>;
  heightText?: string;
};
type EndMessage = { type: "end"; sessionId: number };
/** The Medición was left in place as this Medición fija: shown before the Medición goes (receivers before 1.3.0 ignore it). */
type PinMessage = { type: "pin"; sessionId: number; fixed: unknown };
type MirrorMessage = StartMessage | UpdateMessage | EndMessage | PinMessage;

/**
 * One Medición's client-local Lecturas + height label (+ extra items, e.g.
 * a remote client's mirrored shaders). Every scene.local call goes through
 * one queue so a later update can never land before the start it modifies.
 */
export class LocalMeasureView {
  private queue: Promise<unknown> = Promise.resolve();
  private tokens = new Map<string, Image>();
  private itemIds: string[] = [];
  private heightLabelId: string | null = null;
  private heightLabel: Item | null = null;
  private ended = false;

  constructor(private ctx: LecturaContext) {}

  private enqueue(task: () => Promise<unknown>) {
    this.queue = this.queue.then(task).catch((error) => {
      console.error("Rising Ranges: Medición view update failed", error);
    });
    return this.queue;
  }

  start(
    tokens: Image[],
    states: Record<string, LecturaState>,
    heightLabel: { center: Vector2; text: string; attachedTo?: string } | null,
    extraItems: Item[] = []
  ) {
    return this.enqueue(async () => {
      const items: Item[] = [...extraItems];
      for (const token of tokens) {
        const state = states[token.id];
        if (state) {
          this.tokens.set(token.id, token);
          items.push(...buildLecturaItems(token, state, this.ctx));
        }
      }
      if (heightLabel) {
        const label = buildHeightLabelItem(heightLabel.center, heightLabel.text, lecturaLabelScale(this.ctx));
        if (heightLabel.attachedTo) {
          label.attachedTo = heightLabel.attachedTo;
        }
        this.heightLabelId = label.id;
        this.heightLabel = label;
        items.push(label);
      }
      this.itemIds = items.map((item) => item.id);
      if (items.length > 0 && !this.ended) {
        await OBR.scene.local.addItems(items);
      }
    });
  }

  applyStates(changed: Record<string, LecturaState>) {
    return this.enqueue(async () => {
      const ids = this.itemIds.filter((id) => id !== this.heightLabelId);
      if (this.ended || ids.length === 0) {
        return;
      }
      const tokenIds = new Set(Object.keys(changed));
      await OBR.scene.local.updateItems(
        (item) => ids.includes(item.id) && tokenIds.has(getLecturaTokenId(item)),
        (items) => {
          for (const item of items) {
            const tokenId = getLecturaTokenId(item);
            const token = this.tokens.get(tokenId);
            if (token) {
              applyLecturaState(item, token, changed[tokenId], this.ctx);
            }
          }
        }
      );
    });
  }

  setHeightText(text: string) {
    return this.enqueue(async () => {
      if (this.ended || !this.heightLabelId) {
        return;
      }
      await OBR.scene.local.updateItems([this.heightLabelId], (items) => {
        for (const item of items) {
          if (isLabel(item)) {
            item.text.plainText = text;
          }
        }
      });
    });
  }

  /** Measuring client only — other clients' height label is attachedTo a ring instead. */
  moveHeightLabel(center: Vector2) {
    if (!this.heightLabel || this.ended) {
      return;
    }
    // Not queued: fires at drag rate, and only ever touches position,
    // which nothing else in the queue writes. Passing the item itself (not
    // its id) skips a getItems round trip per move — the update is a diff
    // against it, so its stale text never gets written back.
    OBR.scene.local.updateItems([this.heightLabel], (items) => {
      for (const item of items) {
        item.position = { x: center.x - heightLabelOffset.x, y: center.y - heightLabelOffset.y };
      }
    });
  }

  /**
   * Gives its items away (the Medición fija takes them over, so nothing is
   * redrawn): once whatever's queued is done, end() leaves them alone.
   */
  async handOver(): Promise<string[]> {
    await this.enqueue(async () => {});
    this.ended = true;
    const ids = this.itemIds;
    this.itemIds = [];
    return ids;
  }

  end() {
    this.ended = true;
    return this.enqueue(async () => {
      if (this.itemIds.length > 0) {
        const ids = this.itemIds;
        this.itemIds = [];
        await OBR.scene.local.deleteItems(ids);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Measuring client → everyone else

let nextSessionId = 1;
let activeSessionId = 0;
let pendingStates: Record<string, LecturaState> = {};
let pendingHeightText: string | undefined;
let lastSendTime = 0;
let sendTimer: ReturnType<typeof setTimeout> | null = null;
// Other clients drop any update for a session they haven't started yet, so
// updates wait here (accumulating in pendingStates/pendingHeightText) until
// the start has actually gone through — otherwise a rate-limited start,
// resent later with click-time states, would leave them showing stale
// Lecturas with the in-between updates already lost.
let startConfirmed = false;

function isRateLimitError(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : JSON.stringify(error);
  return /rate ?limit|too many/i.test(text ?? "");
}

function send(message: MirrorMessage, attempt = 0) {
  lastSendTime = Date.now();
  OBR.broadcast
    .sendMessage(CHANNEL, message, { destination: "REMOTE" })
    .then(() => {
      if (message.type === "start" && message.sessionId === activeSessionId) {
        startConfirmed = true;
        scheduleFlush();
      }
    })
    .catch((error) => {
      if (!isRateLimitError(error) || attempt >= 3) {
        console.error("Rising Ranges: failed to mirror Medición", error);
        return;
      }
      sendIntervalMs = BACKOFF_SEND_INTERVAL_MS;
      // An "end" is always retried: its session is already over locally,
      // but a lost one would leave it stuck on everyone else's screen.
      if (message.type !== "end" && message.sessionId !== activeSessionId) {
        return;
      }
      if (message.type === "update") {
        // Newer pending changes win over the lost ones for the same token.
        pendingStates = { ...message.states, ...pendingStates };
        if (pendingHeightText === undefined) {
          pendingHeightText = message.heightText;
        }
        scheduleFlush();
      } else {
        setTimeout(() => {
          if (message.type === "end" || message.sessionId === activeSessionId) {
            send(message, attempt + 1);
          }
        }, BACKOFF_SEND_INTERVAL_MS);
      }
    });
}

function flushPending() {
  sendTimer = null;
  if (!activeSessionId || !startConfirmed) {
    return;
  }
  const hasStates = Object.keys(pendingStates).length > 0;
  if (!hasStates && pendingHeightText === undefined) {
    return;
  }
  send({
    type: "update",
    sessionId: activeSessionId,
    states: hasStates ? pendingStates : undefined,
    heightText: pendingHeightText,
  });
  pendingStates = {};
  pendingHeightText = undefined;
}

function scheduleFlush() {
  if (sendTimer) {
    return;
  }
  const wait = Math.max(0, lastSendTime + sendIntervalMs - Date.now());
  sendTimer = setTimeout(flushPending, wait);
}

export function mirrorStart(message: Omit<StartMessage, "type" | "sessionId">) {
  activeSessionId = nextSessionId++;
  startConfirmed = false;
  pendingStates = {};
  pendingHeightText = undefined;
  send({ type: "start", sessionId: activeSessionId, ...message });
}

export function mirrorStates(changed: Record<string, LecturaState>) {
  if (!activeSessionId) {
    return;
  }
  Object.assign(pendingStates, changed);
  scheduleFlush();
}

export function mirrorHeightText(text: string) {
  if (!activeSessionId) {
    return;
  }
  pendingHeightText = text;
  scheduleFlush();
}

export function mirrorPinned(fixed: unknown) {
  if (!activeSessionId) {
    return;
  }
  send({ type: "pin", sessionId: activeSessionId, fixed });
}

export function mirrorEnd() {
  if (!activeSessionId) {
    return;
  }
  if (sendTimer) {
    clearTimeout(sendTimer);
    sendTimer = null;
  }
  pendingStates = {};
  pendingHeightText = undefined;
  send({ type: "end", sessionId: activeSessionId });
  activeSessionId = 0;
}

// ---------------------------------------------------------------------------
// Everyone else: rebuild each measuring client's Medición locally

type RemoteSession = { sessionId: number; view: LocalMeasureView };

/** The gradient, rings and ring labels of someone else's Medición, in this client's theme. */
function ownOriginItems(ctx: LecturaContext, center: Vector2, originRadius: number): Item[] {
  // A measuring client from before 1.4.0 sends no axonometry: it measured flat.
  const axonometry = ctx.axonometry ?? 0;
  const items = buildGradientShaders(center, ctx.theme, ctx.bandSet, ctx.dpi, originRadius, axonometry);
  if (ctx.gridScale && ctx.display) {
    items.push(
      ...buildBandRingItems(
        center,
        ctx.theme,
        ctx.bandSet,
        ctx.dpi,
        ctx.gridScale,
        ctx.display.ringLabel,
        ctx.display.ringLabelSize,
        originRadius,
        axonometry
      )
    );
  }
  return items;
}

export function startMeasureMirrorReceiver() {
  // Keyed by the sender's connection, so two people measuring at once each
  // get their own; one message chain per sender keeps its messages in order
  // even though handling a start is async.
  const sessions = new Map<string, RemoteSession>();
  const chains = new Map<string, Promise<void>>();

  async function handle(connectionId: string, message: MirrorMessage) {
    const current = sessions.get(connectionId);
    if (message.type === "start") {
      if (current) {
        sessions.delete(connectionId);
        await current.view.end();
      }
      const tokenIds = Object.keys(message.states);
      // The sender never sends a hidden token's Lectura; a token hidden
      // since is left out here too, unless this is a GM.
      const [items, role] = await Promise.all([
        tokenIds.length > 0 ? OBR.scene.items.getItems(tokenIds) : Promise.resolve([]),
        OBR.player.getRole(),
      ]);
      const tokens = items.filter((item): item is Image => isImage(item) && (role === "GM" || item.visible));
      const ctx: LecturaContext = { ...message.ctx, theme: getStoredTheme() };
      const view = new LocalMeasureView(ctx);
      sessions.set(connectionId, { sessionId: message.sessionId, view });
      const originItems = message.origin
        ? ownOriginItems(ctx, message.origin.center, message.origin.radius)
        : message.shaders;
      await view.start(
        tokens,
        message.states,
        message.heightLabel && { ...message.heightLabel, attachedTo: message.ringId },
        originItems.map((item) => ({ ...item, attachedTo: message.ringId }))
      );
      return;
    }
    if (!current || current.sessionId !== message.sessionId) {
      return;
    }
    if (message.type === "end") {
      sessions.delete(connectionId);
      await current.view.end();
      return;
    }
    if (message.type === "pin") {
      // The Medición fija takes this Medición's items over, so nothing is
      // redrawn. Its "end" follows, for a session that's already gone.
      sessions.delete(connectionId);
      await showPinnedFixedMedicion(message.fixed, await current.view.handOver());
      return;
    }
    if (message.states) {
      await current.view.applyStates(message.states);
    }
    if (message.heightText !== undefined) {
      await current.view.setHeightText(message.heightText);
    }
  }

  OBR.broadcast.onMessage(CHANNEL, (event) => {
    const connectionId = event.connectionId;
    const previous = chains.get(connectionId) ?? Promise.resolve();
    chains.set(
      connectionId,
      previous
        .then(() => handle(connectionId, event.data as MirrorMessage))
        .catch((error) => console.error("Rising Ranges: failed to show mirrored Medición", error))
    );
  });

  // A sender that disconnects mid-Medición never sends "end" — without this
  // its gradient/Lecturas would stay on everyone else's screen. Queued on
  // the sender's own chain, so it can't run before a start that's still
  // being set up has registered its session.
  OBR.party.onChange((players) => {
    const connected = new Set(players.map((player) => player.connectionId));
    for (const [connectionId, chain] of chains) {
      if (connected.has(connectionId)) {
        continue;
      }
      chains.set(
        connectionId,
        chain.then(async () => {
          const session = sessions.get(connectionId);
          sessions.delete(connectionId);
          chains.delete(connectionId);
          await session?.view.end();
        })
      );
    }
  });
}
