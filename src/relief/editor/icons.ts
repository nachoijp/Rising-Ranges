// The editor's icons, and the Vistazo's own (its window's buttons, its
// controls): one SVG file each in ./icons (edited by hand, in Inkscape
// too), drawn in the colour of the text round them. Taken in as
// they are, less what an editor leaves in them (its own markup, a colour
// set where it should be the text's).

const files = import.meta.glob("./icons/*.svg", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** An icon's drawing, as it goes inside an <svg>: Inkscape's markup out, fixed colours the text's. */
function clean(text: string): string {
  const inner = text.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return (
    inner
      // Inkscape's own: its view of the page, empty defs, its metadata.
      .replace(/<sodipodi:namedview[\s\S]*?(\/>|<\/sodipodi:namedview>)/g, "")
      .replace(/<metadata[\s\S]*?<\/metadata>/g, "")
      .replace(/<defs[^>]*\/>/g, "")
      .replace(/\s(inkscape|sodipodi):[\w-]+="[^"]*"/g, "")
      // Ids would clash between the icons on the page.
      .replace(/\sid="[^"]*"/g, "")
      // A colour set on a fill or a stroke (not "none"): the text's.
      .replace(/(fill|stroke)(:\s*|=")(#[0-9a-fA-F]{3,8}|black|white|rgba?\([^)]*\))/g, "$1$2currentColor")
      .trim()
  );
}

const ICONS = new Map<string, string>();
for (const [path, text] of Object.entries(files)) {
  const name = path.replace(/^.*\//, "").replace(/\.svg$/, "");
  ICONS.set(name, clean(text));
}

export type IconName =
  | "select" | "cut" | "rect" | "ellipse" | "lasso" | "pen" | "roller" | "brush"
  | "raise" | "lower" | "smooth" | "flatten"
  | "undo" | "redo" | "heights" | "more" | "delete" | "expand" | "close"
  | "terrain" | "slab" | "stand" | "flat" | "ramp" | "inclined" | "relative" | "fixed"
  | "duplicate" | "rename" | "layer-up" | "layer-down" | "convert" | "combine" | "texture"
  | "plus" | "minus" | "pick-shapes" | "pick-points" | "edge-wall" | "edge-soft" | "eyedropper"
  | "visible" | "hidden" | "locked" | "unlocked" | "size" | "strength" | "magnet" | "folder" | "group" | "ungroup"
  | "stamp" | "column" | "pit" | "stairs" | "platform" | "wall" | "mound" | "erase"
  | "grip" | "panel" | "minimize" | "fullscreen" | "fullscreen-exit" | "restore" | "info" | "resize";

/** An icon, as markup. */
export const icon = (name: IconName) => `<svg class="ri" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICONS.get(name) ?? ""}</svg>`;
