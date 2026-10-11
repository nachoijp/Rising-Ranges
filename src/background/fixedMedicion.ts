import OBR, { isImage, isLabel, type GridScale, type Image, type Item, type Vector2 } from "@owlbear-rodeo/sdk";
import unpinIcon from "../assets/unpin.svg";
import { getPluginId } from "../util/getPluginId";
import { getMetadata } from "../util/getMetadata";
import { isPoint } from "../util/isPoint";
import { getStoredTheme, THEME_STORAGE_KEYS } from "../theme/themes";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import { globalSettingsFromMetadata } from "../settings/globalSettings";
import { resolveDisplay, showsDistance } from "../settings/display";
import { languageFromMetadata, type Language } from "../i18n/language";
import { translate } from "../i18n/translate";
import { isTokenHeightMarker, tokenHeightsFromMarkers } from "../tokenHeight/markers";
import { buildBandRingItems, buildGradientShaders } from "../render/bandRings";
import {
  applyLecturaState,
  buildHeightLabelItem,
  buildLecturaItems,
  getLecturaTokenId,
  heightLabelOffset,
  lecturaLabelScale,
  sameLecturaState,
  type LecturaContext,
  type LecturaState,
} from "../render/lecturaItems";
import { computeLecturaState, heightLabelText, type LecturaOrigin } from "../render/computeLectura";

// The Medición fija: a Medición left in place (Shift held when one is
// released) so tokens can be moved around a fixed point, until a Shift+click
// or the toolbar's X removes it. One at a time, for the whole room; anyone
// may remove it.
//
// Only the point itself is shared, in the room's metadata: every client
// draws the rings and works out every Lectura on its own, from the scene's
// token positions and height markers, in its own color theme — so nothing
// is sent while tokens move. It's client-local items throughout, each
// Lectura attachedTo its token, so Owlbear carries it along while the
// token is dragged (on every client), and it's rebuilt where the token
// lands. Like heightOverlays.ts, a moved item is rebuilt rather than
// repositioned: an attached local item's stored position doesn't follow
// its token.
//
// It doesn't outlive whoever made it: it carries their connection, and
// once that's gone (they left, or reloaded) every client ignores it. One
// made on a hidden token (by the GM) is never shared at all.

const METADATA_KEY = getPluginId("fixedMedicion");
const ITEM_KEY = getPluginId("fixedMedicionItem");
const CLEAR_ACTION_ID = getPluginId("action/clearFixedMedicion");

type FixedMedicion = LecturaOrigin & { id: string; owner: string };

/** The room's Medición fija, as last read or written. */
let shared: FixedMedicion | null = null;
/** A GM's Medición fija from a hidden token: this client only. */
let secret: FixedMedicion | null = null;
let myConnectionId = "";
let connected = new Set<string>();

let sceneReady = false;
let metadata: Record<string, unknown> = {};
let items: Item[] = [];
let dpi = 0;
let gridScale: GridScale | null = null;
let role: "GM" | "PLAYER" = "PLAYER";
/** Where this client is dragging a token right now, and its height there — newer than the scene. */
const live = new Map<string, { position: Vector2; height: number }>();

type DrawnLectura = { signature: string; ids: string[]; token: Image; state: LecturaState };
let drawnOrigin: { signature: string; ids: string[] } | null = null;
const drawnLecturas = new Map<string, DrawnLectura>();
// Set whenever this client may have items it isn't tracking (a fresh
// scene, or a write that failed partway): the next pass deletes every one
// and redraws from scratch.
let resync = true;
let running = false;
let dirty = false;
/** The items of the Medición a Medición fija was pinned from, for it to take over (see adopt). */
let pendingAdopt: { fixedId: string; ids: string[] } | null = null;
/** Never equal to a real state: an adopted Lectura is always restyled. */
const UNKNOWN_STATE: LecturaState = { index: -1, withinFilter: false, dz: Number.NaN };
const ATTACHED_ONLY_BY_POSITION: Item["disableAttachmentBehavior"] = ["ROTATION", "SCALE", "VISIBLE", "LOCKED", "COPY"];
/** Waiting for a Medición fija (by id) to be on screen: see pinFixedMedicion. */
const drawnWaiters = new Map<string, () => void>();
/** At most this long: a pin mustn't hold the Medición it replaces on screen for good. */
const DRAWN_WAIT_MS = 1000;
/** The language the X is registered in, null while it isn't, undefined when unknown (a call failed). */
let clearActionLanguage: Language | null | undefined = null;

