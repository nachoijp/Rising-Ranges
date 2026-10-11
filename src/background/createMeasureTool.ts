import OBR, {
  isImage,
  Math2,
  type GridScale,
  type Image,
  type InteractionManager,
  type Item,
  type ToolEvent,
  type Vector2,
} from "@owlbear-rodeo/sdk";
import measureIcon from "../assets/range.svg";
import { canUpdateItem } from "./permission";
import {
  LocalMeasureView,
  mirrorEnd,
  mirrorHeightText,
  mirrorPinned,
  mirrorStart,
  mirrorStates,
} from "./measureMirror";
import {
  enqueueOriginMarkerWrite,
  forgetCache,
  restoreOriginMarker,
  seedCache,
  writesSoFar,
  type OriginMarkerRequest,
} from "./originMarkerSync";
import { clearFixedMedicion, hasFixedMedicion, pinFixedMedicion, setFixedLive } from "./fixedMedicion";
import { setDraggedToken } from "./heightOverlays";
import { sameLecturaState, type LecturaContext, type LecturaState } from "../render/lecturaItems";
import { buildBandRingItems, buildGradientShaders, buildOriginAnchor } from "../render/bandRings";
import { getGridAxonometry, prefetchGridAxonometry } from "../util/gridAxonometry";
import { getTokenRadius } from "../render/iconAnchor";
import { getPluginId } from "../util/getPluginId";
import { getMetadata } from "../util/getMetadata";
import { getStoredTheme } from "../theme/themes";
import { computeLecturaState as computeSharedLecturaState, heightLabelText } from "../render/computeLectura";
import { stepHeight } from "../engine/heights";
import { BandSet } from "../engine/types";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import { resolveDisplay, showsDistance, type DisplaySettings } from "../settings/display";
import {
  getAllTokenHeightMarkers,
  getTokenHeight,
  markerLookFromMetadata,
  tokenHeightsFromMarkers,
  type MarkerLook,
} from "../tokenHeight/markers";
import { DEFAULT_LANGUAGE, languageFromMetadata, type Language } from "../i18n/language";
import { translate } from "../i18n/translate";
import {
  DEFAULT_GLOBAL_SETTINGS,
  globalSettingsFromMetadata,
  groundHotkey,
  letterToCode,
  type GlobalSettings,
} from "../settings/globalSettings";

// The Medición tool: drag from a point, or from a token to move it, and see
// rings around the Origen, a Lectura on every other token, and the Origen's
// height (Z/X raise or lower it, C puts it back on the ground). Everything below is the state of the one
// Medición in progress; cleanup() resets it.
//
// Released with Shift held, a Medición stays as the Medición fija (see
// fixedMedicion.ts). While that's up the tool only moves tokens, whose
// Lecturas it measures; Z/X/C change the dragged token's height, and a
// Shift+click removes it.

// Owlbear stops syncing an interaction to other clients 15s after it
// starts (undocumented): their rings vanish. The mirrored
// gradient, Lecturas and height label are ended for them at the same
// moment, slightly early since Owlbear's timer starts a little before ours.
const REMOTE_SYNC_CUTOFF_MS = 14900;
let remoteSyncCutoffTimer: ReturnType<typeof setTimeout> | null = null;

/** The Origen's anchor (see buildOriginAnchor) — the only item Owlbear syncs while it moves. */
let bandInteraction: InteractionManager<Item[]> | null = null;
/** The token being moved, when the Medición started on one. */
let tokenInteraction: InteractionManager<Item> | null = null;
/** What follows the Origen on this client: the gradient's shaders, the rings and their labels. */
let originItems: Item[] = [];
let grabOffset: Vector2 = { x: 0, y: 0 };
/** Where the pointer last was in this drag: a token's drag may start after some moves. */
let lastDragPointer: Vector2 | null = null;
/** This gesture only moves a token, under the Medición fija: no rings, and originHeight is that token's height. */
let fixedDrag = false;
/** The token the Medición started on (if the player may move it), as it was at the start. */
let downTarget: Item | null = null;
/** That token's height before this Medición changed it — restored on cancel. */
let originHeightBeforeEdit = 0;
/** Where the dragged token is now; downTarget keeps its starting position. */
let liveTokenPosition: Vector2 | null = null;

