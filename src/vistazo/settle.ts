import type { MultiPolygon } from "polygon-clipping";
import type { VistazoScene } from "./scene";
import type { Region } from "./view/walls";

/**
 * Whether a brush let go within `region` (scene px) can be drawn with the
 * scene as it was drawn (its pieces read the relief as it is now) and its
 * walls as the brush left them (see VistazoView.reheight), instead of all of
 * it built again: not where what's there takes its heights once, as it's
 * built (a standing shape's picture, a slab, water's floor). The water's
 * reach round its zone follows on its own (see VistazoView.buildWater).
 */
export function settles(scene: VistazoScene, region: Region): boolean {
  const margin = scene.dpi / 2;
  const reaches = (shape: MultiPolygon) =>
    shape.some((polygon) => {
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of polygon[0]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      return x0 <= region.x1 + margin && x1 >= region.x0 - margin && y0 <= region.y1 + margin && y1 >= region.y0 - margin;
    });
  return !scene.pieces.some((piece) => (piece.stand || piece.water) && reaches(piece.shape)) && !scene.bridges.some((bridge) => reaches(bridge.shape));
}
