import OBR, { isImage, isLabel, type Image, type Item, type Vector2 } from "@owlbear-rodeo/sdk";
import {
  applyLecturaState,
  attachToToken,
  buildHeightLabelItem,
  lecturaLabelScale,
  lecturaPlacement,
  buildLecturaItems,
  getLecturaTokenId,
  heightLabelOffset,
  type LecturaContext,
  type LecturaState,
} from "../render/lecturaItems";
import { buildBandRingItems, buildGradientShaders, reshapeOrigin } from "../render/bandRings";
import { getStoredTheme } from "../theme/themes";
import { showPinnedFixedMedicion } from "./fixedMedicion";
import { visibleNow } from "../util/attachments";
import { GLANCE_MIRROR_MS, MirrorSender, type MirrorMessage, type StartMessage } from "./mirrorSend";
import { MIRROR_CHANNEL } from "../vistazo/remote";

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
// - Lecturas are attached to their tokens, and rebuilt where one lands
//   when someone moves it; what they show comes from the measuring client,
//   which broadcasts a Lectura's state only when it changes.
// - One Medición at a time on each screen: this client's own while it
//   measures, otherwise the one started last (see showOnly).


/**
 * One Medición's client-local Lecturas + height label (+ extra items, e.g.
 * a remote client's mirrored shaders). Every scene.local call goes through
 * one queue so a later update can never land before the start it modifies.
 *
 * Each Lectura is attached to its token (see attachToToken), and rebuilt
 * where the token is whenever it moves (moveTokens): tokens can be moved
 * by others while a Medición is up.
 *
 * Only one Medición is shown on each screen (see showOnly): a view can be
 * hidden and shown again, its items kept meanwhile.
 */
export class LocalMeasureView {
  private queue: Promise<unknown> = Promise.resolve();
  private tokens = new Map<string, Image>();
  private states = new Map<string, LecturaState>();
  /** tokenId -> its Lectura's items. */
  private lecturas = new Map<string, string[]>();
  private otherIds: string[] = [];
  private heightLabelId: string | null = null;
  private heightLabel: Item | null = null;
  private ended = false;
  private shown = true;
  /** Items this view hid (the rest stay as they were built, e.g. hidden for the GM). */
  private hiddenIds = new Set<string>();

  constructor(private ctx: LecturaContext) {}

  /** A free hex Medición's Origen changed between a cell's center and a corner: its rings and gradient take that shape. */
  reshapeOrigin(center: Vector2) {
    this.enqueue(async () => {
      // Its rings and gradient are among its other items (see start).
      const ids = this.otherIds.filter((id) => id !== this.heightLabelId);
      if (ids.length > 0) {
        await OBR.scene.local.updateItems(ids, (drafts) => {
          reshapeOrigin(drafts, center, this.ctx.bandSet, this.ctx.dpi);
        });
      }
    });
  }

  private enqueue(task: () => Promise<unknown>) {
    this.queue = this.queue.then(task).catch((error) => {
      console.error("Rising Ranges: Medición view update failed", error);
    });
    return this.queue;
  }

  private allIds(): string[] {
    return [...this.otherIds, ...[...this.lecturas.values()].flat()];
  }

  private buildLectura(token: Image, state: LecturaState): Item[] {
    const items = buildLecturaItems(token, state, this.ctx).map((item) => attachToToken(item, token.id));
    this.lecturas.set(
      token.id,
      items.map((item) => item.id)
    );
    return items.map((item) => this.hiddenIfNeeded(item));
  }

  private hiddenIfNeeded(item: Item): Item {
    if (!this.shown && item.visible) {
      item.visible = false;
      this.hiddenIds.add(item.id);
    }
    return item;
  }

  start(
    tokens: Image[],
    states: Record<string, LecturaState>,
    heightLabel: { center: Vector2; text: string; attachedTo?: string } | null,
    extraItems: Item[] = []
  ) {
    return this.enqueue(async () => {
      const items: Item[] = extraItems.map((item) => this.hiddenIfNeeded(item));
      this.otherIds = extraItems.map((item) => item.id);
      for (const token of tokens) {
        const state = states[token.id];
        if (state) {
          this.tokens.set(token.id, token);
          this.states.set(token.id, state);
          items.push(...this.buildLectura(token, state));
        }
      }
      if (heightLabel) {
        const label = buildHeightLabelItem(heightLabel.center, heightLabel.text, lecturaLabelScale(this.ctx));
        if (heightLabel.attachedTo) {
          label.attachedTo = heightLabel.attachedTo;
        }
        this.heightLabelId = label.id;
        this.heightLabel = label;
        this.otherIds.push(label.id);
        items.push(this.hiddenIfNeeded(label));
      }
      if (items.length > 0 && !this.ended) {
        await OBR.scene.local.addItems(items);
      }
    });
  }