/** Where the rings are drawn. While a token is dragged they stay at its starting point. */
let activeCenter: Vector2 = { x: 0, y: 0 };
/** What the Lecturas measure from: follows the dragged token. */
let activeLecturaCenter: Vector2 = { x: 0, y: 0 };
let activeBandSet: BandSet | null = null;
let activeLanguage: Language = DEFAULT_LANGUAGE;
let activeSettings: GlobalSettings = DEFAULT_GLOBAL_SETTINGS;
let activeAltitudeEnabled = true;
let activeDisplay: DisplaySettings | null = null;
/** Whether any Lectura is drawn at all (a visual, a label, or both). */
let activeLecturasEnabled = true;
/** Whether Lectura labels show the distance, so each state carries it. */
let activeShowDistance = false;
let activeMarkerLook: MarkerLook | null = null;
let activeDpi = 0;
/** The grid's rhombus ratio, 0 on a flat grid (see axonometry.ts). */
let activeAxonometry = 0;
let activeGridScale: GridScale | null = null;
/** The Origen token's radius in grid units, 0 from a point. */
let activeOriginRadius = 0;
/** The Origen's height in grid units: 0 = ground, positive up, negative down. */
let originHeight = 0;
/** tokenId -> signed height in grid units, from the height markers. */
let activeTokenHeights: Map<string, number> = new Map();
// The measured tokens as they were when the Medición started: moves come in
// far faster than fresh reads could, so Lecturas measure this snapshot.
// Hidden ones only for the GM.
let activeTokens: Image[] = [];
/** The hidden tokens among activeTokens (GM only): their Lecturas are drawn here, never sent to anyone else. */
let hiddenTokenIds: Set<string> = new Set();
/**
 * A GM measuring from a hidden token: nothing of this Medición may reach the
 * players, or they'd see rings centered on a creature they can't see. The
 * rings are hidden items (the GM sees them faded, as Owlbear shows hidden
 * things), and nothing is mirrored.
 */
let secretMedicion = false;
/** This client's Lecturas and height label, and the last state drawn for each. */
let measureView: LocalMeasureView | null = null;
let activeLecturaStates: Map<string, LecturaState> = new Map();
let activeHeightLabelText = "";
// Bumped by cleanup(), so a handler that awaited can tell its Medición ended
// meanwhile and stop instead of drawing for it.
let toolDownGeneration = 0;
/** How long a pinned Medición's anchor outlives it (see releaseMedicion). */
const ANCHOR_LINGER_MS = 1500;
// Settles once the latest Medición is on screen (or gave up). A release with
// Shift waits for it: a quick click comes back before the Medición has
// anything to leave in place.
let toolDownSetup: Promise<void> = Promise.resolve();
// Settles once the press's token is known to be movable (downTarget set) or
// not. A drag can start before that: it waits for it.
let downTargetCheck: Promise<void> = Promise.resolve();
/** The Medición already left in place, so a second release of the same one doesn't pin it again. */
let pinnedGeneration = -1;
// The latest token move, waiting on its snapPosition reply. Released tokens
// wait for it, so they land where they were dropped. Never rejects.
let pendingMove: Promise<void> | null = null;

// Pointer moves come in faster than frames; redraws are coalesced to about
// one per 16ms. setTimeout rather than requestAnimationFrame: this runs in
// a hidden background page, where animation frames may never fire.
let pendingPointerPosition: Vector2 | null = null;
let refreshScheduled = false;
let pendingLecturaPosition: Vector2 | null = null;
let lecturaRefreshScheduled = false;

