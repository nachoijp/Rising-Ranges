import OBR, { type Grid, type GridColor, type GridLineType } from "@owlbear-rodeo/sdk";

/**
 * Owlbear's grid lines as its scene has them: their width (scene px: wider as it's zoomed in), colour,
 * opacity (0 to 1) and type. What the Vistazo's ground and the relief editor's map draw theirs as.
 */
export type GridLook = { width: number; color: string; opacity: number; line: GridLineType };

/** Till Owlbear's is known (or if it can't be): the lines the Vistazo had before it followed it. */
export const DEFAULT_GRID_LOOK: GridLook = { width: 0, color: "#000000", opacity: 0.35, line: "SOLID" };

/**
 * A grid colour as CSS: its own (a custom one, "#rrggbb") or, for Owlbear's named ones, the colour of
 * its swatch in the grid's controls (measured 2026-11-21: black, white, orange).
 */
export function gridColorCss(color: GridColor): string {
  if (color === "DARK") return "#000000";
  if (color === "LIGHT") return "#ffffff";
  if (color === "HIGHLIGHT") return "#fa6400";
  // A custom one as "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa": its colour (the opacity is the grid's own).
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color)?.[1];
  if (!hex) return "#000000";
  return `#${hex.length <= 4 ? hex.slice(0, 3) : hex.slice(0, 6)}`;
}

/** From a grid as Owlbear tells it (grid.onChange). */
export function gridLookOf(grid: Grid): GridLook {
  return { width: grid.style.lineWidth, color: gridColorCss(grid.style.lineColor), opacity: grid.style.lineOpacity, line: grid.style.lineType };
}

/** Asked of Owlbear; what it can't tell, as before. */
export async function readGridLook(): Promise<GridLook> {
  const [width, color, opacity, line] = await Promise.all([
    OBR.scene.grid.getLineWidth().catch(() => DEFAULT_GRID_LOOK.width),
    OBR.scene.grid.getColor().catch(() => null),
    OBR.scene.grid.getOpacity().catch(() => DEFAULT_GRID_LOOK.opacity),
    OBR.scene.grid.getLineType().catch(() => DEFAULT_GRID_LOOK.line),
  ]);
  return { width, color: color === null ? DEFAULT_GRID_LOOK.color : gridColorCss(color), opacity, line };
}
