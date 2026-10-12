import type { Image, Item, Vector2 } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { isPlainObject } from "../util/isPlainObject";
import { isPoint } from "../util/isPoint";

// On an axonometric grid a raised token is drawn raised (see isoLift.ts):
// its image is moved up on screen by its height, while the token itself —
// its position, which is what Owlbear snaps, fogs and lights, and what every
// distance is measured from — stays on the floor. Moving only the image
// means moving its anchor, `grid.offset` (where in the image the position
// is), which is part of the token and so shared and saved with it. The
// token keeps the offset it had before in its metadata, to be put back.
//
// Owlbear resizes and rotates a token around its drawn image, so a raised
// token resized or rotated by hand lands with its position — its place on
// the floor — somewhere else. The token also keeps where it stood and its
// scale and rotation; one found rescaled or rotated and moved together was
// transformed, and is put back where it stood.

const METADATA_KEY = getPluginId("lift");

/**
 * What's stored on a raised token: its own offset (`base`), the one written
 * over it (`applied`), how far up that draws it on screen (`screen`, px,
 * negative = down), and where it stood, at what scale and rotation, when
 * last written.
 */
export type TokenLift = {
  base: Vector2;
  applied: Vector2;
  screen: number;
  position?: Vector2;
  scale?: Vector2;
  rotation?: number;
};

const EPSILON = 1e-6;
/** How far off a token put back after a resize is put (scene px, see plannedLift). */
const NUDGE = 1e-3;

function samePoint(a: Vector2, b: Vector2): boolean {
  return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON;
}

export function getTokenLift(item: Item): TokenLift | undefined {
  const stored = item.metadata[METADATA_KEY];
  if (isPlainObject(stored) && isPoint(stored.base) && isPoint(stored.applied) && Number.isFinite(stored.screen)) {
    const lift: TokenLift = { base: stored.base, applied: stored.applied, screen: stored.screen as number };
    if (isPoint(stored.position) && isPoint(stored.scale) && Number.isFinite(stored.rotation)) {
      lift.position = stored.position;
      lift.scale = stored.scale;
      lift.rotation = stored.rotation as number;
    }
    return lift;
  }
  return undefined;
}

/**
 * The stored lift, only while the token still has the offset it wrote: one
 * changed since (a new image, an edit by hand) has replaced it.
 */
function currentLift(token: Image): TokenLift | undefined {
  const lift = getTokenLift(token);
  return lift && samePoint(lift.applied, token.grid.offset) ? lift : undefined;
}

/** How far up the token's image is drawn now, px on screen (negative = down); 0 when it isn't moved. */
export function activeLift(token: Image): number {
  return currentLift(token)?.screen ?? 0;
}

/** The token as it is on the floor: with its own offset back, if it's raised. */
export function onFloor(token: Image): Image {
  const lift = currentLift(token);
  return lift ? { ...token, grid: { ...token.grid, offset: lift.base } } : token;
}

/**
 * The token as it's drawn, for placing things beside it by its footprint
 * (getTokenBounds, which doesn't turn it): on the floor, moved up by its
 * lift. Its own anchor is moved off the image's middle, so turning it
 * moves the image's box sideways; this one stays above the floor, as the
 * image does.
 */
export function asDrawn(token: Image): Image {
  const lift = activeLift(token);
  if (!lift) {
    return token;
  }
  const floor = onFloor(token);
  return { ...floor, position: { x: floor.position.x, y: floor.position.y - lift } };
}

/**
 * How much the anchor moves (image px) to draw the image `screen` px up on
 * screen, whatever the token's rotation, scale or image resolution: the
 * image is drawn at position + R(rotation)·(scale·k·(p − offset)), with
 * k = scene dpi / image dpi.
 */
export function liftOffsetDelta(token: Image, screen: number, dpi: number): Vector2 {
  const k = dpi / token.grid.dpi;
  const angle = (token.rotation * Math.PI) / 180;
  return {
    x: (screen * Math.sin(angle)) / (k * token.scale.x),
    y: (screen * Math.cos(angle)) / (k * token.scale.y),
  };
}

