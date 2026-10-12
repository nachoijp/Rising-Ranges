import type { Image, Vector2 } from "@owlbear-rodeo/sdk";
import { IconPosition } from "../engine/types";
import { getTokenFootprint } from "../tokenHeight/footprint";

const OPPOSITE_POSITION: Record<IconPosition, IconPosition> = {
  left: "right",
  right: "left",
  top: "bottom",
  bottom: "top",
};

/**
 * The ephemeral Lectura icon and the persistent per-token height marker
 * share the same BandSet visual config (shape/position/size/distance), so
 * without this they'd render on top of each other whenever a token being
 * measured also has its own marker. Always anchoring the Lectura on the
 * opposite side keeps both visible at once.
 */
export function oppositeIconPosition(position: IconPosition): IconPosition {
  return OPPOSITE_POSITION[position];
}

export interface TokenBounds {
  topLeft: Vector2;
  scaledWidth: number;
  scaledHeight: number;
}

/**
 * A token's on-screen top-left corner and rendered size, in scene units —
 * its real footprint, which its position (placed by grid.offset anywhere in
 * the image) doesn't give on its own.
 */
export function getTokenBounds(token: Image, dpi: number): TokenBounds {
  const dpiScale = dpi / token.grid.dpi;
  const width = token.image.width * dpiScale;
  const height = token.image.height * dpiScale;
  const offsetX = (token.grid.offset.x / token.image.width) * width;
  const offsetY = (token.grid.offset.y / token.image.height) * height;
  const scaledWidth = width * token.scale.x;
  const scaledHeight = height * token.scale.y;
  return {
    topLeft: {
      x: token.position.x - offsetX * token.scale.x,
      y: token.position.y - offsetY * token.scale.y,
    },
    scaledWidth,
    scaledHeight,
  };
}

/** Where an icon stack starts: just outside the token's footprint, on the given side, `iconDistance` cells away. */
export function computeIconAnchor(
  token: Image,
  dpi: number,
  position: IconPosition,
  iconDistance: number
): Vector2 {
  const { topLeft, scaledWidth, scaledHeight } = getTokenBounds(token, dpi);
  const margin = iconDistance * dpi;
  switch (position) {
    case "right":
      return { x: topLeft.x + scaledWidth + margin, y: topLeft.y + scaledHeight / 2 };
    case "top":
      return { x: topLeft.x + scaledWidth / 2, y: topLeft.y - margin };
    case "bottom":
      return { x: topLeft.x + scaledWidth / 2, y: topLeft.y + scaledHeight + margin };
    case "left":
    default:
      return { x: topLeft.x - margin, y: topLeft.y + scaledHeight / 2 };
  }
}

/**
 * Half the token's footprint set by hand, if it has one; otherwise half
 * its larger on-screen dimension, in grid units — how big
 * Tolerancia treats the token as being. Reuses the same footprint math the
 * icon anchor/ring/circle sizing already does (accounts for the token's
 * real image size, grid offset, and scale), so a Large/Huge creature
 * actually needs more of itself in range than a 1×1 token, instead of
 * everyone being measured as if they were the same fixed half-square.
 *
 * On an axonometric grid (see axonometry.ts) a token stands on its cell
 * rather than covering it: as wide as the cell's rhombus is one cell
 * across, and how tall its image is says nothing about the floor it takes.
 */
export function getTokenRadius(token: Image, dpi: number, axonometry: number): number {
  // Set by hand, it's what the token is (see footprint.ts).
  const footprint = getTokenFootprint(token);
  if (footprint !== undefined) {
    return footprint / 2;
  }
  const { scaledWidth, scaledHeight } = getTokenBounds(token, dpi);
  if (axonometry) {
    return Math.abs(scaledWidth) / (axonometry * dpi) / 2;
  }
  return Math.max(scaledWidth, scaledHeight) / dpi / 2;
}