/** A Medición from a point: the rings, gradient, Lecturas and height label all follow the pointer. */
function scheduleRefresh(pointerPosition: Vector2) {
  pendingPointerPosition = pointerPosition;
  if (refreshScheduled) {
    return;
  }
  refreshScheduled = true;
  setTimeout(() => {
    refreshScheduled = false;
    if (!pendingPointerPosition) {
      return;
    }
    activeCenter = pendingPointerPosition;
    activeLecturaCenter = pendingPointerPosition;
    pendingPointerPosition = null;
    refreshBandPositions();
    refreshLecturas();
    measureView?.moveHeightLabel(activeCenter);
    if (originItems.length > 0) {
      OBR.scene.local.updateItems(originItems, (items) => {
        for (const item of items) {
          const offset = getMetadata(item.metadata, getPluginId("offset"), { x: 0, y: 0 });
          item.position = Math2.subtract(activeCenter, offset);
        }
      });
    }
  }, 16);
}

/** A token being moved: only the Lecturas follow it; the rings stay where it started. */
function scheduleLecturaRefresh(position: Vector2) {
  pendingLecturaPosition = position;
  if (lecturaRefreshScheduled) {
    return;
  }
  lecturaRefreshScheduled = true;
  setTimeout(() => {
    lecturaRefreshScheduled = false;
    if (!pendingLecturaPosition) {
      return;
    }
    activeLecturaCenter = pendingLecturaPosition;
    pendingLecturaPosition = null;
    refreshLecturas();
  }, 16);
}

function currentHeightLabelText() {
  return heightLabelText(originHeight, activeBandSet, activeGridScale, activeLanguage);
}

/** downTarget at its current dragged position. */
function liveDownTargetImage(): Image | undefined {
  if (!downTarget || !isImage(downTarget)) {
    return undefined;
  }
  return liveTokenPosition ? { ...downTarget, position: liveTokenPosition } : downTarget;
}

/**
 * A marker write for the Origen token, built from the current Medición — so
 * it can be built before cleanup() resets that and written after. null when
 * no token is grabbed. `position` puts the marker where the token really
 * ends up, when that isn't where it's being dragged.
 */
function originMarkerRequest(height: number, position?: Vector2): OriginMarkerRequest | null {
  const live = liveDownTargetImage();
  if (!live || !activeBandSet || !activeMarkerLook) {
    return null;
  }
  const token = position ? { ...live, position } : live;
  // Mid-drag, the token is still stored where it was: the marker says so
  // (see heightOverlays.ts).
  const draggedFrom = position ? undefined : downTarget?.position;
  return { token, height, bandSet: activeBandSet, dpi: activeDpi, look: activeMarkerLook, attempt: 0, draggedFrom };
}

/** One token's Lectura, as the measuring client computes it — every client draws it from this. */
function computeLecturaState(token: Image, bandSet: BandSet): LecturaState {
  return computeSharedLecturaState(
    token,
    token.position,
    activeTokenHeights.get(token.id) ?? 0,
    { center: activeLecturaCenter, height: originHeight, radius: activeOriginRadius },
    { bandSet, dpi: activeDpi, axonometry: activeAxonometry, display: activeDisplay, showDistance: activeShowDistance }
  );
}

/** The Lecturas other clients may see: none of a hidden token's. */
function sharedStates(states: Record<string, LecturaState>): Record<string, LecturaState> {
  return Object.fromEntries(Object.entries(states).filter(([tokenId]) => !hiddenTokenIds.has(tokenId)));
}

/** Moves the rings and their labels to activeCenter. */
function refreshBandPositions() {
  if (!bandInteraction) {
    return;
  }
  const update = bandInteraction[0];
  update((draft) => {
    for (const item of draft) {
      const offset = getMetadata(item.metadata, getPluginId("offset"), { x: 0, y: 0 });
      item.position = Math2.subtract(activeCenter, offset);
    }
  });
}

/** Recomputes every Lectura, but only redraws (and sends) the ones that changed. */
function refreshLecturas() {
  if (!measureView || !activeBandSet || !activeLecturasEnabled) {
    return;
  }
  const changed: Record<string, LecturaState> = {};
  let anyChanged = false;
  for (const token of activeTokens) {
    const state = computeLecturaState(token, activeBandSet);
    if (!sameLecturaState(activeLecturaStates.get(token.id), state)) {
      activeLecturaStates.set(token.id, state);
      changed[token.id] = state;
      anyChanged = true;
    }
  }
  if (anyChanged) {
    measureView.applyStates(changed);
    const shared = sharedStates(changed);
    if (Object.keys(shared).length > 0) {
      mirrorStates(shared);
    }
  }
}

