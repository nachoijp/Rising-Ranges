import type { Image } from "@owlbear-rodeo/sdk";

// A relief follows the map image it was made on: its cells are the image's
// own grid cells (its pixels over its grid dpi), so moving, turning or sizing
// the image takes the terrain with it. Heights stay in grid units.

/** What of a map image places its relief in the scene. */
export type Anchor = {
  id: string;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  /** The image's own pixels a cell. */
  gridDpi: number;
  width: number;
  height: number;
};

export function anchorOf(item: Image): Anchor {
  return {
    id: item.id,
    x: item.position.x,
    y: item.position.y,
    rotation: item.rotation,
    scaleX: item.scale.x,
    scaleY: item.scale.y,
    offsetX: item.grid.offset.x,
    offsetY: item.grid.offset.y,
    gridDpi: item.grid.dpi,
    width: item.image.width,
    height: item.image.height,
  };
}

/** The relief's size for an image, in its cells. */
export function reliefSize(a: Anchor): [number, number] {
  return [a.width / a.gridDpi, a.height / a.gridDpi];
}

/** A relief cell point in the scene (px), for a scene of `dpi` px a cell. */
export function cellToScene(a: Anchor, dpi: number, cx: number, cy: number): { x: number; y: number } {
  const k = dpi / a.gridDpi;
  const x = (cx * a.gridDpi - a.offsetX) * a.scaleX * k;
  const y = (cy * a.gridDpi - a.offsetY) * a.scaleY * k;
  const angle = (a.rotation * Math.PI) / 180;
  return { x: a.x + x * Math.cos(angle) - y * Math.sin(angle), y: a.y + x * Math.sin(angle) + y * Math.cos(angle) };
}

/** A scene point (px) in the relief's cells. */
export function sceneToCell(a: Anchor, dpi: number, x: number, y: number): [number, number] {
  const k = dpi / a.gridDpi;
  const angle = (-a.rotation * Math.PI) / 180;
  const [dx, dy] = [x - a.x, y - a.y];
  const [rx, ry] = [dx * Math.cos(angle) - dy * Math.sin(angle), dx * Math.sin(angle) + dy * Math.cos(angle)];
  return [(rx / (a.scaleX * k || 1) + a.offsetX) / a.gridDpi, (ry / (a.scaleY * k || 1) + a.offsetY) / a.gridDpi];
}
