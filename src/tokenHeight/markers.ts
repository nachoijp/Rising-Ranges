import OBR, {
  buildPath,
  isImage,
  isPath,
  type Image,
  type Item,
  type Path,
  type Vector2,
} from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { isPlainObject } from "../util/isPlainObject";
import { isPoint } from "../util/isPoint";
import { type Color, type Theme } from "../theme/themes";
import { BandSet, IconShape } from "../engine/types";
import { heightBandIndex, markerIconCount } from "../engine/heights";
import { measuredBands } from "../engine/bands";
import { buildIconStackCommands, getStrokeWidthRatio, Direction } from "../render/iconStack";
import { computeIconAnchor } from "../render/iconAnchor";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import { displayFromMetadata, type MarkerTuning } from "../settings/display";
import { deepEqual } from "../util/deepEqual";
import { globalSettingsFromMetadata, type MarkerStyle } from "../settings/globalSettings";

const METADATA_KEY = getPluginId("tokenHeight");

/**
 * Written while the token is being dragged (with the Medición tool): where
 * it's still stored, and where it's been dragged to. Lets every client draw
 * the marker where the token really is meanwhile (see heightOverlays.ts).
 */
export type MarkerDrag = { from: Vector2; to: Vector2 };

/**
 * What a marker stores: the token's height in grid units, signed (positive
 * up, negative down) — and `drag`, mid-drag. Never 0, except mid-drag: a
 * token lowered to the ground during a drag keeps its marker until it's
 * dropped, so other clients still know it's mid-drag (see heightOverlays.ts).
 * Clients before 1.3.0 read that as no marker: the ground.
 */
export type TokenHeightState = { height: number; drag?: MarkerDrag };

/** The older marker format: a Banda and a side of the ground. */
type LegacyTokenHeightState = { bandId: string; direction: Direction };

function storedState(item: Item): TokenHeightState | LegacyTokenHeightState | undefined {
  const metadata = item.metadata[METADATA_KEY];
  if (!isPlainObject(metadata)) {
    return undefined;
  }
  if (
    typeof metadata.height === "number" &&
    Number.isFinite(metadata.height) &&
    (metadata.height !== 0 || dragOf(metadata) !== undefined)
  ) {
    return { height: metadata.height };
  }
  if (typeof metadata.bandId === "string" && (metadata.direction === "up" || metadata.direction === "down")) {
    return { bandId: metadata.bandId, direction: metadata.direction };
  }
  return undefined;
}

function dragOf(metadata: Record<string, unknown>): MarkerDrag | undefined {
  const drag = metadata.drag;
  if (isPlainObject(drag) && isPoint(drag.from) && isPoint(drag.to)) {
    return { from: drag.from, to: drag.to };
  }
  return undefined;
}

/** The drag a marker was written in the middle of, if it was. */
export function getMarkerDrag(item: Item): MarkerDrag | undefined {
  const metadata = item.metadata[METADATA_KEY];
  return isPlainObject(metadata) ? dragOf(metadata) : undefined;
}

/**
 * A marker's height in grid units. An older marker stored a Banda instead:
 * it's read as that Banda's radius, or undefined (ground) if the Banda was
 * deleted.
 */
export function getTokenHeight(item: Item, bandSet: BandSet): number | undefined {
  const state = storedState(item);
  if (!state) {
    return undefined;
  }
  if ("height" in state) {
    return state.height;
  }
  const band = bandSet.bands.find((b) => b.id === state.bandId);
  return band && (state.direction === "up" ? band.radius : -band.radius);
}

export function isTokenHeightMarker(item: Item): item is Path {
  return isPath(item) && storedState(item) !== undefined;
}

/**
 * tokenId -> signed height in grid units (positive = up, negative = down).
 * A token with no marker, or whose old-style marker's Banda was deleted,
 * has no entry — treated as ground (0).
 */
export function tokenHeightsFromMarkers(markers: Item[], bandSet: BandSet): Map<string, number> {
  const heights = new Map<string, number>();
  for (const marker of markers) {
    const height = marker.attachedTo ? getTokenHeight(marker, bandSet) : undefined;
    if (marker.attachedTo && height !== undefined) {
      heights.set(marker.attachedTo, height);
    }
  }
  return heights;
}

export async function getAllTokenHeightMarkers(): Promise<Path[]> {
  return OBR.scene.items.getItems<Path>(isTokenHeightMarker);
}

/** Everything about a marker's look that's a room setting rather than its Banda's. */
export type MarkerLook = {
  style: MarkerStyle;
  /** The room's icon shape; a Banda's own iconShape overrides it. */
  iconShape: IconShape;
  tuning: MarkerTuning;
};

/** The marker look from already-fetched scene metadata. */
export function markerLookFromMetadata(metadata: Record<string, unknown>): MarkerLook {
  const display = displayFromMetadata(metadata);
  return {
    style: globalSettingsFromMetadata(metadata).markerStyle ?? "icons",
    iconShape: display.iconShape,
    tuning: display.marker,
  };
}