function refreshHeightLabel() {
  if (!measureView || !activeAltitudeEnabled) {
    return;
  }
  const text = currentHeightLabelText();
  if (text !== activeHeightLabelText) {
    activeHeightLabelText = text;
    measureView.setHeightText(text);
    mirrorHeightText(text);
  }
}

/** Ends the Medición on screen (here and for everyone) and resets its state. */
function cleanup() {
  if (remoteSyncCutoffTimer) {
    clearTimeout(remoteSyncCutoffTimer);
    remoteSyncCutoffTimer = null;
  }
  if (bandInteraction) {
    bandInteraction[1]();
    bandInteraction = null;
  }
  if (tokenInteraction) {
    tokenInteraction[1]();
    tokenInteraction = null;
  }
  if (originItems.length > 0) {
    OBR.scene.local.deleteItems(originItems.map((item) => item.id));
    originItems = [];
  }
  if (measureView) {
    measureView.end();
    measureView = null;
  }
  mirrorEnd();
  toolDownGeneration++;
  activeLecturaStates = new Map();
  activeHeightLabelText = "";
  downTarget = null;
  activeBandSet = null;
  activeDisplay = null;
  activeMarkerLook = null;
  activeGridScale = null;
  originHeight = 0;
  activeTokens = [];
  hiddenTokenIds = new Set();
  secretMedicion = false;
  activeTokenHeights = new Map();
  pendingPointerPosition = null;
  pendingLecturaPosition = null;
  originHeightBeforeEdit = 0;
  forgetCache();
  liveTokenPosition = null;
  pendingMove = null;
  fixedDrag = false;
  lastDragPointer = null;
}

// Owlbear refuses bursts of scene writes ("Too many requests"). The waits
// grow, so a short limit costs little and a longer one still gets a chance.
const SAVE_RETRY_DELAYS_MS = [50, 100, 200];

/**
 * Saves the dragged token's final position (and brings it and its
 * attachments to the top), retrying refused writes, then ends the drag. If
 * every attempt fails the token goes back where it started. Returns where
 * it landed, or null if it went back.
 */
async function saveTokenPosition(interaction: InteractionManager<Item>): Promise<Vector2 | null> {
  const final = interaction[0](() => {});
  try {
    for (let attempt = 0; ; attempt++) {
      try {
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
        return final.position;
      } catch (error) {
        if (attempt >= SAVE_RETRY_DELAYS_MS.length) {
          console.error("Rising Ranges: failed to save the dragged token's position", error);
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, SAVE_RETRY_DELAYS_MS[attempt]));
      }
    }
  } finally {
    interaction[1]();
  }
}

/**
 * Ends a released Medición. Everything on screen goes right away; the
 * token's new position and then its marker are written afterwards. What
 * those writes need is taken first: a new Medición starting meanwhile runs
 * cleanup(), which would cancel the drag and reset that state.
 */