function current(): FixedMedicion | null {
  if (secret) {
    return secret;
  }
  if (shared && (shared.owner === myConnectionId || connected.has(shared.owner))) {
    return shared;
  }
  return null;
}

/** Whether a Medición fija is up on this client: the Medición tool then only moves tokens. */
export function hasFixedMedicion(): boolean {
  return sceneReady && current() !== null;
}

function parseFixed(value: unknown): FixedMedicion | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const v = value as Partial<FixedMedicion>;
  if (
    typeof v.id !== "string" ||
    typeof v.owner !== "string" ||
    !isPoint(v.center) ||
    typeof v.height !== "number" ||
    typeof v.radius !== "number"
  ) {
    return null;
  }
  return { id: v.id, owner: v.owner, center: v.center, height: v.height, radius: v.radius };
}

/**
 * Leaves a Medición fija at `origin` — for everyone, or (`secret`) just
 * here, taking over the items `adoptIds` of the Medición it's pinned from.
 * `drawn` resolves once it's on screen here (or after DRAWN_WAIT_MS), so
 * that Medición can stay up until then instead of leaving a gap. `shared`
 * is what everyone else gets, for the Medición's mirror to send ahead.
 */
export function pinFixedMedicion(
  origin: LecturaOrigin,
  isSecret: boolean,
  adoptIds: string[] = []
): { shared: FixedMedicion | null; drawn: Promise<void> } {
  // Same key order as parseFixed: compared as JSON with what the room echoes back.
  const fixed: FixedMedicion = {
    id: crypto.randomUUID(),
    owner: myConnectionId,
    center: origin.center,
    height: origin.height,
    radius: origin.radius,
  };
  if (pendingAdopt) {
    // Never taken over: nothing else would remove them.
    OBR.scene.local.deleteItems(pendingAdopt.ids).catch(() => {});
  }
  pendingAdopt = adoptIds.length > 0 ? { fixedId: fixed.id, ids: adoptIds } : null;
  const drawn = whenDrawn(fixed.id);
  if (isSecret) {
    secret = fixed;
    schedule();
    return { shared: null, drawn };
  }
  secret = null;
  shared = fixed;
  schedule();
  OBR.room.setMetadata({ [METADATA_KEY]: fixed }).catch(async (error) => {
    console.error("Rising Ranges: failed to share the Medición fija", error);
    await reloadShared();
  });
  return { shared: fixed, drawn };
}

/** Resolves once the Medición fija `id` is on screen here, or after DRAWN_WAIT_MS. */
function whenDrawn(id: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      drawnWaiters.delete(id);
      resolve();
    }, DRAWN_WAIT_MS);
    drawnWaiters.set(id, () => {
      clearTimeout(timer);
      drawnWaiters.delete(id);
      resolve();
    });
  });
}

/**
 * A Medición fija another client just pinned, sent along with the Medición
 * it was pinned from (see measureMirror.ts) — ahead of the room's metadata,
 * so that Medición can stay up until this is on screen. Resolves then.
 */
export function showPinnedFixedMedicion(value: unknown, adoptIds: string[]): Promise<void> {
  const fixed = parseFixed(value);
  if (!fixed) {
    OBR.scene.local.deleteItems(adoptIds).catch(() => {});
    return Promise.resolve();
  }
  if (pendingAdopt) {
    OBR.scene.local.deleteItems(pendingAdopt.ids).catch(() => {});
  }
  pendingAdopt = adoptIds.length > 0 ? { fixedId: fixed.id, ids: adoptIds } : null;
  const drawn = whenDrawn(fixed.id);
  if (JSON.stringify(fixed) !== JSON.stringify(shared)) {
    shared = fixed;
    secret = null;
  }
  schedule();
  return drawn;
}