/** Everything a marker's look depends on that lives in scene metadata — one round trip for both. */
async function getActiveMarkerConfig(): Promise<{ bandSet: BandSet; look: MarkerLook }> {
  const sceneMetadata = await OBR.scene.getMetadata();
  return { bandSet: bandSetFromMetadata(sceneMetadata), look: markerLookFromMetadata(sceneMetadata) };
}

// The marker in the scene is never drawn: it stores the token's height and
// the shape of its icons, and every client draws the icons and label from
// it in its own color theme (see heightOverlays.ts). It's the same whoever
// writes it, so it has no color of its own: its fill and stroke are a
// placeholder at zero opacity.
const MARKER_COLOR = "#000000";
export const MARKER_STROKE_OPACITY = 0.65;

/** The color of the icons and label of a marker at this height, in a theme. */
export function markerBaseColor(height: number, bandSet: BandSet, theme: Theme): Color {
  return theme.colors[(heightBandIndex(height, bandSet) ?? 0) % theme.colors.length];
}

/** What a marker at a given height looks like: its icon stack and stroke. */
function markerAppearance(height: number, bandSet: BandSet, dpi: number, look: MarkerLook) {
  const bandIndex = heightBandIndex(height, bandSet) ?? 0;
  const shape = measuredBands(bandSet)[bandIndex]?.iconShape ?? look.iconShape;
  const direction: Direction = height > 0 ? "up" : "down";
  const { position, size } = look.tuning;
  return {
    commands: buildIconStackCommands(shape, markerIconCount(height, bandSet), dpi, size, position, direction),
    strokeWidth: dpi * getStrokeWidthRatio(shape),
  };
}

function markerName(height: number): string {
  return `Rising Ranges: ${height > 0 ? "+" : ""}${height}`;
}

/** Sets a marker draft's shape, position and state in place (shared by updates and refreshes). */
function applyMarkerGeometry(
  marker: Path,
  token: Image,
  height: number,
  bandSet: BandSet,
  dpi: number,
  look: MarkerLook,
  drag?: MarkerDrag
): void {
  const { commands, strokeWidth } = markerAppearance(height, bandSet, dpi, look);
  marker.commands = commands;
  marker.style.fillColor = MARKER_COLOR;
  marker.style.strokeWidth = strokeWidth;
  marker.style.fillOpacity = 0;
  marker.style.strokeOpacity = 0;
  marker.position = computeIconAnchor(token, dpi, look.tuning.position, look.tuning.distance);
  marker.visible = token.visible;
  marker.name = markerName(height);
  marker.metadata[METADATA_KEY] = markerState(height, drag);
}

function markerState(height: number, drag?: MarkerDrag): TokenHeightState {
  return drag ? { height, drag } : { height };
}

function buildTokenHeightMarker(
  token: Image,
  height: number,
  bandSet: BandSet,
  dpi: number,
  look: MarkerLook,
  drag?: MarkerDrag
): Path {
  const { commands, strokeWidth } = markerAppearance(height, bandSet, dpi, look);
  return buildPath()
    .commands(commands)
    .fillColor(MARKER_COLOR)
    .fillOpacity(0)
    .strokeColor(MARKER_COLOR)
    .strokeOpacity(0)
    .strokeWidth(strokeWidth)
    .position(computeIconAnchor(token, dpi, look.tuning.position, look.tuning.distance))
    .attachedTo(token.id)
    .layer("ATTACHMENT")
    .locked(true)
    .disableHit(true)
    .visible(token.visible)
    .name(markerName(height))
    .metadata({ [METADATA_KEY]: markerState(height, drag) })
    .build();
}

/**
 * Sets the tokens' height marker (a height of 0 clears it, unless mid-`drag`). An existing marker is updated in place,
 * never deleted and re-added: with a new id each time, a late write from
 * an earlier call could land after a newer one and undo it.
 *
 * The known* arguments let a caller that already has them (the Medición
 * tool, writing on every Z/X press) skip fetching them again — each fetch
 * is a round trip. Returns each token's marker as built here, so the caller
 * can pass it back as knownExisting next time.
 */