async function releaseMedicion(pin: boolean) {
  const interaction = tokenInteraction;
  tokenInteraction = null;
  if (pin && !fixedDrag) {
    const before = toolDownGeneration;
    const tokenBefore = downTarget?.id;
    const startBefore = downTarget?.position;
    const markerBefore = activeAltitudeEnabled ? originMarkerRequest(originHeight) : null;
    await toolDownSetup;
    // A new press meanwhile already ended this Medición, and everything
    // read from here on would be its: only the dragged token, and its
    // marker, are ours to finish.
    if (toolDownGeneration !== before) {
      const landed = interaction ? await saveTokenPosition(interaction) : null;
      const position = landed ?? startBefore;
      await enqueueOriginMarkerWrite(
        markerBefore && position
          ? { ...markerBefore, token: { ...markerBefore.token, position }, draggedFrom: undefined }
          : markerBefore
      );
      if (tokenBefore) {
        setDraggedToken(tokenBefore, null);
      }
      return;
    }
  }
  const startPosition = downTarget?.position;
  const markerRequest = activeAltitudeEnabled ? originMarkerRequest(originHeight) : null;
  const generation = toolDownGeneration;
  const fixedTokenId = fixedDrag ? downTarget?.id : undefined;
  const draggedTokenId = downTarget?.id;
  // Left in place where its Origen is now: from a dragged token, where it's
  // dropped. activeBandSet is only set once the Medición is on screen.
  const pinRequest =
    pin && !fixedDrag && activeBandSet && pinnedGeneration !== generation
      ? {
          center: pendingPointerPosition ?? activeCenter,
          height: activeAltitudeEnabled ? originHeight : 0,
          radius: activeOriginRadius,
          secret: secretMedicion,
          fromToken: !!downTarget,
        }
      : null;
  // The last snapped move, so the token lands where it was dropped.
  if (pendingMove) {
    await pendingMove;
  }
  if (pinRequest) {
    pinnedGeneration = generation;
    const { fromToken, secret, ...origin } = pinRequest;
    const dropped = liveTokenPosition ?? startPosition;
    // Its rings, gradient, height label and Lecturas become the Medición
    // fija's, rather than going while it draws its own: nothing blinks.
    const handedOver = originItems.map((item) => item.id);
    originItems = [];
    if (measureView) {
      handedOver.push(...(await measureView.handOver()));
    }
    const pinned = pinFixedMedicion(
      { ...origin, center: fromToken && dropped ? dropped : origin.center },
      secret,
      handedOver
    );
    if (pinned.shared && generation === toolDownGeneration) {
      mirrorPinned(pinned.shared);
      // Everyone else's rings ride on the Origen's anchor, which goes when
      // its interaction ends: kept a little longer, so they're still up
      // until those clients have drawn the Medición fija.
      const anchor = bandInteraction;
      bandInteraction = null;
      if (anchor) {
        setTimeout(() => anchor[1](), ANCHOR_LINGER_MS);
      }
    }
    await pinned.drawn;
  }
  // A new Medición that started meanwhile already ended this one; cleaning
  // up again would end the new one instead.
  if (generation === toolDownGeneration) {
    cleanup();
  }
  const landed = interaction ? await saveTokenPosition(interaction) : null;
  // The marker goes where the token really ended up: where it was dropped
  // if that was saved, back at the start otherwise.
  const position = landed ?? startPosition;
  await enqueueOriginMarkerWrite(
    markerRequest && position
      ? { ...markerRequest, token: { ...markerRequest.token, position }, draggedFrom: undefined }
      : markerRequest
  );
  // Only now: until the token's position and marker are saved, the scene
  // still has it where it was.
  if (fixedTokenId) {
    setFixedLive(fixedTokenId, null);
  }
  if (draggedTokenId) {
    setDraggedToken(draggedTokenId, null);
  }
}

/** Ends a cancelled Medición: the token goes back, and so does its marker. */
async function cancelMedicion() {
  const restore = activeAltitudeEnabled ? originMarkerRequest(originHeightBeforeEdit, downTarget?.position) : null;
  const fixedTokenId = fixedDrag ? downTarget?.id : undefined;
  const draggedTokenId = downTarget?.id;
  cleanup();
  if (fixedTokenId) {
    setFixedLive(fixedTokenId, null);
  }
  if (draggedTokenId) {
    setDraggedToken(draggedTokenId, null);
  }
  await restoreOriginMarker(restore);
}

/** Moves the dragged token under the pointer, snapped. */
async function moveDraggedToken(pointer: Vector2) {
  if (!tokenInteraction) {
    return;
  }
  const update = tokenInteraction[0];
  const move = OBR.scene.grid.snapPosition(Math2.subtract(pointer, grabOffset)).then((position) => {
    update((token) => {
      token.position = position;
    });
    liveTokenPosition = position;
    if (downTarget) {
      setDraggedToken(downTarget.id, position);
    }
    if (fixedDrag && downTarget) {
      setFixedLive(downTarget.id, { position, height: originHeight });
    } else {
      scheduleLecturaRefresh(position);
    }
  });
  pendingMove = move.catch((error) => {
    console.error("Rising Ranges: failed to snap the dragged token", error);
  });
  await pendingMove;
}