/** Removes the Medición fija, whoever made it. */
export async function clearFixedMedicion() {
  live.clear();
  // Both, if a GM's secret one ever came up over a shared one: removing
  // the first mustn't bring back the other.
  const hadShared = shared !== null;
  secret = null;
  shared = null;
  schedule();
  if (!hadShared) {
    return;
  }
  try {
    await OBR.room.setMetadata({ [METADATA_KEY]: null });
  } catch (error) {
    console.error("Rising Ranges: failed to remove the Medición fija", error);
    await reloadShared();
  }
}

/** A token this client is dragging: its Lectura follows `position` and `height` until setFixedLive(id, null). */
export function setFixedLive(tokenId: string, value: { position: Vector2; height: number } | null) {
  if (value) {
    live.set(tokenId, value);
  } else if (!live.delete(tokenId)) {
    return;
  }
  if (current()) {
    schedule();
  }
}

async function reloadShared() {
  try {
    shared = parseFixed((await OBR.room.getMetadata())[METADATA_KEY]);
  } catch (error) {
    console.error("Rising Ranges: failed to read the Medición fija", error);
  }
  schedule();
}

function tagged<T extends Item>(item: T): T {
  item.metadata = { ...item.metadata, [ITEM_KEY]: true };
  return item;
}

/** Everything a Lectura's placement depends on: when any of it changes it's rebuilt, otherwise only restyled. */
function lecturaSignature(ctxSignature: string, token: Image): string {
  return JSON.stringify([
    ctxSignature,
    token.position,
    token.scale,
    token.rotation,
    token.image.width,
    token.image.height,
    token.grid,
    token.visible,
  ]);
}

/**
 * Takes over the items of the Medición this one was pinned from (this
 * client's, or another's as mirrored here): its rings, gradient and height
 * label move to the fixed point, and its Lecturas are
 * attached to their tokens and restyled by the pass that follows. Whatever
 * doesn't fit (a Lectura on a token not measured here) goes.
 */
async function adopt(
  ids: string[],
  center: Vector2,
  heightText: string | null,
  tokens: Map<string, Image>,
  ctxSignature: string
) {
  const adopted = await OBR.scene.local.getItems(ids);
  const originIds: string[] = [];
  const lecturaIds = new Map<string, string[]>();
  const drop: string[] = [];
  for (const item of adopted) {
    const tokenId = getLecturaTokenId(item);
    if (!tokenId) {
      originIds.push(item.id);
    } else if (tokens.has(tokenId)) {
      lecturaIds.set(tokenId, [...(lecturaIds.get(tokenId) ?? []), item.id]);
    } else {
      drop.push(item.id);
    }
  }
  const kept = adopted.map((item) => item.id).filter((id) => !drop.includes(id));
  if (kept.length > 0) {
    await OBR.scene.local.updateItems(kept, (drafts) => {
      for (const item of drafts) {
        item.metadata = { ...item.metadata, [ITEM_KEY]: true };
        const tokenId = getLecturaTokenId(item);
        if (tokenId) {
          item.attachedTo = tokenId;
          item.disableAttachmentBehavior = ATTACHED_ONLY_BY_POSITION;
        } else if (getPluginId("heightLabel") in item.metadata) {
          // Another client's mirror attached it to the Medición's anchor, which is going.
          item.attachedTo = undefined;
          item.position = { x: center.x - heightLabelOffset.x, y: center.y - heightLabelOffset.y };
          if (isLabel(item) && heightText !== null) {
            item.text.plainText = heightText;
          }
        } else {
          item.attachedTo = undefined;
          const offset = getMetadata(item.metadata, getPluginId("offset"), { x: 0, y: 0 });
          item.position = { x: center.x - offset.x, y: center.y - offset.y };
        }
      }
    });
  }
  if (drop.length > 0) {
    await OBR.scene.local.deleteItems(drop);
  }
  drawnOrigin = { signature: ctxSignature, ids: originIds };
  for (const [tokenId, itemIds] of lecturaIds) {
    const token = tokens.get(tokenId) as Image;
    drawnLecturas.set(tokenId, {
      signature: lecturaSignature(ctxSignature, token),
      ids: itemIds,
      token,
      state: UNKNOWN_STATE,
    });
  }
}