  applyStates(changed: Record<string, LecturaState>) {
    for (const [tokenId, state] of Object.entries(changed)) {
      if (this.tokens.has(tokenId)) {
        this.states.set(tokenId, state);
      }
    }
    return this.enqueue(async () => {
      const ids = new Set(Object.keys(changed).flatMap((tokenId) => this.lecturas.get(tokenId) ?? []));
      if (this.ended || ids.size === 0) {
        return;
      }
      // By ids, not a filter: a filter makes the SDK fetch every local item in
      // the scene (the terrain's drawn layers among them) and pick here, slow
      // enough to stall the drag that's waiting behind it.
      await OBR.scene.local.updateItems(
        [...ids],
        (items) => {
          for (const item of items) {
            const tokenId = getLecturaTokenId(item);
            const token = this.tokens.get(tokenId);
            if (token && changed[tokenId]) {
              applyLecturaState(item, token, changed[tokenId], this.ctx);
            }
          }
        }
      );
    });
  }

  /**
   * The measured tokens as they are now in the scene (`current`, by id): a
   * moved or resized one gets its Lectura rebuilt there, one gone (deleted,
   * or hidden from this client) loses it.
   */
  moveTokens(current: Map<string, Image>) {
    return this.enqueue(async () => {
      if (this.ended) {
        return;
      }
      const toAdd: Item[] = [];
      const toDelete: string[] = [];
      for (const [tokenId, before] of this.tokens) {
        const now = current.get(tokenId);
        if (now && lecturaPlacement(now) === lecturaPlacement(before)) {
          continue;
        }
        const ids = this.lecturas.get(tokenId) ?? [];
        toDelete.push(...ids);
        for (const id of ids) {
          this.hiddenIds.delete(id);
        }
        this.lecturas.delete(tokenId);
        const state = this.states.get(tokenId);
        if (now && state) {
          this.tokens.set(tokenId, now);
          toAdd.push(...this.buildLectura(now, state));
        } else {
          this.tokens.delete(tokenId);
          this.states.delete(tokenId);
        }
      }
      // Added first: a rebuilt Lectura replaces the old one without a gap.
      if (toAdd.length > 0) {
        await OBR.scene.local.addItems(toAdd);
      }
      if (toDelete.length > 0) {
        await OBR.scene.local.deleteItems(toDelete);
      }
    });
  }