/**
 * A press under the Medición fija: on a token the player may move, just
 * that token's drag, with what moving it and changing its height needs.
 */
async function startFixedDrag(event: ToolEvent) {
  const generation = toolDownGeneration;
  const target = event.target;
  if (!target || target.locked || !isImage(target)) {
    return;
  }
  fixedDrag = true;
  grabOffset = Math2.subtract(event.pointerPosition, target.position);
  const writesBeforeFetch = writesSoFar();
  // downTarget is only set once the token's height is known too: a drag
  // waits for it (downTargetCheck), and its Lectura would otherwise be
  // measured from the ground meanwhile.
  const ready = (async () => {
    const [canUpdate, sceneMetadata, dpi, axonometry, heightMarkers] = await Promise.all([
      canUpdateItem(target),
      OBR.scene.getMetadata(),
      OBR.scene.grid.getDpi(),
      getGridAxonometry(),
      getAllTokenHeightMarkers(),
    ]);
    if (generation !== toolDownGeneration || !canUpdate) {
      return;
    }
    activeBandSet = bandSetFromMetadata(sceneMetadata);
    activeSettings = globalSettingsFromMetadata(sceneMetadata);
    activeAltitudeEnabled = activeSettings.enableAltitude ?? true;
    activeMarkerLook = markerLookFromMetadata(sceneMetadata);
    activeDpi = dpi;
    activeAxonometry = axonometry;
    if (activeAltitudeEnabled) {
      const marker = heightMarkers.find((m) => m.attachedTo === target.id);
      originHeight = (marker && getTokenHeight(marker, activeBandSet)) || 0;
      originHeightBeforeEdit = originHeight;
      seedCache(target.id, marker ? [marker] : [], writesBeforeFetch);
    }
    downTarget = target;
  })();
  downTargetCheck = ready.catch(() => {});
  try {
    await ready;
  } catch (error) {
    // That press just does nothing (no downTarget, so no drag).
    console.error("Rising Ranges: failed to start moving a token", error);
  }
}