async function reconcile() {
  if (!sceneReady) {
    // No scene, no local items to touch (OBR.scene.* would throw).
    syncClearAction(null);
    return;
  }
  if (resync) {
    resync = false;
    drawnOrigin = null;
    drawnLecturas.clear();
    const leftovers = await OBR.scene.local.getItems((item) => ITEM_KEY in item.metadata);
    if (leftovers.length > 0) {
      await OBR.scene.local.deleteItems(leftovers.map((item) => item.id));
    }
  }
  const fixed = dpi && gridScale ? current() : null;
  // Its maker is gone, so it's ignored everywhere; the GM's client also
  // takes it out of the room. Just the GM's, so they don't all write.
  if (role === "GM" && shared && shared.owner !== myConnectionId && !connected.has(shared.owner)) {
    shared = null;
    OBR.room.setMetadata({ [METADATA_KEY]: null }).catch((error) => {
      console.error("Rising Ranges: failed to remove a Medición fija left behind", error);
    });
  }
  if (pendingAdopt && pendingAdopt.fixedId !== fixed?.id) {
    // Pinned, but not (or no longer) the one up: nothing else would remove them.
    const { ids } = pendingAdopt;
    pendingAdopt = null;
    await OBR.scene.local.deleteItems(ids);
  }
  const language = languageFromMetadata(metadata);
  syncClearAction(fixed ? language : null);

  const toDelete: string[] = [];
  const toAdd: Item[] = [];
  const toUpdate = new Map<string, LecturaState>();

  if (!fixed || !gridScale) {
    if (drawnOrigin) {
      toDelete.push(...drawnOrigin.ids);
      drawnOrigin = null;
    }
    for (const drawn of drawnLecturas.values()) {
      toDelete.push(...drawn.ids);
    }
    drawnLecturas.clear();
  } else {
    const bandSet = bandSetFromMetadata(metadata);
    const settings = globalSettingsFromMetadata(metadata);
    const altitude = settings.enableAltitude ?? true;
    const display = resolveDisplay(settings.display, bandSet, settings);
    const showDistance = showsDistance(display.lecturaLabel);
    const theme = getStoredTheme();
    const ctx: LecturaContext = { bandSet, theme, dpi, language, gridScale, showDistance, display };
    const origin: LecturaOrigin = { center: fixed.center, height: altitude ? fixed.height : 0, radius: fixed.radius };
    const isSecret = fixed === secret;
    const ctxSignature = JSON.stringify([fixed.id, origin, bandSet, display, language, theme, dpi, gridScale, isSecret]);
    const lecturasEnabled = display.lecturaStyle !== "none" || display.lecturaLabel !== "none";
    // A player's client still has hidden tokens (Owlbear just doesn't draw
    // them): measuring them would show their Lecturas.
    const tokens = lecturasEnabled
      ? items.filter(
          (item): item is Image => isImage(item) && item.layer === "CHARACTER" && (role === "GM" || item.visible)
        )
      : [];

    if (pendingAdopt?.fixedId === fixed.id) {
      const { ids } = pendingAdopt;
      pendingAdopt = null;
      if (!drawnOrigin) {
        const heightText = altitude ? heightLabelText(origin.height, bandSet, gridScale, language) : null;
        try {
          await adopt(ids, origin.center, heightText, new Map(tokens.map((t) => [t.id, t])), ctxSignature);
        } catch (error) {
          console.error("Rising Ranges: failed to take over the Medición", error);
          await OBR.scene.local.deleteItems(ids);
        }
      } else {
        await OBR.scene.local.deleteItems(ids);
      }
    }

    if (drawnOrigin?.signature !== ctxSignature) {
      if (drawnOrigin) {
        toDelete.push(...drawnOrigin.ids);
      }
      const rings = buildBandRingItems(
        origin.center,
        theme,
        bandSet,
        dpi,
        gridScale,
        display.ringLabel,
        display.ringLabelSize,
        origin.radius
      );
      if (altitude) {
        const text = heightLabelText(origin.height, bandSet, gridScale, language);
        rings.push(buildHeightLabelItem(origin.center, text, lecturaLabelScale(ctx)));
      }
      if (isSecret) {
        // Faded for the GM, as Owlbear shows hidden things.
        for (const item of rings) {
          item.visible = false;
        }
      }
      const originItems = [...buildGradientShaders(origin.center, theme, bandSet, dpi, origin.radius), ...rings].map(tagged);
      toAdd.push(...originItems);
      drawnOrigin = { signature: ctxSignature, ids: originItems.map((item) => item.id) };
    }

    const heights = altitude ? tokenHeightsFromMarkers(items.filter(isTokenHeightMarker), bandSet) : new Map<string, number>();
    const wanted = new Set<string>();
    for (const token of tokens) {
      wanted.add(token.id);
      const override = live.get(token.id);
      const state = computeLecturaState(
        token,
        override?.position ?? token.position,
        override?.height ?? heights.get(token.id) ?? 0,
        origin,
        { bandSet, dpi, display, showDistance }
      );
      const signature = lecturaSignature(ctxSignature, token);
      const drawn = drawnLecturas.get(token.id);
      if (drawn && drawn.signature === signature) {
        if (!sameLecturaState(drawn.state, state)) {
          drawn.state = state;
          toUpdate.set(token.id, state);
        }
        continue;
      }
      if (drawn) {
        toDelete.push(...drawn.ids);
      }
      const lecturaItems = buildLecturaItems(token, state, ctx).map((item) => {
        item.attachedTo = token.id;
        // Only carried along: what else it would inherit from the token is
        // already worked into it when built.
        item.disableAttachmentBehavior = ATTACHED_ONLY_BY_POSITION;
        return tagged(item);
      });
      toAdd.push(...lecturaItems);
      drawnLecturas.set(token.id, { signature, ids: lecturaItems.map((item) => item.id), token, state });
    }
    for (const [tokenId, drawn] of drawnLecturas) {
      if (!wanted.has(tokenId)) {
        toDelete.push(...drawn.ids);
        drawnLecturas.delete(tokenId);
      }
    }

    if (toUpdate.size > 0) {
      const ids = new Set([...toUpdate.keys()].flatMap((tokenId) => drawnLecturas.get(tokenId)?.ids ?? []));
      await OBR.scene.local.updateItems(
        (item) => ids.has(item.id),
        (drafts) => {
          for (const item of drafts) {
            const tokenId = getLecturaTokenId(item);
            const drawn = drawnLecturas.get(tokenId);
            const state = toUpdate.get(tokenId);
            if (drawn && state) {
              applyLecturaState(item, drawn.token, state, ctx);
            }
          }
        }
      );
    }
  }

  // Added first: a rebuilt Lectura replaces the old one without a gap.
  if (toAdd.length > 0) {
    await OBR.scene.local.addItems(toAdd);
  }
  if (toDelete.length > 0) {
    await OBR.scene.local.deleteItems(toDelete);
  }
  if (fixed && drawnOrigin) {
    drawnWaiters.get(fixed.id)?.();
  }
}