/**
 * How far the top of the token's image is above its anchor on screen (px,
 * at least 0), however it's turned: the highest of its corners, drawn at
 * position + R(rotation)·(scale·k·(p − offset)). On the floor token (see
 * onFloor), so it's its own anchor's — its feet, once aligned.
 */
export function headAbove(token: Image, dpi: number): number {
  const k = dpi / token.grid.dpi;
  const angle = (token.rotation * Math.PI) / 180;
  let top = 0;
  for (const px of [0, token.image.width]) {
    for (const py of [0, token.image.height]) {
      const x = token.scale.x * k * (px - token.grid.offset.x);
      const y = token.scale.y * k * (py - token.grid.offset.y);
      top = Math.min(top, x * Math.sin(angle) + y * Math.cos(angle));
    }
  }
  return -top;
}

/**
 * How far down a sunk token is drawn (px on screen, negative), `depth` px
 * below the floor: its head goes there, not its feet. Art for these grids
 * is mostly taller than wide, and moved down by its feet a shallow one
 * still covers the floor where it is.
 */
export function sunkLift(floor: Image, depth: number, dpi: number): number {
  return -Math.round(depth + headAbove(floor, dpi));
}

/**
 * Where a raised token resized or rotated by hand stood before: rescaled or
 * rotated and moved at once is the transform, not a drag (a drag keeps both).
 */
function standingBefore(lift: TokenLift, token: Image): Vector2 | undefined {
  if (!lift.position || !lift.scale || lift.rotation === undefined) {
    return undefined;
  }
  const transformed = !samePoint(lift.scale, token.scale) || Math.abs(lift.rotation - token.rotation) >= EPSILON;
  return transformed && !samePoint(lift.position, token.position) ? lift.position : undefined;
}

/**
 * What a token needs written to be drawn `screen` px up (0 = in its own
 * place): its offset, the lift to store (undefined = remove it), and the
 * position to put it back to after a resize (undefined = it stays), or
 * null when it's already so.
 */
export function plannedLift(
  token: Image,
  screen: number,
  dpi: number
): { offset: Vector2; lift: TokenLift | undefined; position?: Vector2 } | null {
  const stored = getTokenLift(token);
  const current = currentLift(token);
  const base = current ? current.base : token.grid.offset;
  const stood = current && standingBefore(current, token);
  // Put back a hair off where it stood: Owlbear draws a token it turned by
  // hand where the gesture left it until its position changes, and back to
  // the very same value isn't a change. Off one way or the other, so it
  // never drifts further.
  const back = stood && { x: stood.x + (Math.round(stood.x / NUDGE) % 2 ? -NUDGE : NUDGE), y: stood.y };
  if (!screen) {
    return stored ? { offset: base, lift: undefined, ...(back && { position: back }) } : null;
  }
  const position = back || token.position;
  const delta = liftOffsetDelta(token, screen, dpi);
  const applied = { x: base.x + delta.x, y: base.y + delta.y };
  if (
    current &&
    current.screen === screen &&
    samePoint(current.applied, applied) &&
    current.position &&
    current.scale &&
    current.rotation === token.rotation &&
    samePoint(current.position, position) &&
    samePoint(current.scale, token.scale)
  ) {
    return null;
  }
  const lift = {
    base,
    applied,
    screen,
    position: { ...position },
    scale: { ...token.scale },
    rotation: token.rotation,
  };
  return { offset: applied, lift, ...(back && { position: back }) };
}

/** Writes a plannedLift() into a token draft. */
export function applyPlannedLift(token: Image, plan: NonNullable<ReturnType<typeof plannedLift>>) {
  token.grid.offset = plan.offset;
  if (plan.position) {
    token.position = { ...plan.position };
  }
  if (plan.lift) {
    token.metadata[METADATA_KEY] = plan.lift;
  } else {
    delete token.metadata[METADATA_KEY];
  }
}