export function createMeasureTool(language: Language, settings: GlobalSettings) {
  prefetchGridAxonometry();
  OBR.tool.createMode({
    id: getPluginId("mode/measure"),
    icons: [
      {
        icon: measureIcon,
        label: translate(language, "toolbar.medicion"),
        filter: {
          activeTools: ["rodeo.owlbear.tool/measure"],
          permissions: ["RULER_CREATE"],
        },
      },
    ],
    onToolClick() {
      return false;
    },
    async onToolDown(_, event) {
      cleanup();
      if (hasFixedMedicion()) {
        if (event.shiftKey) {
          await clearFixedMedicion();
        } else {
          await startFixedDrag(event);
        }
        return;
      }
      let setupDone = () => {};
      toolDownSetup = new Promise<void>((resolve) => {
        setupDone = resolve;
      });
      try {
        const generation = toolDownGeneration;

        const tokenPosition = event.target && !event.target.locked && event.target.position;
        const initialPosition = tokenPosition || event.pointerPosition;
        // So a grabbed token doesn't jump to center on the pointer.
        grabOffset = tokenPosition ? Math2.subtract(event.pointerPosition, tokenPosition) : { x: 0, y: 0 };

        // Everything is fetched at once: each call is a round trip, and the
        // Medición can't appear until all are back. downTarget is set as soon
        // as the permission check resolves — the drag handlers route on it.
        const target = event.target;
        const permissionCheck =
          target && !target.locked && target.type === "IMAGE"
            ? canUpdateItem(target).then((canUpdate) => {
                if (canUpdate && generation === toolDownGeneration) {
                  downTarget = target;
                }
              })
            : Promise.resolve();
        downTargetCheck = permissionCheck.catch(() => {});
        const writesBeforeFetch = writesSoFar();
        const [sceneMetadata, dpi, gridScale, axonometry, characterImages, allHeightMarkers, role] = await Promise.all([
          OBR.scene.getMetadata(),
          OBR.scene.grid.getDpi(),
          OBR.scene.grid.getScale(),
          getGridAxonometry(),
          OBR.scene.items.getItems<Image>((item): item is Image => isImage(item) && item.layer === "CHARACTER"),
          getAllTokenHeightMarkers(),
          OBR.player.getRole(),
          permissionCheck,
        ]);
        if (generation !== toolDownGeneration) {
          return;
        }
        const language = languageFromMetadata(sceneMetadata);
        const bandSet = bandSetFromMetadata(sceneMetadata);

        const theme = getStoredTheme();
        activeCenter = initialPosition;
        activeLecturaCenter = initialPosition;
        activeBandSet = bandSet;
        activeLanguage = language;
        activeSettings = globalSettingsFromMetadata(sceneMetadata);
        activeAltitudeEnabled = activeSettings.enableAltitude ?? true;
        activeDisplay = resolveDisplay(activeSettings.display, bandSet, activeSettings);
        activeLecturasEnabled = activeDisplay.lecturaStyle !== "none" || activeDisplay.lecturaLabel !== "none";
        activeShowDistance = showsDistance(activeDisplay.lecturaLabel);
        activeMarkerLook = markerLookFromMetadata(sceneMetadata);
        activeDpi = dpi;
        activeAxonometry = axonometry;
        activeGridScale = gridScale;
        activeOriginRadius = downTarget && isImage(downTarget) ? getTokenRadius(downTarget, dpi, axonometry) : 0;

        // Added while the rings' interaction starts below, not before it.
        const shaders = buildGradientShaders(initialPosition, theme, bandSet, dpi, activeOriginRadius, axonometry);
        originItems = shaders;
        const shadersAdded = OBR.scene.local.addItems(shaders);

        const heightMarkers = activeAltitudeEnabled ? allHeightMarkers : [];
        // A player's client still has hidden tokens (Owlbear just doesn't draw
        // them): measuring them would show their Lecturas.
        activeTokens = characterImages.filter(
          (item) => item.id !== downTarget?.id && (role === "GM" || item.visible)
        );
        hiddenTokenIds = new Set(activeTokens.filter((item) => !item.visible).map((item) => item.id));
        secretMedicion = target?.type === "IMAGE" && !target.visible;
        activeTokenHeights = tokenHeightsFromMarkers(heightMarkers, bandSet);

        // A Medición started on a token with a height marker starts at that
        // height.
        originHeight = 0;
        if (activeAltitudeEnabled) {
          const originId = event.target?.id;
          const originMarker = originId && heightMarkers.find((m) => m.attachedTo === originId);
          originHeight = (originMarker && getTokenHeight(originMarker, bandSet)) || 0;
          originHeightBeforeEdit = downTarget ? originHeight : 0;
          if (downTarget) {
            seedCache(downTarget.id, originMarker ? [originMarker] : [], writesBeforeFetch);
          } else {
            forgetCache();
          }
        } else {
          originHeightBeforeEdit = 0;
          forgetCache();
        }
        if (generation !== toolDownGeneration) {
          return;
        }
        const ringItems = buildBandRingItems(
          activeCenter,
          theme,
          bandSet,
          dpi,
          gridScale,
          activeDisplay.ringLabel,
          activeDisplay.ringLabelSize,
          activeOriginRadius,
          axonometry
        );
        const anchor = buildOriginAnchor(activeCenter);
        if (secretMedicion) {
          for (const item of [anchor, ...ringItems]) {
            item.visible = false;
          }
        }
        const [interaction] = await Promise.all([
          OBR.interaction.startItemInteraction([anchor]),
          shadersAdded,
          OBR.scene.local.addItems(ringItems),
        ]);
        if (generation !== toolDownGeneration) {
          interaction[1]();
          // cleanup() may have run before these finished adding.
          OBR.scene.local.deleteItems([...shaders, ...ringItems].map((item) => item.id));
          return;
        }
        bandInteraction = interaction;
        originItems = [...shaders, ...ringItems];
        remoteSyncCutoffTimer = setTimeout(() => {
          remoteSyncCutoffTimer = null;
          mirrorEnd();
        }, REMOTE_SYNC_CUTOFF_MS);

        const ctx: LecturaContext = {
          bandSet,
          theme,
          dpi,
          axonometry,
          language,
          gridScale,
          showDistance: activeShowDistance,
          display: activeDisplay,
        };
        activeLecturaStates = new Map();
        if (activeLecturasEnabled) {
          for (const token of activeTokens) {
            activeLecturaStates.set(token.id, computeLecturaState(token, bandSet));
          }
        }
        const states = Object.fromEntries(activeLecturaStates);
        activeHeightLabelText = currentHeightLabelText();
        const heightLabel = activeAltitudeEnabled ? { center: activeCenter, text: activeHeightLabelText } : null;
        measureView = new LocalMeasureView(ctx);
        measureView.start(activeTokens, states, heightLabel);
        // Only now: other clients attach what they draw to the anchor, so it
        // has to exist for them first.
        if (!secretMedicion) {
          mirrorStart({
            ctx,
            states: sharedStates(states),
            shaders,
            ringId: anchor.id,
            heightLabel,
            origin: { center: activeCenter, radius: activeOriginRadius },
          });
        }
      } finally {
        setupDone();
      }
    },
    async onToolDragStart() {
      const generation = toolDownGeneration;
      await downTargetCheck;
      if (downTarget && generation === toolDownGeneration) {
        const interaction = await OBR.interaction.startItemInteraction(downTarget);
        // Released before this came back: nothing else would end it.
        if (generation !== toolDownGeneration) {
          interaction[1]();
          return;
        }
        tokenInteraction = interaction;
        // Moves that came in while the drag was starting were dropped: catch up.
        if (lastDragPointer) {
          await moveDraggedToken(lastDragPointer);
        }
      }
    },
    async onToolDragMove(_, event) {
      lastDragPointer = event.pointerPosition;
      if (downTarget) {
        if (tokenInteraction) {
          await moveDraggedToken(event.pointerPosition);
        }
      } else if (bandInteraction) {
        scheduleRefresh(event.pointerPosition);
      }
    },
    onKeyDown(_, event) {
      const fixedDragging = fixedDrag && !!downTarget && !!activeMarkerLook;
      if (!(bandInteraction || fixedDragging) || event.repeat || !activeAltitudeEnabled) {
        return;
      }
      if (!activeBandSet) {
        return;
      }
      let next: number;
      if (event.code === letterToCode(activeSettings.hotkeyRaise)) {
        next = stepHeight(originHeight, 1, activeBandSet);
      } else if (event.code === letterToCode(activeSettings.hotkeyLower)) {
        next = stepHeight(originHeight, -1, activeBandSet);
      } else if (event.code === letterToCode(groundHotkey(activeSettings))) {
        next = 0;
      } else {
        return;
      }
      if (next === originHeight) {
        return;
      }
      originHeight = next;
      if (fixedDragging && downTarget) {
        setFixedLive(downTarget.id, { position: liveTokenPosition ?? downTarget.position, height: next });
      }
      refreshLecturas();
      refreshHeightLabel();
      // The marker follows too; not awaited, writes are queued.
      if (downTarget) {
        enqueueOriginMarkerWrite(originMarkerRequest(originHeight));
      }
    },
    async onToolDragEnd(_, event) {
      await releaseMedicion(event.shiftKey);
    },
    async onToolDragCancel() {
      await cancelMedicion();
    },
    async onDeactivate() {
      await cancelMedicion();
    },
    async onToolUp(_, event) {
      await releaseMedicion(event.shiftKey);
    },
    shortcut: settings.hotkeyActivate,
    cursors: [
      {
        cursor: "grabbing",
        filter: {
          dragging: true,
          target: [{ value: "IMAGE", key: "type" }],
        },
      },
      {
        cursor: "grab",
        filter: {
          dragging: false,
          target: [
            { value: "IMAGE", key: "type" },
            { value: false, key: "locked" },
          ],
        },
      },
      {
        cursor: "crosshair",
      },
    ],
  });
}