/** The toolbar's X: there while a Medición fija is, in the room's language. */
function syncClearAction(language: Language | null) {
  if (language === clearActionLanguage) {
    return;
  }
  clearActionLanguage = language;
  // Refused (Owlbear not ready, say): tried again on the next pass.
  const retry = (error: unknown) => {
    console.error("Rising Ranges: failed to update the Medición fija's X", error);
    if (clearActionLanguage === language) {
      clearActionLanguage = undefined;
    }
  };
  if (!language) {
    OBR.tool.removeAction(CLEAR_ACTION_ID).catch(retry);
    return;
  }
  OBR.tool.createAction({
    id: CLEAR_ACTION_ID,
    icons: [
      {
        icon: unpinIcon,
        label: translate(language, "toolbar.clearFixed"),
        filter: {
          activeTools: ["rodeo.owlbear.tool/measure"],
          permissions: ["RULER_CREATE"],
        },
      },
    ],
    onClick() {
      clearFixedMedicion();
    },
  }).catch(retry);
}

/** Runs reconcile() once at a time; a change landing mid-run gets one more pass afterwards. */
function schedule() {
  dirty = true;
  if (running) {
    return;
  }
  running = true;
  (async () => {
    while (dirty) {
      dirty = false;
      try {
        await reconcile();
      } catch (error) {
        console.error("Rising Ranges: failed to draw the Medición fija", error);
        resync = true;
      }
    }
    running = false;
  })();
}