  /** Hides it (its items kept, to be shown again) or shows it. */
  setShown(shown: boolean) {
    if (shown === this.shown) {
      return this.queue;
    }
    this.shown = shown;
    return this.enqueue(async () => {
      if (this.ended) {
        return;
      }
      if (!this.shown) {
        // By ids (see applyStates); only the ones still shown are hidden here.
        await OBR.scene.local.updateItems(this.allIds(), (items) => {
          for (const item of items) {
            if (item.visible) {
              item.visible = false;
              this.hiddenIds.add(item.id);
            }
          }
        });
      } else if (this.hiddenIds.size > 0) {
        const ids = this.hiddenIds;
        this.hiddenIds = new Set();
        await OBR.scene.local.updateItems([...ids], (items) => {
          for (const item of items) {
            item.visible = true;
          }
        });
      }
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
   * Shown again first: the Medición fija is always on screen.
   */
  async handOver(): Promise<string[]> {
    this.setShown(true);
    await this.enqueue(async () => {});
    this.ended = true;
    const ids = this.allIds();
    this.otherIds = [];
    this.lecturas.clear();
    return ids;
  }

  end() {
    this.ended = true;
    return this.enqueue(async () => {
      const ids = this.allIds();
      this.otherIds = [];
      this.lecturas.clear();
      if (ids.length > 0) {
        await OBR.scene.local.deleteItems(ids);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Measuring client → everyone else

/** This client's map's Mediciones (it draws its own itself). */
const sender = new MirrorSender("REMOTE");

export function mirrorStart(message: Omit<StartMessage, "type" | "sessionId">) {
  sender.start(message);
}

export function mirrorStates(changed: Record<string, LecturaState>) {
  sender.states(changed);
}

export function mirrorHeightText(text: string) {
  sender.heightText(text);
}

export function mirrorReshape(center: Vector2) {
  sender.reshape(center);
}

export function mirrorPinned(fixed: unknown) {
  sender.pinned(fixed);
}

export function mirrorEnd() {
  sender.end();
}

// ---------------------------------------------------------------------------
// Everyone else: rebuild each measuring client's Medición locally

/** `order`: when it started here, to tell which one is the latest. */
type RemoteSession = { sessionId: number; view: LocalMeasureView; order: number };

// Keyed by the sender's connection, so two people measuring at once each
// get their own.
const sessions = new Map<string, RemoteSession>();
let nextOrder = 1;
/** This client is measuring itself: its own Medición is the one shown. */
let measuringHere = false;

/**
 * Two Mediciones at once would put their Lecturas on top of each other, so
 * each screen shows only one: this client's own while it measures,
 * otherwise whichever started last. The others are only hidden, and come
 * back when it ends.
 */
function showOnly() {
  let latest: RemoteSession | null = null;
  if (!measuringHere) {
    for (const session of sessions.values()) {
      if (!latest || session.order > latest.order) {
        latest = session;
      }
    }
  }
  for (const session of sessions.values()) {
    session.view.setShown(session === latest);
  }
}

/** This client started (true) or ended (false) a Medición of its own. */
export function setMeasuringHere(measuring: boolean) {
  if (measuring !== measuringHere) {
    measuringHere = measuring;
    showOnly();
  }
}

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
  // One message chain per sender keeps its messages in order even though
  // handling a start is async.
  const chains = new Map<string, Promise<void>>();

  async function handle(connectionId: string, message: MirrorMessage) {
    const current = sessions.get(connectionId);
    if (message.type === "start") {
      if (current) {
        sessions.delete(connectionId);
        showOnly();
        await current.view.end();
      }
      const tokenIds = Object.keys(message.states);
      // The sender never sends a hidden token's Lectura; a token hidden
      // since is left out here too, unless this is a GM.
      // All of them: whether a token's hidden can depend on what it's attached to (see util/attachments.ts).
      const [items, role] = await Promise.all([
        tokenIds.length > 0 ? OBR.scene.items.getItems() : Promise.resolve([]),
        OBR.player.getRole(),
      ]);
      const byId = new Map(items.map((item) => [item.id, item]));
      const wanted = new Set(tokenIds);
      const tokens = items.filter((item): item is Image => wanted.has(item.id) && isImage(item) && (role === "GM" || visibleNow(byId, item)));
      const ctx: LecturaContext = { ...message.ctx, theme: getStoredTheme() };
      const view = new LocalMeasureView(ctx);
      sessions.set(connectionId, { sessionId: message.sessionId, view, order: nextOrder++ });
      // Hidden from the start if it isn't the one to show.
      showOnly();
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
      showOnly();
      return;
    }
    if (message.type === "reshape") {
      current.view.reshapeOrigin(message.center);
      return;
    }
    if (message.type === "pin") {
      // The Medición fija takes this Medición's items over, so nothing is
      // redrawn. Its "end" follows, for a session that's already gone.
      sessions.delete(connectionId);
      showOnly();
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

  // A Vistazo's Mediciones apart from its client's map's (they send on the same connection: see
  // MirrorMessage), by this mark on the connection.
  const GLANCE = "|glance";
  OBR.broadcast.onMessage(MIRROR_CHANNEL, (event) => {
    const message = event.data as MirrorMessage;
    const connectionId = message?.glance ? `${event.connectionId}${GLANCE}` : event.connectionId;
    // Owlbear stops showing its anchor after 15 s (see vistazo/mirrorOut.ts), which ends it then; ended
    // here too, in case its page went without saying so (closed all at once).
    if (message?.glance && message.type === "start") {
      setTimeout(() => {
        const chain = chains.get(connectionId) ?? Promise.resolve();
        chains.set(
          connectionId,
          chain.then(async () => {
            const session = sessions.get(connectionId);
            if (session?.sessionId === message.sessionId) {
              sessions.delete(connectionId);
              await session.view.end();
              showOnly();
            }
          })
        );
      }, GLANCE_MIRROR_MS);
    }
    const previous = chains.get(connectionId) ?? Promise.resolve();
    chains.set(
      connectionId,
      previous
        .then(() => handle(connectionId, event.data as MirrorMessage))
        .catch((error) => console.error("Rising Ranges: failed to show mirrored Medición", error))
    );
  });

  // Someone moving a measured token meanwhile: its Lectura goes where it
  // lands, in every Medición shown here (what it reads comes from the one
  // measuring).
  let role: "GM" | "PLAYER" = "PLAYER";
  OBR.player.onChange((player) => {
    role = player.role;
  });
  OBR.player
    .getRole()
    .then((value) => (role = value))
    .catch(() => {});
  OBR.scene.items.onChange((items) => {
    if (sessions.size === 0) {
      return;
    }
    const byId = new Map(items.map((item) => [item.id, item]));
    const tokens = new Map<string, Image>();
    for (const item of items) {
      if (isImage(item) && (role === "GM" || visibleNow(byId, item))) {
        tokens.set(item.id, item);
      }
    }
    for (const session of sessions.values()) {
      session.view.moveTokens(tokens);
    }
  });

  // A sender that disconnects mid-Medición never sends "end" — without this
  // its gradient/Lecturas would stay on everyone else's screen. Queued on
  // the sender's own chain, so it can't run before a start that's still
  // being set up has registered its session.
  // This client's own Vistazo sends here too (its client isn't among the party's: kept).
  let myConnectionId = "";
  OBR.player.getConnectionId().then(
    (id) => (myConnectionId = id),
    () => {}
  );
  OBR.party.onChange((players) => {
    const connected = new Set(players.map((player) => player.connectionId));
    connected.add(myConnectionId);
    for (const [connectionId, chain] of chains) {
      if (connected.has(connectionId.replace(GLANCE, ""))) {
        continue;
      }
      chains.set(
        connectionId,
        chain.then(async () => {
          const session = sessions.get(connectionId);
          sessions.delete(connectionId);
          chains.delete(connectionId);
          await session?.view.end();
          showOnly();
        })
      );
    }
  });
}