export async function setTokenHeightMarker(
  tokens: Image[],
  height: number,
  knownBandSet?: BandSet,
  knownDpi?: number,
  knownExisting?: Path[],
  knownLook?: MarkerLook,
  drag?: MarkerDrag
): Promise<Path[]> {
  if (tokens.length === 0) {
    return [];
  }
  if (height === 0 && !drag) {
    await clearTokenHeightMarker(
      tokens.map((token) => token.id),
      knownExisting
    );
    return [];
  }
  const [{ bandSet, look }, dpi] =
    knownBandSet !== undefined && knownDpi !== undefined && knownLook !== undefined
      ? [{ bandSet: knownBandSet, look: knownLook }, knownDpi]
      : await Promise.all([getActiveMarkerConfig(), OBR.scene.grid.getDpi()]);
  const tokenById = new Map(tokens.map((token) => [token.id, token]));
  const tokenIds = tokens.map((token) => token.id);
  const existing = knownExisting
    ? knownExisting.filter(
        (item) => isTokenHeightMarker(item) && tokenIds.includes(item.attachedTo ?? "")
      )
    : await OBR.scene.items.getItems<Path>(
        (item): item is Path => isTokenHeightMarker(item) && tokenIds.includes(item.attachedTo ?? "")
      );
  const existingIds = new Set(existing.map((item) => item.id));
  const tokensWithExisting = new Set(
    existing.map((item) => item.attachedTo).filter((id): id is string => Boolean(id))
  );

  if (existing.length > 0) {
    await OBR.scene.items.updateItems(
      (item): item is Path => existingIds.has(item.id),
      (draft) => {
        for (const marker of draft) {
          const token = marker.attachedTo ? tokenById.get(marker.attachedTo) : undefined;
          if (!token) {
            continue;
          }
          applyMarkerGeometry(marker, token, height, bandSet, dpi, look, drag);
        }
      }
    );
  }

  const newMarkers = tokens
    .filter((token) => !tokensWithExisting.has(token.id))
    .map((token) =>
      buildTokenHeightMarker(token, height, bandSet, dpi, look, drag)
    );
  if (newMarkers.length > 0) {
    await OBR.scene.items.addItems(newMarkers);
  }

  return [...existing, ...newMarkers];
}

export async function clearTokenHeightMarker(
  tokenIds: string[],
  knownExisting?: Path[]
): Promise<void> {
  if (tokenIds.length === 0) {
    return;
  }
  const existing = knownExisting
    ? knownExisting.filter(
        (item) => isTokenHeightMarker(item) && tokenIds.includes(item.attachedTo ?? "")
      )
    : await OBR.scene.items.getItems<Path>(
        (item): item is Path => isTokenHeightMarker(item) && tokenIds.includes(item.attachedTo ?? "")
      );
  if (existing.length > 0) {
    await OBR.scene.items.deleteItems(existing.map((item) => item.id));
  }
}

/** Deletes every height marker in the scene — when the GM turns the height feature off. */
export async function clearAllTokenHeightMarkers(): Promise<void> {
  const markers = await getAllTokenHeightMarkers();
  if (markers.length > 0) {
    await OBR.scene.items.deleteItems(markers.map((item) => item.id));
  }
}

/**
 * Redraws every marker from the current Bandas and look (a Banda may
 * have been renamed or resized since), rewriting an old-style marker as a
 * plain height while at it. Updated in place, so they don't flicker for
 * everyone.
 */
export async function refreshAllTokenHeightMarkers(): Promise<void> {
  const [{ bandSet, look }, dpi, markers] = await Promise.all([
    getActiveMarkerConfig(),
    OBR.scene.grid.getDpi(),
    getAllTokenHeightMarkers(),
  ]);
  if (markers.length === 0) {
    return;
  }
  const tokenIds = markers
    .map((marker) => marker.attachedTo)
    .filter((id): id is string => Boolean(id));
  const tokens = await OBR.scene.items.getItems<Image>(
    (item): item is Image => isImage(item) && tokenIds.includes(item.id)
  );
  const tokenById = new Map(tokens.map((token) => [token.id, token]));

  // Derived on copies first, so only the markers that actually come out
  // different get written — most refreshes change nothing, and every write
  // counts against Owlbear's rate limit ("Too many requests").
  // A marker's drag is only current while its token is still stored where
  // the drag began; past that it's left over (a drag that never finished).
  const currentDrag = (marker: Path, token: Image) => {
    const drag = getMarkerDrag(marker);
    return drag && drag.from.x === token.position.x && drag.from.y === token.position.y ? drag : undefined;
  };
  const apply = (marker: Path) => {
    // undefined for an old-style marker whose Banda was deleted: left as
    // is, so a passing Bandas edit doesn't wipe markers the GM placed.
    // ...and 0 for one on the ground mid-drag: whoever's dragging it writes it.
    const height = getTokenHeight(marker, bandSet);
    const token = marker.attachedTo ? tokenById.get(marker.attachedTo) : undefined;
    if (!height || !token) {
      return;
    }
    applyMarkerGeometry(marker, token, height, bandSet, dpi, look, currentDrag(marker, token));
  };
  // One on the ground whose drag is over: it should have been removed then.
  const leftOver = markers
    .filter((marker) => {
      const token = marker.attachedTo ? tokenById.get(marker.attachedTo) : undefined;
      return getTokenHeight(marker, bandSet) === 0 && (!token || !currentDrag(marker, token));
    })
    .map((marker) => marker.id);
  if (leftOver.length > 0) {
    await OBR.scene.items.deleteItems(leftOver);
  }
  const changedIds = markers
    .filter((marker) => {
      const next = structuredClone(marker);
      apply(next);
      return !deepEqual(next, marker);
    })
    .map((marker) => marker.id);
  if (changedIds.length === 0) {
    return;
  }

  await OBR.scene.items.updateItems<Path>(changedIds, (draft) => {
    for (const marker of draft) {
      apply(marker);
    }
  });
}