async function loadScene() {
  const [nextMetadata, nextItems, nextDpi, nextScale] = await Promise.all([
    OBR.scene.getMetadata(),
    OBR.scene.items.getItems(),
    OBR.scene.grid.getDpi(),
    OBR.scene.grid.getScale(),
  ]);
  metadata = nextMetadata;
  items = nextItems;
  dpi = nextDpi;
  gridScale = nextScale;
  sceneReady = true;
  resync = true;
  schedule();
}

export async function startFixedMedicion() {
  OBR.scene.onReadyChange((ready) => {
    if (ready) {
      loadScene().catch((error) => console.error("Rising Ranges: failed to load the Medición fija", error));
      return;
    }
    // The scene's local items go with it, and a point on its map means
    // nothing on the next one.
    sceneReady = false;
    drawnOrigin = null;
    drawnLecturas.clear();
    live.clear();
    secret = null;
    if (shared?.owner === myConnectionId) {
      clearFixedMedicion();
    } else {
      schedule();
    }
  });
  OBR.scene.items.onChange((next) => {
    items = next;
    if (current() || drawnOrigin) {
      schedule();
    }
  });
  OBR.scene.onMetadataChange((next) => {
    metadata = next;
    schedule();
  });
  OBR.scene.grid.onChange(async () => {
    [dpi, gridScale] = await Promise.all([OBR.scene.grid.getDpi(), OBR.scene.grid.getScale()]);
    schedule();
  });
  OBR.room.onMetadataChange((next) => {
    const fixed = parseFixed(next[METADATA_KEY]);
    if (JSON.stringify(fixed) === JSON.stringify(shared)) {
      return;
    }
    shared = fixed;
    // Someone else's replaces this GM's secret one: one at a time.
    if (fixed) {
      secret = null;
    }
    schedule();
  });
  OBR.party.onChange((players) => {
    connected = new Set(players.map((player) => player.connectionId));
    schedule();
  });
  OBR.player.onChange((player) => {
    if (player.role !== role) {
      role = player.role;
      schedule();
    }
  });
  // The color theme is picked on another page of this extension and only
  // stored in localStorage, which tells other same-origin pages it changed.
  window.addEventListener("storage", (event) => {
    if (event.key && THEME_STORAGE_KEYS.includes(event.key) && drawnOrigin) {
      schedule();
    }
  });
  const [connectionId, nextRole, players, roomMetadata] = await Promise.all([
    OBR.player.getConnectionId(),
    OBR.player.getRole(),
    OBR.party.getPlayers(),
    OBR.room.getMetadata(),
  ]);
  myConnectionId = connectionId;
  role = nextRole;
  connected = new Set(players.map((player) => player.connectionId));
  shared = parseFixed(roomMetadata[METADATA_KEY]);
  // This client's own, though it only just started: pinned before a reload,
  // which keeps the same connection. It doesn't outlive that.
  if (shared?.owner === myConnectionId) {
    shared = null;
    OBR.room.setMetadata({ [METADATA_KEY]: null }).catch((error) => {
      console.error("Rising Ranges: failed to remove a Medición fija left behind", error);
    });
  }
  if (await OBR.scene.isReady()) {
    await loadScene();
  } else {
    schedule();
  }
}
