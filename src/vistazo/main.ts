import OBR, { type GridType, type Image, type InteractionManager, type Theme, type Vector2 } from "@owlbear-rodeo/sdk";
import { languageFromMetadata, type Language } from "../i18n/language";
import { translate, type TranslationKey } from "../i18n/translate";
import { formatDistance } from "../util/flattenGridScale";
import { getGridType } from "../util/gridAxonometry";
import { axonometryOf } from "../engine/axonometry";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import { measuredBands } from "../engine/bands";
import { onGrid } from "../engine/hex";
import { computeDistanceRows } from "../distances/rows";
import { getStoredTheme } from "../theme/themes";
import { getColorString } from "../util/color";
import { buildScene, propOf, type Piece, type Reliefs, type Token, type VistazoScene } from "./scene";
import type { Region } from "./view/walls";
import { settles } from "./settle";
import { anchorOf, cellToScene, sceneToCell, type Anchor } from "../relief/anchor";
import { reliefTerrain } from "../relief/vistazo";
import clip from "../terrain/clip";
import type { Moving } from "../relief/editor/session";
import { compose, inverse } from "../relief/relief";
import type { Affine } from "../relief/types";
import { Relief } from "../relief/relief";
import { watchReliefs } from "../relief/store";
import type { EditSession } from "../relief/editor/session";
import { icon, type IconName } from "../relief/editor/icons";
import vistazoLogo from "../assets/vistazo.svg?raw";
import { FREE_POINT, TEMPLATE_HANDLE, VistazoView, type Camera, type DistanceLine, type Options } from "./render";
import { templateReaches, type Template, type TemplateLook, type TemplateShape } from "./templates";
import { LIVE_DRAG_CHANNEL, type LiveDrag } from "./live";
import { SYNC_CHANNEL, SYNC_HEARTBEAT_MS, SYNC_INTERVAL_MS, SYNC_TIMEOUT_MS, type SyncMessage } from "./sync";
import { stepHeight } from "../engine/heights";
import { globalSettingsFromMetadata, groundHotkey, letterToCode } from "../settings/globalSettings";
import { setTokenHeightMarker } from "../tokenHeight/markers";
import { bodyCenterHeight, DEFAULT_TOLERANCE, excessRadius } from "../engine/distance";
import { isHexShape, originCellsAt, snapToOrigin } from "../engine/hex";
import { getTokenRadius } from "../render/iconAnchor";
import { getPluginId } from "../util/getPluginId";
import { globalSettingsFromMetadata as settingsOf, vistazoAccess } from "../settings/globalSettings";
import {
  BAR_HEIGHT,
  MIN_HEIGHT,
  MIN_WIDTH,
  VISTAZO_POPOVER_ID,
  DEFAULT_POSITION,
  closeVistazoPanel,
  moveVistazoPanel,
  openVistazoPanel,
  readPanelPosition,
  savePanelPosition,
  type PanelPosition,
  readPanelSize as readSize,
  savePanelSize as saveSize,
} from "./panel";
import { clearOf, fogOver } from "./fog";
import { DragPath } from "../util/dragPath";
import { saveDraggedToken } from "../util/saveDrag";
import "./vistazo.css";
import { since, stamp, time } from "../timing";
import { enhanceSelects } from "./dropdown";
import { fillSliders } from "./slider";
// Roboto, as the extension's other pages (PluginThemeProvider): not every computer has it.
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/600.css";
import "@fontsource/roboto/700.css";
import { isMapImage } from "../relief/measure";

// Before any other key listener: an open dropdown's keys are its own (see dropdown.ts).
enhanceSelects();
fillSliders();
// The page's icons from the icon files (a placeholder each, see vistazo.html); the logo from the toolbar's.
for (const el of document.querySelectorAll<HTMLElement>("[data-icon]")) {
  el.outerHTML = icon(el.dataset.icon as IconName);
}
document.getElementById("barIcon")!.innerHTML = vistazoLogo.replace(/stroke="#[0-9a-fA-F]+"/, 'stroke="currentColor"');

/**
 * The same page opened full screen (an Owlbear modal, `?full`): the
 * action's own popover can't grow past what Owlbear leaves it under its top
 * bar. Going there and back keeps the camera (CAMERA_KEY, read once).
 */
const FULL = new URLSearchParams(location.search).has("full");

/** The controls' help, one line each (the ? at the stage's corner). */
const HELP_KEYS = ["vistazo.help1", "vistazo.help2", "vistazo.help3", "vistazo.help4", "vistazo.help5", "vistazo.help6", "vistazo.help7"] as const;
const FULL_MODAL_ID = getPluginId("vistazo/full");
const CAMERA_KEY = "rising-ranges/vistazo-camera";

// The Vistazo 3D: the action's own popover, opened from its icon at the
// top, sized to most of the window. A quick look at where everything is in
// 3D — the map raised by its terrain, the tokens at their heights — that
// changes nothing in the scene. GM only for now.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const POSE = { tilt: 55, yaw: -25 };
const OPTIONS_KEY = "rising-ranges/vistazo-options";

function readOptions(): Options {
  const defaults: Options = { heightScale: 1, shade: 0.6, perspective: 45, tint: false, tokens: true, xray: false, edges: true, anchor: "center", levels: true, grid: false, distances: true, tokenLabels: "full", distanceLabels: "full", labelSize: 1, relief: 0.5, weather: true, clouds: "mist", waterMotion: true, videoMaps: true, quality: "high", props: "flat", showProps: true, propDistances: false, propShadows: true, propLines: true, propLabels: false, rings: true, ringFill: false, playerView: false };
  // A system asking for less motion: the first time (nothing saved yet), low quality and still water.
  // Changed here, it's as chosen from then on.
  try {
    if (!localStorage.getItem(OPTIONS_KEY) && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      defaults.quality = "low";
      defaults.waterMotion = false;
    }
  } catch {
    // The defaults as they are.
  }
  try {
    const stored: Options = { ...defaults, ...JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}") };
    // "Hidden" was a position of the props once; now it's their own checkbox.
    if (stored.props === "none") {
      return { ...stored, props: "flat", showProps: false };
    }
    return stored;
  } catch {
    return defaults;
  }
}

function saveOptions(options: Options) {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // Only a convenience.
  }
}

/**
 * What's under shapes being dragged, where they were (their outlines taken
 * back by the drag's map): the relief there without them, as pieces.
 */
function underShapes(relief: Relief, anchor: Anchor, dpi: number, moving: Moving): Piece[] {
  const back = inverse(moving.map);
  const at = ([x, y]: [number, number]): [number, number] => [back[0] * x + back[2] * y + back[4], back[1] * x + back[3] * y + back[5]];
  const closedRing = (ring: [number, number][]) => [...ring.map(at), at(ring[0])];
  const where = relief.layers.filter((layer) => moving.shapes.includes(layer.si)).map((layer) => [closedRing(layer.ring), ...layer.holes.map(closedRing)]);
  if (where.length === 0) {
    return [];
  }
  try {
    const within = (where.length === 1 ? where : clip.union(where[0], ...where.slice(1))) as [number, number][][][];
    return reliefTerrain(relief, anchor, dpi, null, true, new Set(moving.shapes), within).pieces;
  } catch (error) {
    console.error("Rising Ranges: 3D Glance couldn't work out what's under the shapes dragged", error);
    return [];
  }
}

/**
 * A map of a relief's cells (see ReliefEditor.xfMap) as one of the scene's px:
 * through the image the relief follows (cells to the scene, the map, and back).
 */
function sceneMap(anchor: Anchor, dpi: number, map: Affine): Affine {
  const o = cellToScene(anchor, dpi, 0, 0);
  const ex = cellToScene(anchor, dpi, 1, 0);
  const ey = cellToScene(anchor, dpi, 0, 1);
  const toScene: Affine = [ex.x - o.x, ex.y - o.y, ey.x - o.x, ey.y - o.y, o.x, o.y];
  return compose(toScene, compose(map, inverse(toScene)));
}

function applyTheme(theme: Theme) {
  const root = document.documentElement.style;
  root.setProperty("--bg", theme.background.default);
  root.setProperty("--panel", theme.background.paper);
  root.setProperty("--fg", theme.text.primary);
  root.setProperty("--muted", theme.text.secondary);
  root.setProperty("--accent", theme.primary.main);
  root.setProperty("--accent-fg", theme.primary.contrastText);
  // On the body (see vistazo.css): on the root it would make the browser paint the page opaque.
  document.body.style.colorScheme = theme.mode === "DARK" ? "dark" : "light";
  // The extension's glass panel (see GlassFrame): measured in the dark theme; the light one keeps the theme's paper.
  const dark = theme.mode === "DARK";
  root.setProperty("--glass-outer", dark ? "rgba(48, 52, 63, 0.62)" : withAlpha(theme.background.paper, 0.62));
  // Its colour without the see-through (what's drawn to look like a hole in it: the relief editor's icons).
  root.setProperty("--glass-solid", dark ? "rgb(48, 52, 63)" : theme.background.paper);
  // Icons' grey in the light theme: Owlbear's (MUI's action.active), lighter than the text's.
  if (dark) {
    root.removeProperty("--icon");
  } else {
    root.setProperty("--icon", "rgba(0, 0, 0, 0.54)");
  }
  root.setProperty("--glass-inner", withAlpha(theme.background.default, 0.2));
  root.setProperty("--divider", dark ? "rgba(255,255,255,.09)" : "rgba(20,18,30,.10)");
}

/** A CSS colour (#rgb, #rrggbb or rgb()) at an opacity. */
function withAlpha(color: string, alpha: number): string {
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${alpha})`;
  }
  const rgb = color.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const [r, g, b] = rgb[1].split(",").map((v) => v.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

// "-2": the sections as they are since they were regrouped, each folded at first.
const SECTIONS_KEY = "rising-ranges/vistazo-sections-2";

/**
 * Each section of the controls folds away by its title, remembered per
 * browser: all folded at first, what's used every day above them.
 */
function setUpSections() {
  const sections = [...document.querySelectorAll<HTMLFieldSetElement>("fieldset[data-section]")];
  let folded: string[] = sections.map((section) => section.dataset.section!);
  try {
    const stored = localStorage.getItem(SECTIONS_KEY);
    if (stored) {
      folded = JSON.parse(stored);
    }
  } catch {
    // All folded, then.
  }
  for (const section of sections) {
    const legend = section.querySelector("legend")!;
    const title = legend.querySelector<HTMLElement>("[data-t]") ?? legend;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "section-toggle";
    button.innerHTML = icon("expand");
    const label = document.createElement("span");
    label.dataset.t = title.dataset.t ?? "";
    button.append(label);
    // Its text is the button's now: left on the legend, filling the texts in would write over the button.
    delete legend.dataset.t;
    legend.replaceChildren(button);
    const id = section.dataset.section!;
    const fold = (on: boolean) => {
      section.classList.toggle("collapsed", on);
      button.setAttribute("aria-expanded", String(!on));
    };
    fold(folded.includes(id));
    button.onclick = () => {
      const on = !section.classList.contains("collapsed");
      fold(on);
      folded = on ? [...new Set([...folded, id])] : folded.filter((f) => f !== id);
      try {
        localStorage.setItem(SECTIONS_KEY, JSON.stringify(folded));
      } catch {
        // Only a convenience.
      }
    };
  }
}

/** The panel's size, set from its page (Owlbear lets a page resize its popover). */
function resizePanel(width: number, height: number) {
  void OBR.popover.setWidth(VISTAZO_POPOVER_ID, width);
  void OBR.popover.setHeight(VISTAZO_POPOVER_ID, height);
}

/**
 * The corner handle resizes the panel, the panel button hides the controls
 * (small, with only the view, it's a minimap that keeps up with the scene),
 * and the minimize button shrinks it to a bar, out of the way, still open.
 */
type PanelDrag = {
  x: number;
  y: number;
  from: PanelPosition;
  to: PanelPosition;
  screen: { width: number; height: number } | null;
  busy: boolean;
  moved: boolean;
};

/**
 * A handle that drags the panel around the screen, like the Distancias
 * panel's: the page keeps the pointer while it's held (pointer capture),
 * each move reopens the panel further along (one at a time), in screen
 * coordinates so the panel moving underneath doesn't throw them off. A
 * double click sends it back to its corner.
 */
function setUpDrag(handle: HTMLElement) {
  let drag: PanelDrag | null = null;
  const size = () => ({ width: window.innerWidth, height: window.innerHeight });
  const target = (event: PointerEvent, d: PanelDrag): PanelPosition => {
    const to = { left: d.from.left + event.screenX - d.x, top: d.from.top + event.screenY - d.y };
    if (!d.screen) {
      return to;
    }
    const { width, height } = size();
    return {
      left: Math.round(Math.max(0, Math.min(to.left, d.screen.width - width))),
      top: Math.round(Math.max(0, Math.min(to.top, d.screen.height - height))),
    };
  };
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    const position = readPanelPosition();
    const d: PanelDrag = { x: event.screenX, y: event.screenY, from: position, to: position, screen: null, busy: false, moved: false };
    drag = d;
    Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight()])
      .then(([width, height]) => {
        d.screen = { width, height };
      })
      .catch(() => {});
  });
  handle.addEventListener("pointermove", (event) => {
    const d = drag;
    if (!d || d.busy) {
      return;
    }
    const to = target(event, d);
    if (to.left === d.to.left && to.top === d.to.top) {
      return;
    }
    d.to = to;
    d.moved = true;
    d.busy = true;
    const { width, height } = size();
    moveVistazoPanel(to, width, height).finally(() => {
      d.busy = false;
    });
  });
  const end = (event: PointerEvent) => {
    const d = drag;
    drag = null;
    if (!d?.moved) {
      return;
    }
    const to = target(event, d);
    const { width, height } = size();
    void moveVistazoPanel(to, width, height);
    savePanelPosition(to);
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("dblclick", () => {
    const { width, height } = size();
    void moveVistazoPanel(DEFAULT_POSITION, width, height);
    savePanelPosition(null);
  });
}

/** Told when the panel's minimized or brought back (the view pauses its videos meanwhile; see start). */
let onMinimized: (minimized: boolean) => void = () => {};

/**
 * The bar as wide as what's in it, its name whole and nothing left over (the name changes with the
 * language): what's laid out, less the name as it shows, plus the name as long as it is.
 */
function barWidth(): number {
  const bar = $("bar");
  const title = bar.querySelector<HTMLElement>(".bar-title")!;
  const style = getComputedStyle(bar);
  const end = bar.lastElementChild!.getBoundingClientRect().right + parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth);
  return Math.ceil(end - bar.getBoundingClientRect().left - title.clientWidth + title.scrollWidth);
}

/** The bar fitted to its name again (after a change of language), if that's what shows. */
function fitBar() {
  if (document.documentElement.classList.contains("minimized")) {
    resizePanel(barWidth(), BAR_HEIGHT);
  }
}

function setUpResizing() {
  setUpDrag($("grip"));
  setUpDrag($("barGrip"));
  $("minimize").onclick = () => {
    document.documentElement.classList.add("minimized");
    onMinimized(true);
    fitBar();
  };
  $("restore").onclick = () => {
    document.documentElement.classList.remove("minimized");
    onMinimized(false);
    const saved = readSize();
    resizePanel(saved.width ?? 900, saved.height ?? 600);
  };
  const app = $("app");
  const compact = (on: boolean) => {
    app.classList.toggle("compact", on);
    $("panelToggle").setAttribute("aria-pressed", String(!on));
    // Its buttons beside the title while the settings show, over the 3D view otherwise.
    (on ? $("stage") : $("asideHead")).appendChild($("tools"));
  };
  compact(readSize().compact ?? false);
  $("panelToggle").onclick = () => {
    const on = !app.classList.contains("compact");
    compact(on);
    saveSize({ compact: on });
  };
  const handle = $("resize");
  let start: { x: number; y: number; width: number; height: number } | null = null;
  let frame = 0;
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    start = { x: event.screenX, y: event.screenY, width: window.innerWidth, height: window.innerHeight };
  });
  handle.addEventListener("pointermove", (event) => {
    if (!start) {
      return;
    }
    const width = Math.max(MIN_WIDTH, Math.round(start.width + event.screenX - start.x));
    const height = Math.max(MIN_HEIGHT, Math.round(start.height + event.screenY - start.y));
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      resizePanel(width, height);
      saveSize({ width, height });
    });
  });
  const end = () => {
    start = null;
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function message(text: string) {
  $("app").hidden = true;
  const note = $("message");
  note.textContent = text;
  note.hidden = false;
}

async function start() {
  const [role, metadata, theme] = await Promise.all([OBR.player.getRole(), OBR.scene.getMetadata().catch(() => null), OBR.theme.getTheme()]);
  applyTheme(theme);
  OBR.theme.onChange(applyTheme);
  if (FULL) {
    document.documentElement.classList.add("full");
  }
  let language: Language = languageFromMetadata(metadata ?? {});
  const t = (key: TranslationKey, vars?: Record<string, string | number>) => translate(language, key, vars);
  /** Set while a token is being moved here: Esc cancels that instead of closing. */
  let cancelMove: (() => void) | null = null;
  // ---------- Volume templates (only in this view; see templates.ts) ----------
  let templates: Template[] = [];
  /** Waiting for a click to put the next one down; and a cone or a line being pointed. */
  let placing = false;
  let aiming: Template | null = null;
  const setPlacing = (on: boolean) => {
    placing = on;
    document.documentElement.classList.toggle("placing", on);
    $("templatePlace").setAttribute("aria-pressed", String(on));
  };
  /** The one the controls ask for, at a point of the ground. */
  const newTemplate = (ground: { x: number; y: number; z: number }): Template => {
    const units = Number(($("templateSize") as HTMLInputElement).value) || 20;
    const perCell = scale.parsed.multiplier || 1;
    return {
      id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
      shape: ($("templateShape") as HTMLSelectElement).value as TemplateShape,
      look: ($("templateLook") as HTMLSelectElement).value as TemplateLook,
      x: ground.x,
      y: ground.y,
      z: ground.z,
      lift: 0,
      dir: { x: 1, y: 0 },
      rise: 0,
      size: Math.max(0.2, units / perCell),
    };
  };
  /** The template the scene's keys raise and lower: the last one put down or grabbed; and which of its points. */
  let activeTemplate: string | null = null;
  let activePart: "origin" | "tip" = "origin";
  function addTemplate(template: Template) {
    templates = [...templates, template];
    activeTemplate = template.id;
    activePart = "origin";
    setPlacing(false);
    showTemplates();
  }
  /**
   * The tokens a template reaches: their body (round, as tall as wide)
   * within it, with the Lecturas' tolerance; all in cells (grid units up).
   */
  function updateAffected() {
    if (!scene || templates.length === 0) {
      view.setAffected(new Set());
      return;
    }
    // Never in the way of what calls it (the lines, the rings, the list): a failure is only logged.
    try {
      reachTokens(scene);
    } catch (error) {
      console.error("Rising Ranges: 3D Glance couldn't tell which tokens the templates reach", error);
    }
  }
  function reachTokens(scene: VistazoScene) {
    const bandSet = onGrid(bandSetFromMetadata(sceneMetadata), gridType);
    const tolerance = (bandSet.tolerance ?? DEFAULT_TOLERANCE) / 100;
    const reached = new Set<string>();
    for (const token of scene.tokens) {
      const radius = getTokenRadius(token.item, dpi, 0);
      const reach = radius + tolerance;
      const c = { x: token.x / dpi, y: token.y / dpi, z: bodyCenterHeight(token.terrain + token.own, radius) };
      if (templates.some((template) => templateReaches(template, c, reach, dpi))) {
        reached.add(token.id);
      }
    }
    view.setAffected(reached);
  }
  /** Drawn, and listed with a button to take each away. */
  function showTemplates() {
    view.setTemplates(templates);
    updateAffected();
    const list = $("templateList");
    list.replaceChildren(
      ...templates.map((template) => {
        const item = document.createElement("li");
        const name = document.createElement("span");
        const shapeKey = `vistazo.shape${template.shape[0].toUpperCase()}${template.shape.slice(1)}` as TranslationKey;
        const lookKey = `vistazo.look${template.look[0].toUpperCase()}${template.look.slice(1)}` as TranslationKey;
        name.textContent = `${t(shapeKey)} · ${t(lookKey)} · ${formatDistance(scale, template.size)}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "✕";
        remove.title = t("vistazo.templateRemove");
        remove.onclick = () => {
          templates = templates.filter((other) => other.id !== template.id);
          if (activeTemplate === template.id) {
            activeTemplate = null;
          }
          showTemplates();
        };
        item.append(name, remove);
        return item;
      })
    );
    $("templateClear").hidden = templates.length === 0;
  }
  $("templatePlace").onclick = () => setPlacing(!placing);
  $("templateClear").onclick = () => {
    templates = [];
    showTemplates();
  };
  $("templateClear").hidden = true;
  /** Takes the free point away, if there's one (then Esc does only that); see placePoint. */
  let clearPoint: () => boolean = () => false;
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (cancelMove) {
        cancelMove();
      } else if (placing || aiming) {
        // Placing a template: Esc stops that.
        aiming = null;
        setPlacing(false);
        showTemplates();
      } else if (clearPoint()) {
        // The point gone, the panel stays.
      } else if (FULL) {
        leaveFull();
      } else {
        void closeVistazoPanel();
      }
    }
  });

  // Who may open it (Settings → General): the GM always (hidden, "off", only takes its button away:
  // the relief is still edited here, from the map's menu), and the players too with "everyone".
  const isGM = role === "GM";
  const access = vistazoAccess(settingsOf(metadata ?? {}));
  if (access !== "everyone" && !isGM) {
    message(t("vistazo.gmOnly"));
    return;
  }
  // The scene may still be loading when the popover opens: say so, and start over once it's there.
  if (!metadata || !(await OBR.scene.isReady())) {
    message(t("vistazo.noScene"));
    const unsubscribe = OBR.scene.onReadyChange((ready) => {
      if (ready) {
        unsubscribe();
        window.location.reload();
      }
    });
    return;
  }
  let gridType: GridType = await getGridType();
  if (axonometryOf(gridType) > 0) {
    message(t("vistazo.axonometric"));
    // Back to a grid seen from above: it starts over.
    OBR.scene.grid.onChange((grid) => {
      if (axonometryOf(grid.type) === 0) {
        window.location.reload();
      }
    });
    return;
  }

  setUpResizing();

  /** The camera handed over to the other view, for a few seconds. */
  function handCamera() {
    try {
      localStorage.setItem(CAMERA_KEY, JSON.stringify({ at: Date.now(), camera, syncing }));
    } catch {
      // It just opens as usual.
    }
  }
  function takeCamera(): { camera: Partial<Camera>; syncing?: boolean } | null {
    try {
      const stored = JSON.parse(localStorage.getItem(CAMERA_KEY) ?? "null");
      localStorage.removeItem(CAMERA_KEY);
      return stored && Date.now() - stored.at < 5000 ? stored : null;
    } catch {
      return null;
    }
  }
  /** To full screen: this panel closes, the modal opens with its camera. */
  function enterFull() {
    handCamera();
    void OBR.modal.open({ id: FULL_MODAL_ID, url: "/vistazo.html?full", fullScreen: true });
    void closeVistazoPanel(true);
  }
  /** Back from full screen: the panel opens again with its camera, and the modal closes. */
  function leaveFull() {
    handCamera();
    void openVistazoPanel();
    void OBR.modal.close(FULL_MODAL_ID);
  }
  $("fullToggle").onclick = () => (FULL ? leaveFull() : enterFull());
  /** The X: closed for good, from the panel or full screen (not back to the panel). */
  const closeAll = () => {
    void closeVistazoPanel();
    if (FULL) {
      void OBR.modal.close(FULL_MODAL_ID);
    }
  };
  $("close").onclick = closeAll;
  $("barClose").onclick = closeAll;
  $("fullToggle").dataset.title = FULL ? "vistazo.exitFull" : "vistazo.full";
  $("fullToggle").innerHTML = icon(FULL ? "fullscreen-exit" : "fullscreen");

  setUpSections();

  // ---------- Texts ----------
  const fill = () => {
    // The page's name in its language too (a browser tab's, a screen reader's).
    document.title = `Rising Ranges — ${t("vistazo.title")}`;
    for (const el of document.querySelectorAll<HTMLElement>("[data-t]")) {
      el.textContent = t(el.dataset.t as TranslationKey);
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-title]")) {
      el.title = t(el.dataset.title as TranslationKey);
      el.setAttribute("aria-label", el.title);
    }
    // The controls' help, a list (the ? at the stage's corner); its own tooltip, not the browser's.
    $("help").removeAttribute("title");
    // The "i"s: their own tooltip (on keyboard focus too, see .info), not the browser's.
    for (const el of document.querySelectorAll<HTMLElement>(".info")) {
      el.removeAttribute("title");
    }
    $("helpList").replaceChildren(
      ...HELP_KEYS.map((key) => {
        const item = document.createElement("li");
        item.textContent = t(key);
        return item;
      })
    );
  };
  fill();
  // Put together (its look, icons and texts): shown in place of the spinner (see vistazo.html).
  requestAnimationFrame(() => document.documentElement.classList.add("ready"));

  let scene: VistazoScene | null = null;
  const reliefs: Reliefs = { byImage: new Map(), key: "" };
  const distance = (units: number) => (scene ? formatDistance(scene.scale, units) : String(units));
  const tokenText = (token: Token) => {
    const total = token.terrain + token.own;
    const detail = token.bridge !== undefined
      ? t("vistazo.onBridge")
      : token.own > 0
        ? t("vistazo.flying", { terrain: distance(token.terrain), own: distance(token.own) })
        : token.own < 0
          ? t(token.terrain === 0 ? "vistazo.buriedGround" : "vistazo.buriedTerrain", { depth: distance(-token.own) })
          : token.terrain > 0
            ? t("vistazo.onTerrain")
            : token.terrain < 0
              ? t("vistazo.inPit")
              : t("vistazo.onGround");
    return { name: token.name, height: distance(total), detail: token.hidden ? `${detail} · ${t("vistazo.hidden")}` : detail };
  };

  // ---------- View ----------
  const stage = $("stage");
  let options = readOptions();
  // A player sees the scene as a player, always (the option is the GM's preview of it).
  if (!isGM) {
    options = { ...options, playerView: true };
    $("playerView").closest("label")!.hidden = true;
  }
  const view = new VistazoView(stage, tokenText, options);
  // Minimized, nothing of it shows: its videos (webm tokens and props) stop until it's back.
  onMinimized = (minimized) => view.setPaused(minimized);
  if (!view.ready) {
    message(t("vistazo.noWebgl"));
    return;
  }
  view.setOptions(options);
  const camera = view.camera;

  const tilt = $<HTMLInputElement>("tilt");
  const yaw = $<HTMLInputElement>("yaw");
  view.onCamera = () => {
    if (syncing) {
      sendCamera();
    }
    showCameraTexts();
  };
  /** The camera's readings and the view's button, in the language now (also after a change of it). */
  const showCameraTexts = () => {
    tilt.value = String(camera.tilt);
    yaw.value = String(camera.yaw);
    $("tiltOut").textContent = `${Math.round(camera.tilt)}°`;
    $("yawOut").textContent = `${Math.round(camera.yaw)}°`;
    $("status").textContent = t("vistazo.status", { turn: Math.round(camera.yaw), tilt: Math.round(camera.tilt) });
    $("needle").setAttribute("transform", `rotate(${camera.yaw})`);
    $("toggle").textContent = t(camera.tilt < 1 ? "vistazo.to3d" : "vistazo.toTop");
  };

  const wrapYaw = (y: number) => ((((y + 180) % 360) + 360) % 360) - 180;

  // ---------- Sync my view (see sync.ts) ----------
  let syncing = false;
  let lastSent = 0;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const broadcast = (message: SyncMessage) => OBR.broadcast.sendMessage(SYNC_CHANNEL, message, { destination: "REMOTE" }).catch(() => {});
  /** The GM's camera out, at most every SYNC_INTERVAL_MS (the last position always goes). */
  function sendCamera() {
    if (sendTimer) {
      return;
    }
    const wait = Math.max(0, SYNC_INTERVAL_MS - (performance.now() - lastSent));
    sendTimer = setTimeout(() => {
      sendTimer = null;
      lastSent = performance.now();
      void broadcast({ type: "camera", camera: { ...camera }, since: syncSince });
    }, wait);
  }
  /** When this GM began syncing (see SyncMessage). */
  let syncSince = 0;
  /** `quiet`: stopped because another GM began syncing since: the players aren't told to stop (they follow that one). */
  function setSyncing(on: boolean, quiet = false) {
    syncing = on;
    if (on) {
      syncSince = Date.now();
    }
    $("sync").setAttribute("aria-pressed", String(on));
    $("sync").classList.toggle("on", on);
    // Its text by key, so a change of language (which fills the texts in again) keeps it.
    $("sync").dataset.t = on ? "vistazo.syncStop" : "vistazo.sync";
    $("sync").textContent = t(on ? "vistazo.syncStop" : "vistazo.sync");
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (on) {
      sendCamera();
      heartbeat = setInterval(() => void broadcast({ type: "camera", camera: { ...camera }, since: syncSince }), SYNC_HEARTBEAT_MS);
    } else if (!quiet) {
      void broadcast({ type: "stop" });
    }
  }

  // A player: guided while the GM's camera keeps coming, eased toward it each frame.
  let guided = false;
  let guide: Camera | null = null;
  let guideAt = 0;
  let guideFrame = 0;
  function setGuided(on: boolean) {
    guided = on;
    document.documentElement.classList.toggle("guided", on);
    for (const id of ["tilt", "yaw", "toggle", "reset"]) {
      ($(id) as HTMLInputElement | HTMLButtonElement).disabled = on;
    }
    if (!on) {
      guide = null;
      cancelAnimationFrame(guideFrame);
      guideFrame = 0;
    }
  }
  function followGuide() {
    guideFrame = 0;
    if (!guided || !guide) {
      return;
    }
    if (performance.now() - guideAt > SYNC_TIMEOUT_MS) {
      setGuided(false);
      return;
    }
    const ease = 0.25;
    const turn = wrapYaw(guide.yaw - camera.yaw);
    camera.tilt += (guide.tilt - camera.tilt) * ease;
    camera.yaw = wrapYaw(camera.yaw + turn * ease);
    camera.zoom += (guide.zoom - camera.zoom) * ease;
    camera.panX += (guide.panX - camera.panX) * ease;
    camera.panY += (guide.panY - camera.panY) * ease;
    const from = view.focusPoint();
    const to = guide.focus ?? view.middle();
    camera.focus = { x: from.x + (to.x - from.x) * ease, y: from.y + (to.y - from.y) * ease, z: from.z + (to.z - from.z) * ease };
    view.apply();
    guideFrame = requestAnimationFrame(followGuide);
  }
  if (isGM) {
    $("sync").onclick = () => setSyncing(!syncing);
    // Another GM began syncing after this one: theirs is followed, this one stops.
    OBR.broadcast.onMessage(SYNC_CHANNEL, (event) => {
      const message = event.data as SyncMessage;
      if (syncing && message.type === "camera" && message.since > syncSince) {
        setSyncing(false, true);
      }
    });
  } else {
    $("sync").hidden = true;
    OBR.broadcast.onMessage(SYNC_CHANNEL, (event) => {
      const message = event.data as SyncMessage;
      if (message.type === "stop") {
        setGuided(false);
        return;
      }
      cancelAnimationFrame(frame);
      guide = message.camera;
      guideAt = performance.now();
      if (!guided) {
        setGuided(true);
      }
      if (!guideFrame) {
        guideFrame = requestAnimationFrame(followGuide);
      }
    });
  }
  const clampTilt = (v: number) => Math.max(0, Math.min(150, v));
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let frame = 0;
  type Numbers = "tilt" | "yaw" | "zoom" | "panX" | "panY";
  function animateTo(target: Partial<Camera>, ms = 800) {
    cancelAnimationFrame(frame);
    const from = { ...camera };
    const turn = wrapYaw((target.yaw ?? from.yaw) - from.yaw);
    // The point it turns around glides too: from where it is to the new one (null: the map's middle).
    const focusFrom = view.focusPoint();
    const focusTo = "focus" in target ? (target.focus ?? view.middle()) : null;
    if (reduce) {
      Object.assign(camera, target);
      view.apply();
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      for (const key of Object.keys(target) as (keyof Camera)[]) {
        if (key === "focus") {
          continue;
        }
        const k = key as Numbers;
        camera[k] = k === "yaw" ? wrapYaw(from.yaw + turn * e) : from[k] + (target[k]! - from[k]) * e;
      }
      if (focusTo) {
        camera.focus =
          p < 1 || target.focus
            ? { x: focusFrom.x + (focusTo.x - focusFrom.x) * e, y: focusFrom.y + (focusTo.y - focusFrom.y) * e, z: focusFrom.z + (focusTo.z - focusFrom.z) * e }
            : null;
      }
      view.apply();
      if (p < 1) {
        frame = requestAnimationFrame(step);
      }
    };
    frame = requestAnimationFrame(step);
  }

  /**
   * The camera button: a camera move picked from a list (SHOTS), the panel and buttons out of sight (to
   * show the terrain; with Sync view on, the players see it too). After a moment it runs once, from the
   * camera as it is (the orbit: round the whole terrain), then all comes back. Those that end where they
   * began loop seamlessly when recorded. Esc or a click on the scene stops it there.
   */
  type Pose = { tilt: number; yaw: number; zoom: number };
  const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const turn = (p: number) => Math.sin(2 * Math.PI * p);
  const swell = (p: number) => (1 - Math.cos(2 * Math.PI * p)) / 2;
  const SHOTS: { id: TranslationKey; ms: number; loop: boolean; at: (p: number, from: Pose) => Pose }[] = [
    { id: "vistazo.shotOrbit", ms: 20000, loop: true, at: (p, from) => ({ tilt: 55, yaw: from.yaw + 360 * p, zoom: 1 }) },
    { id: "vistazo.shotSweep", ms: 7000, loop: false, at: (p, from) => ({ tilt: 68 - 20 * ease(p), yaw: from.yaw - 35 + 70 * ease(p), zoom: from.zoom * (0.92 + 0.2 * ease(p)) }) },
    { id: "vistazo.shotPush", ms: 10000, loop: true, at: (p, from) => ({ tilt: from.tilt + 6 * swell(p), yaw: from.yaw + 12 * turn(p), zoom: from.zoom * (1 + 0.9 * swell(p)) }) },
    { id: "vistazo.shotCrane", ms: 8000, loop: false, at: (p, from) => ({ tilt: 2 + 58 * ease(p), yaw: from.yaw - 40 + 40 * ease(p), zoom: 0.85 + 0.55 * ease(p) }) },
    { id: "vistazo.shotPendulum", ms: 12000, loop: true, at: (p, from) => ({ tilt: from.tilt + 6 * turn(2 * p), yaw: from.yaw + 35 * turn(p), zoom: from.zoom }) },
  ];
  let shotFrame = 0;
  let shotEnd: ReturnType<typeof setTimeout> | undefined;
  let shooting = false;
  /** The panel was open when the move began: it's folded away meanwhile (as its own button does), then back. */
  let unfold = false;
  const sweeping = () => shooting;
  function stopSweep() {
    shooting = false;
    cancelAnimationFrame(shotFrame);
    clearTimeout(shotEnd);
    document.documentElement.classList.remove("cinematic");
    if (unfold) {
      unfold = false;
      $("app").classList.remove("compact");
    }
  }
  const pose = (p: Pose) => {
    camera.tilt = clampTilt(p.tilt);
    camera.yaw = wrapYaw(p.yaw);
    camera.zoom = Math.max(0.35, Math.min(8, p.zoom));
    view.apply();
  };
  function cinematic(shot: (typeof SHOTS)[number]) {
    stopSweep();
    cancelAnimationFrame(frame);
    const from: Pose = { tilt: camera.tilt, yaw: camera.yaw, zoom: camera.zoom };
    // The orbit goes round the whole terrain: from its middle.
    if (shot.id === "vistazo.shotOrbit") {
      Object.assign(camera, { panX: 0, panY: 0, focus: null });
    }
    shooting = true;
    document.documentElement.classList.add("cinematic");
    // (Only the layout: its buttons stay where they are, out of sight meanwhile.)
    unfold = !$("app").classList.contains("compact");
    if (unfold) {
      $("app").classList.add("compact");
    }
    pose(shot.at(0, from));
    const t0 = performance.now() + 800;
    const step = (now: number) => {
      if (!shooting) {
        return;
      }
      const p = Math.max(0, (now - t0) / shot.ms);
      pose(shot.at(Math.min(1, p), from));
      if (p < 1) {
        shotFrame = requestAnimationFrame(step);
      } else {
        shotEnd = setTimeout(stopSweep, 800);
      }
    };
    shotFrame = requestAnimationFrame(step);
  }
  // The list under the button.
  let shotMenu: HTMLElement | null = null;
  const closeShots = () => {
    shotMenu?.remove();
    shotMenu = null;
    $("cinematic").setAttribute("aria-expanded", "false");
  };
  $("cinematic").setAttribute("aria-haspopup", "menu");
  $("cinematic").onclick = (event) => {
    event.stopPropagation();
    if (shotMenu) {
      closeShots();
      return;
    }
    const menu = document.createElement("div");
    menu.className = "dd-menu";
    menu.setAttribute("role", "menu");
    for (const shot of SHOTS) {
      const item = document.createElement("div");
      item.className = "dd-item";
      item.setAttribute("role", "menuitem");
      item.tabIndex = -1;
      item.textContent = t(shot.id) + (shot.loop ? "  \u21bb" : "");
      if (shot.loop) {
        item.title = t("vistazo.shotLoops");
      }
      item.onclick = () => {
        closeShots();
        cinematic(shot);
      };
      item.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          item.click();
        }
      };
      menu.append(item);
    }
    document.body.append(menu);
    const r = $("cinematic").getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(6, Math.min(window.innerWidth - menu.offsetWidth - 6, r.right - menu.offsetWidth))}px`;
    shotMenu = menu;
    $("cinematic").setAttribute("aria-expanded", "true");
    (menu.firstElementChild as HTMLElement | null)?.focus();
  };
  document.addEventListener("pointerdown", (event) => shotMenu && !shotMenu.contains(event.target as Node) && !$("cinematic").contains(event.target as Node) && closeShots(), true);
  $("stage").addEventListener("pointerdown", () => sweeping() && stopSweep(), true);
  // Esc stops it (first, wherever the focus is: not closing the window, nor anything else).
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && (sweeping() || shotMenu)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeShots();
        stopSweep();
      }
    },
    true
  );

  let lastPose = { ...POSE };
  $("toggle").onclick = () => {
    if (camera.tilt < 1) {
      animateTo(lastPose);
    } else {
      lastPose = { tilt: camera.tilt, yaw: camera.yaw };
      animateTo({ tilt: 0, yaw: 0 });
    }
  };
  $("reset").onclick = () => animateTo({ ...POSE, zoom: 1, panX: 0, panY: 0, focus: null });
  // The compass resets the view too.
  const resetView = () => {
    if (!guided) {
      animateTo({ ...POSE, zoom: 1, panX: 0, panY: 0, focus: null });
    }
  };
  $("compass").addEventListener("click", resetView);
  $("compass").addEventListener("pointerdown", (event) => event.stopPropagation());
  $("compass").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      resetView();
    }
  });

  // Pointer: drag orbits; the wheel held down (or Shift) pans, as in Owlbear; two fingers zoom and pan.
  const pointers = new Map<number, [number, number]>();
  let mode: "orbit" | "pan" | "pinch" | "token" | "point" | "handle" | null = null;
  /** A template's handle being dragged: which template, and which handle. */
  let handleDrag: { id: string; part: "origin" | "tip" } | null = null;
  /** The free point being dragged: the level it moves over (grid units) and where it was grabbed from. */
  let pointDrag: { level: number; grab: { x: number; y: number } } | null = null;
  let last: [number, number] | null = null;
  let pinch: { d: number; zoom: number; mid: [number, number] } | null = null;
  /** Panning moves the point the camera turns around (not the picture), so it always turns around the screen's middle. */
  const panBy = (dx: number, dy: number) => {
    const from = view.focusPoint();
    const by = view.screenDelta(dx, dy);
    camera.focus = { x: from.x - by.x, y: from.y - by.y, z: from.z };
  };
  // A click on a token (no drag) selects it in Owlbear; a second one soon after turns the camera around it.
  // A double click on the terrain turns it around that point.
  let press: { token: string | null; x: number; y: number } | null = null;
  /**
   * A token (or prop) being moved here (the GM's left drag on it): it follows the
   * terrain under the cursor, snapped to the grid, through Owlbear's own
   * drag (others see it move, its marker rides along); Z/X (the scene's
   * keys) change its own height meanwhile. Written on release; Esc undoes it.
   */
  let moving: {
    id: string;
    item: Image;
    /** The level it's dragged over (grid units up: its height when grabbed). */
    level: number;
    /** From the point under the cursor (on that level) to the token's position, scene px. */
    grab: Vector2;
    own: number;
    startOwn: number;
    started: boolean;
    interaction: Promise<InteractionManager<Image>> | null;
    position: Vector2;
    path: DragPath;
  } | null = null;
  const stagePoint = (event: { clientX: number; clientY: number }) => {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  /**
   * Tokens let go, shown where they landed (see live) till the scene has them there: the token's saved
   * along the way it went, a step at a time (so the fog's walls don't stop it), and those steps come
   * back later than they're written, some after the last. By token: where it landed, and the wait's end.
   */
  const landing = new Map<string, { at: Vector2 | null; until: number }>();
  /** How long (ms) a landing is waited for at most (a save that never shows): then the scene's place. */
  const LANDING_MS = 3000;
  /** The tokens whose landing the scene now shows (or waited for long enough): following the scene again. */
  const landed = () => {
    let any = false;
    for (const [id, wait] of landing) {
      const item = items.find((i) => i.id === id);
      const there = !!wait.at && !!item && Math.hypot(item.position.x - wait.at.x, item.position.y - wait.at.y) < 0.5;
      if (there || performance.now() > wait.until) {
        landing.delete(id);
        live.delete(id);
        any = true;
      }
    }
    if (any) {
      showDistances();
      // Now the relief can follow the fog (see refresh).
      later();
    }
  };
  /**
   * The drag over: shown where it was let go till `saved` (the place it's saved at, null: back where it
   * started) is what the scene has (see landing); then the scene's own place, the rings following it.
   */
  const endMove = (saved: Promise<Vector2 | null | void> = Promise.resolve(null)) => {
    moving = null;
    cancelMove = null;
    if (draggingId) {
      const id = draggingId;
      draggingId = null;
      void saved
        .catch(() => null)
        .then((at) => {
          landing.set(id, { at: at ?? null, until: performance.now() + LANDING_MS });
          landed();
          setTimeout(landed, LANDING_MS + 50);
        });
    }
  };
  let lastClick = { token: "", at: 0, x: 0, y: 0 };

  // ---------- The relief editor's terrain brush, on the 3D terrain ----------
  // With it in hand, the left button paints where the pointer is on the terrain (as on the 2D map, its
  // keys too); the right one still turns the camera, the middle one moves it.
  /** The pointer painting (pressed on the terrain), if one is. */
  let brushPointer: number | null = null;
  const modsOf = (event: PointerEvent) => ({ shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey || event.metaKey, clicks: 1 });
  /** The edited map's cell under the pointer on the terrain (null: none, or no brush in hand). */
  const brushCell = (event: PointerEvent) => {
    const map = session && items.find((item): item is Image => item.id === session!.imageId && item.type === "IMAGE");
    if (!session?.brush.active() || !map || !scene) {
      return null;
    }
    const at = stagePoint(event);
    const ground = view.pickTerrain(at.x, at.y);
    if (!ground) {
      return null;
    }
    const [x, y] = sceneToCell(anchorOf(map), dpi, ground.x, ground.y);
    return { x, y, anchor: anchorOf(map) };
  };
  /** The brush's ring round a cell, on the terrain (or none). */
  const showBrush = (cell: { x: number; y: number; anchor: Anchor } | null) => {
    if (!cell || !session) {
      view.setBrushRing(null);
      stage.classList.remove("re-brushing");
      return;
    }
    const r = session.brush.radius();
    const ring = Array.from({ length: 48 }, (_, i) => cellToScene(cell.anchor, dpi, cell.x + r * Math.cos((i / 48) * Math.PI * 2), cell.y + r * Math.sin((i / 48) * Math.PI * 2)));
    view.setBrushRing(ring);
    stage.classList.add("re-brushing");
  };
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !session?.brush.active() || (event.target as Element).closest("button")) {
      return;
    }
    // Caught here, before the camera's own (see below).
    event.stopImmediatePropagation();
    event.preventDefault();
    stage.focus({ preventScroll: true });
    const cell = brushCell(event);
    if (cell) {
      brushPointer = event.pointerId;
      stage.setPointerCapture(event.pointerId);
      session.brush.down(cell, modsOf(event));
    }
    showBrush(cell);
  });
  stage.addEventListener("pointermove", (event) => {
    if (!session?.brush.active()) {
      if (stage.classList.contains("re-brushing")) {
        showBrush(null);
      }
      return;
    }
    const held = brushPointer === event.pointerId;
    // Turning or moving the camera (another button held): only the ring.
    if (!held && pointers.size > 0) {
      showBrush(null);
      return;
    }
    const cell = brushCell(event);
    if (cell) {
      session.brush.move(cell, modsOf(event), held);
    } else if (!held) {
      session.brush.leave();
    }
    showBrush(cell);
  });
  const brushUp = (event: PointerEvent) => {
    if (brushPointer !== event.pointerId) {
      return;
    }
    event.stopImmediatePropagation();
    brushPointer = null;
    session?.brush.up();
  };
  stage.addEventListener("pointerup", brushUp);
  stage.addEventListener("pointercancel", brushUp);
  stage.addEventListener("pointerleave", () => {
    if (brushPointer === null && session) {
      session.brush.leave();
      showBrush(null);
    }
  });

  stage.addEventListener("contextmenu", (event) => event.preventDefault());
  stage.addEventListener("mousedown", (event) => {
    if (event.button === 1) {
      event.preventDefault();
    }
  });
  stage.addEventListener("auxclick", (event) => event.preventDefault());
  stage.addEventListener("pointerdown", (event) => {
    // The stage's own buttons (the panel toggle) keep their clicks.
    if ((event.target as Element).closest("button")) {
      return;
    }
    // Placing a template: this press puts it down (a cone or a line: from here, pointed by the drag).
    if (placing && event.button === 0 && scene) {
      event.preventDefault();
      const at = stagePoint(event);
      const ground = view.pickTerrain(at.x, at.y);
      if (ground) {
        const template = newTemplate(ground);
        if (template.shape === "cone" || template.shape === "line") {
          aiming = template;
          stage.setPointerCapture(event.pointerId);
          view.setTemplates([...templates, template]);
        } else {
          addTemplate(template);
        }
      }
      return;
    }
    // Guided by the GM's camera: it isn't this player's to move.
    if (guided) {
      return;
    }
    event.preventDefault();
    stage.focus({ preventScroll: true });
    cancelAnimationFrame(frame);
    const point = stagePoint(event);
    press = pointers.size === 0 && event.button === 0 ? { token: view.tokenAt(event.target) ?? view.propAt(point.x, point.y), x: event.clientX, y: event.clientY } : null;
    // A left press on an unlocked token or prop, without Shift: ready to move it (from the first few px of drag).
    const pressed = press?.token && !event.shiftKey ? (scene?.tokens.find((t) => t.id === press!.token) ?? scene?.props.find((p) => p.id === press!.token)) : undefined;
    if (pressed && !pressed.item.locked && isGM) {
      const at = stagePoint(event);
      // Dragged over a level at its height when grabbed (see pickPlane), not over whatever's under the cursor.
      const level = pressed.terrain + pressed.own;
      const ground = view.pickPlane(at.x, at.y, level) ?? view.pickTerrain(at.x, at.y);
      if (ground) {
        moving = {
          id: pressed.id,
          item: pressed.item,
          level,
          grab: { x: pressed.item.position.x - ground.x, y: pressed.item.position.y - ground.y },
          own: pressed.own,
          startOwn: pressed.own,
          started: false,
          interaction: null,
          position: pressed.item.position,
          path: new DragPath(pressed.item.position),
        };
      }
    }
    // A press on a template's handle: ready to move it (its origin) or turn it (its tip).
    handleDrag = null;
    if (press?.token?.startsWith(TEMPLATE_HANDLE)) {
      const [id, part] = press.token.slice(TEMPLATE_HANDLE.length).split(":");
      const template = templates.find((t) => t.id === id);
      if (template) {
        handleDrag = { id, part: part === "tip" ? "tip" : "origin" };
        activeTemplate = id;
        activePart = handleDrag.part;
      }
    }
    // A press on the free point's marker: ready to drag it (anyone can: it's only this view's).
    pointDrag = null;
    if (press?.token === FREE_POINT && freePoint && scene) {
      const at = stagePoint(event);
      const level = scene.measuredAt(freePoint.x, freePoint.y) + freePoint.own;
      const ground = view.pickPlane(at.x, at.y, level);
      if (ground) {
        pointDrag = { level, grab: { x: freePoint.x - ground.x, y: freePoint.y - ground.y } };
      }
    }
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    stage.classList.add("dragging");
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: camera.zoom, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      mode = "pinch";
    } else {
      mode = moving ? "token" : handleDrag ? "handle" : pointDrag ? "point" : event.button === 1 || event.shiftKey ? "pan" : "orbit";
      last = [event.clientX, event.clientY];
    }
  });
  stage.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) {
      return;
    }
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (mode === "pinch" && pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      camera.zoom = Math.max(0.35, Math.min(8, (pinch.zoom * Math.hypot(a[0] - b[0], a[1] - b[1])) / pinch.d));
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      panBy(mid[0] - pinch.mid[0], mid[1] - pinch.mid[1]);
      pinch.mid = mid;
    } else if (last) {
      const dx = event.clientX - last[0];
      const dy = event.clientY - last[1];
      last = [event.clientX, event.clientY];
      // A template's handle dragged: its origin moves it (over the ground), its tip turns it.
      if (mode === "handle" && handleDrag && scene) {
        const drag = handleDrag;
        const template = templates.find((t) => t.id === drag.id);
        const at = stagePoint(event);
        const ground = template && (view.pickPlane(at.x, at.y, template.z) ?? view.pickTerrain(at.x, at.y));
        if (template && ground) {
          let next: Template = template;
          if (drag.part === "origin") {
            // Keeping its height over the ground.
            next = { ...template, x: ground.x, y: ground.y, z: scene.measuredAt(ground.x, ground.y) + template.lift };
          } else {
            const [dx, dy] = [ground.x - template.x, ground.y - template.y];
            const length = Math.hypot(dx, dy);
            if (length > dpi * 0.1) {
              next = { ...template, dir: { x: dx / length, y: dy / length } };
            }
          }
          templates = templates.map((t) => (t.id === next.id ? next : t));
          view.setTemplates(templates);
          updateAffected();
        }
        return;
      }
      // The free point dragged: over a level at its height, its rings and lines following it.
      if (mode === "point" && pointDrag && freePoint) {
        const at = stagePoint(event);
        const ground = view.pickPlane(at.x, at.y, pointDrag.level);
        if (ground) {
          placePoint({ x: ground.x + pointDrag.grab.x, y: ground.y + pointDrag.grab.y, own: freePoint.own });
        }
        return;
      }
      if (mode === "token" && moving) {
        const move = moving;
        if (!move.started && press && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 5) {
          return;
        }
        if (!move.started) {
          move.started = true;
          move.interaction = OBR.interaction.startItemInteraction(move.item);
          cancelMove = () => {
            void move.interaction?.then(([, stop]) => stop());
            endMove();
            mode = null;
            live.delete(move.id);
            refresh();
          };
        }
        const at = stagePoint(event);
        const ground = view.pickPlane(at.x, at.y, move.level);
        if (ground) {
          // Following the cursor as it goes, unsnapped: Owlbear stops a drag at the walls of the
          // dynamic fog (its own, or Smoke & Spectre's), and a jump from cell to cell across a
          // corner would cut through one. Snapped to the grid on release (finishMove).
          const position = { x: ground.x + move.grab.x, y: ground.y + move.grab.y };
          move.position = position;
          move.path.add(position, dpi * 0.1);
          void move.interaction?.then(([update]) => {
            if (moving === move) {
              update((token) => {
                token.position = position;
              });
            }
          });
          showTokenAt(move.id, position, move.own);
        }
        return;
      }
      if (mode === "pan") {
        panBy(dx, dy);
      } else {
        camera.yaw = wrapYaw(camera.yaw - dx * 0.3);
        camera.tilt = clampTilt(camera.tilt - dy * 0.25);
      }
    }
    view.apply();
  });
  const up = (event: PointerEvent) => {
    const move = moving;
    if (move && (move.started || move.own !== move.startOwn) && event.type === "pointerup") {
      press = null;
      endMove(finishMove(move));
    } else if (move) {
      // Cancelled (or never really moved): Owlbear's drag, if it began, ends where it started.
      if (move.started) {
        void move.interaction?.then(([, stop]) => stop());
        live.delete(move.id);
        refresh();
      }
      endMove();
    }
    pointDrag = null;
    if (handleDrag) {
      handleDrag = null;
      // Its list redrawn; a failure there mustn't keep the pointer held (the drag would go on).
      try {
        showTemplates();
      } catch (error) {
        console.error("Rising Ranges: 3D Glance couldn't redraw the templates", error);
      }
    }
    // A click on the free point's marker or a template's handle: nothing (no token, no ground).
    if (press?.token === FREE_POINT || press?.token?.startsWith(TEMPLATE_HANDLE)) {
      press = null;
    }
    if (press && event.type === "pointerup" && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 5) {
      const id = press.token ?? "";
      const now = performance.now();
      const again = lastClick.token === id && now - lastClick.at < 400 && Math.hypot(event.clientX - lastClick.x, event.clientY - lastClick.y) < 10;
      if (again) {
        const rect = stage.getBoundingClientRect();
        const focus = id ? view.tokenFocus(id) : view.pickTerrain(event.clientX - rect.left, event.clientY - rect.top);
        if (focus) {
          animateTo({ focus, panX: 0, panY: 0, zoom: id ? Math.max(camera.zoom, 2.5) : camera.zoom });
        }
        lastClick = { token: "", at: 0, x: 0, y: 0 };
      } else {
        if (id) {
          void OBR.player.select([id]);
        } else {
          // On empty ground: the free point there, measured from instead of a token.
          const rect = stage.getBoundingClientRect();
          const ground = view.pickTerrain(event.clientX - rect.left, event.clientY - rect.top);
          if (ground) {
            placePoint({ x: ground.x, y: ground.y, own: 0 });
          }
        }
        lastClick = { token: id, at: now, x: event.clientX, y: event.clientY };
      }
    }
    press = null;
    pointers.delete(event.pointerId);
    if (pointers.size === 0) {
      mode = null;
      last = null;
      stage.classList.remove("dragging");
    } else if (pointers.size === 1) {
      mode = "orbit";
      last = [...pointers.values()][0];
    }
  };
  stage.addEventListener("pointerup", up);
  // A cone or a line being pointed: toward the ground under the cursor; let go, it's placed.
  stage.addEventListener("pointermove", (event) => {
    if (!aiming) {
      return;
    }
    const at = stagePoint(event);
    const ground = view.pickPlane(at.x, at.y, aiming.z) ?? view.pickTerrain(at.x, at.y);
    if (ground) {
      const [dx, dy] = [ground.x - aiming.x, ground.y - aiming.y];
      const length = Math.hypot(dx, dy);
      if (length > dpi * 0.1) {
        aiming = { ...aiming, dir: { x: dx / length, y: dy / length } };
        view.setTemplates([...templates, aiming]);
      }
    }
  });
  stage.addEventListener("pointerup", () => {
    if (aiming) {
      const template = aiming;
      aiming = null;
      addTemplate(template);
    }
  });
  stage.addEventListener("pointercancel", up);
  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (guided) {
        return;
      }
      cancelAnimationFrame(frame);
      camera.zoom = Math.max(0.35, Math.min(8, camera.zoom * Math.exp(-event.deltaY * 0.0015)));
      view.apply();
    },
    { passive: false }
  );
  stage.addEventListener("keydown", (event) => {
    // The template last put down or grabbed (no token moving): raised and lowered by the same keys.
    const active = activeTemplate && !moving && !event.repeat ? templates.find((t) => t.id === activeTemplate) : undefined;
    if (active && scene) {
      const settings = globalSettingsFromMetadata(sceneMetadata);
      const bandSet = onGrid(bandSetFromMetadata(sceneMetadata), gridType);
      // Its tip (a cone's or a line's, if that's what was grabbed): its own height over the origin.
      const tip = activePart === "tip" && (active.shape === "cone" || active.shape === "line");
      const before = tip ? active.rise : active.lift;
      let value = before;
      if (event.code === letterToCode(settings.hotkeyRaise)) {
        value = stepHeight(value, 1, bandSet);
      } else if (event.code === letterToCode(settings.hotkeyLower)) {
        value = stepHeight(value, -1, bandSet);
      } else if (event.code === letterToCode(groundHotkey(settings))) {
        value = 0;
      }
      if (value !== before) {
        event.preventDefault();
        const next = tip
          ? { ...active, rise: Math.max(-active.size, Math.min(active.size, value)) }
          : { ...active, lift: value, z: scene.measuredAt(active.x, active.y) + value };
        templates = templates.map((t) => (t.id === next.id ? next : t));
        showTemplates();
        return;
      }
    }
    // The free point (no token moving): raised and lowered by the same keys.
    if (!moving && freePoint && !event.repeat) {
      const settings = globalSettingsFromMetadata(sceneMetadata);
      const bandSet = onGrid(bandSetFromMetadata(sceneMetadata), gridType);
      const before = freePoint.own;
      if (event.code === letterToCode(settings.hotkeyRaise)) {
        freePoint.own = stepHeight(freePoint.own, 1, bandSet);
      } else if (event.code === letterToCode(settings.hotkeyLower)) {
        freePoint.own = stepHeight(freePoint.own, -1, bandSet);
      } else if (event.code === letterToCode(groundHotkey(settings))) {
        freePoint.own = 0;
      }
      if (freePoint.own !== before) {
        event.preventDefault();
        placePoint(freePoint);
        return;
      }
    }
    // While a token's being moved: its own height, by the scene's keys (as in the Medición).
    if (moving && !event.repeat) {
      const settings = globalSettingsFromMetadata(sceneMetadata);
      if (settings.enableAltitude ?? true) {
        const bandSet = onGrid(bandSetFromMetadata(sceneMetadata), gridType);
        const before = moving.own;
        if (event.code === letterToCode(settings.hotkeyRaise)) {
          moving.own = stepHeight(moving.own, 1, bandSet);
        } else if (event.code === letterToCode(settings.hotkeyLower)) {
          moving.own = stepHeight(moving.own, -1, bandSet);
        } else if (event.code === letterToCode(groundHotkey(settings))) {
          moving.own = 0;
        }
        if (moving.own !== before) {
          event.preventDefault();
          showTokenAt(moving.id, moving.position, moving.own);
          return;
        }
      }
    }
    const keys: Record<string, () => void> = {
      ArrowLeft: () => (camera.yaw = wrapYaw(camera.yaw + 5)),
      ArrowRight: () => (camera.yaw = wrapYaw(camera.yaw - 5)),
      ArrowUp: () => (camera.tilt = clampTilt(camera.tilt + 3)),
      ArrowDown: () => (camera.tilt = clampTilt(camera.tilt - 3)),
      "+": () => (camera.zoom = Math.min(8, camera.zoom * 1.15)),
      "=": () => (camera.zoom = Math.min(8, camera.zoom * 1.15)),
      "-": () => (camera.zoom = Math.max(0.35, camera.zoom / 1.15)),
    };
    if (keys[event.key] && !guided) {
      event.preventDefault();
      cancelAnimationFrame(frame);
      keys[event.key]();
      view.apply();
    }
  });

  // ---------- Controls ----------
  tilt.oninput = () => {
    cancelAnimationFrame(frame);
    camera.tilt = Number(tilt.value);
    view.apply();
  };
  yaw.oninput = () => {
    cancelAnimationFrame(frame);
    camera.yaw = Number(yaw.value);
    view.apply();
  };
  /** The clouds' choice, only when there are clouds to draw (Weather's, with the weather on). */
  function showCloudsChoice() {
    $("cloudsRow").hidden = !options.weather || !scene?.weather.some((weather) => weather.type === "CLOUD");
  }
  const set = (change: Partial<Options>) => {
    options = { ...options, ...change };
    saveOptions(options);
    view.setOptions(change);
    showOptions();
    if ("playerView" in change) {
      watchLocal(options.playerView);
      refresh();
    }
    // The lines to the props come and go with these.
    if ("propDistances" in change || "showProps" in change) {
      showDistances();
    }
  };
  const persp = $<HTMLInputElement>("persp");
  const hscale = $<HTMLInputElement>("hscale");
  const shade = $<HTMLInputElement>("shade");
  const check = (id: string) => $<HTMLInputElement>(id);
  const anchor = $<HTMLSelectElement>("anchor");
  function showOptions() {
    persp.value = String(options.perspective);
    $("perspOut").textContent = t(options.perspective < 15 ? "vistazo.perspFlat" : options.perspective > 75 ? "vistazo.perspStrong" : "vistazo.perspMid");
    hscale.value = String(options.heightScale);
    $("hscaleOut").textContent = `×${options.heightScale}`;
    shade.value = String(Math.round(options.shade * 100));
    $("shadeOut").textContent = `${Math.round(options.shade * 100)}%`;
    check("tint").checked = options.tint;
    check("showTok").checked = options.tokens;
    // A token's point and its distance lines only mean something with the tokens shown.
    $("tokensMore").hidden = !options.tokens;
    $("labelsMore").hidden = !options.tokens;
    check("xray").checked = options.xray;
    check("edges").checked = options.edges;
    check("waterMotion").checked = options.waterMotion;
    check("videoMaps").checked = options.videoMaps;
    for (const button of $("quality").querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.value === options.quality));
    }
    check("levels").checked = options.levels;
    check("grid").checked = options.grid;
    check("distances").checked = options.distances;
    check("rings").checked = options.rings;
    check("playerView").checked = options.playerView;
    check("ringFill").checked = options.ringFill;
    check("weather").checked = options.weather;
    $<HTMLSelectElement>("clouds").value = options.clouds;
    showCloudsChoice();
    check("showProps").checked = options.showProps;
    $("propsMore").hidden = !options.showProps;
    check("propShadows").checked = options.propShadows;
    check("propDistances").checked = options.propDistances;
    check("propLines").checked = options.propLines;
    check("propLabels").checked = options.propLabels;
    $<HTMLSelectElement>("tokenLabels").value = options.tokenLabels;
    $<HTMLSelectElement>("props").value = options.props;
    $<HTMLSelectElement>("distanceLabels").value = options.distanceLabels;
    $<HTMLInputElement>("labelSize").value = String(options.labelSize);
    $("labelSizeOut").textContent = `${Math.round(options.labelSize * 100)}%`;
    $<HTMLInputElement>("relief").value = String(Math.round(options.relief * 100));
    $("reliefOut").textContent = `${Math.round(options.relief * 100)}%`;
    anchor.value = options.anchor;
  }
  persp.oninput = () => set({ perspective: Number(persp.value) });
  hscale.oninput = () => set({ heightScale: Number(hscale.value) });
  shade.oninput = () => set({ shade: Number(shade.value) / 100 });
  check("tint").onchange = () => set({ tint: check("tint").checked });
  check("showTok").onchange = () => set({ tokens: check("showTok").checked });
  check("xray").onchange = () => set({ xray: check("xray").checked });
  check("edges").onchange = () => set({ edges: check("edges").checked });
  check("waterMotion").onchange = () => set({ waterMotion: check("waterMotion").checked });
  check("videoMaps").onchange = () => set({ videoMaps: check("videoMaps").checked });
  for (const button of $("quality").querySelectorAll("button")) {
    button.onclick = () => set({ quality: button.value === "low" ? "low" : button.value === "medium" ? "medium" : "high" });
  }
  check("levels").onchange = () => set({ levels: check("levels").checked });
  check("grid").onchange = () => set({ grid: check("grid").checked });
  check("distances").onchange = () => set({ distances: check("distances").checked });
  check("rings").onchange = () => set({ rings: check("rings").checked });
  check("playerView").onchange = () => set({ playerView: check("playerView").checked });
  check("ringFill").onchange = () => set({ ringFill: check("ringFill").checked });
  check("weather").onchange = () => set({ weather: check("weather").checked });
  const clouds = $<HTMLSelectElement>("clouds");
  clouds.onchange = () => set({ clouds: clouds.value === "shadows" ? "shadows" : "mist" });
  check("showProps").onchange = () => set({ showProps: check("showProps").checked });
  check("propShadows").onchange = () => set({ propShadows: check("propShadows").checked });
  check("propDistances").onchange = () => set({ propDistances: check("propDistances").checked });
  check("propLines").onchange = () => set({ propLines: check("propLines").checked });
  check("propLabels").onchange = () => set({ propLabels: check("propLabels").checked });
  const props = $<HTMLSelectElement>("props");
  props.onchange = () => set({ props: props.value as Options["props"] });
  const tokenLabels = $<HTMLSelectElement>("tokenLabels");
  tokenLabels.onchange = () => set({ tokenLabels: tokenLabels.value as Options["tokenLabels"] });
  const distanceLabels = $<HTMLSelectElement>("distanceLabels");
  distanceLabels.onchange = () => set({ distanceLabels: distanceLabels.value as Options["distanceLabels"] });
  const labelSize = $<HTMLInputElement>("labelSize");
  labelSize.oninput = () => set({ labelSize: Number(labelSize.value) });
  const relief = $<HTMLInputElement>("relief");
  relief.oninput = () => set({ relief: Number(relief.value) / 100 });
  anchor.onchange = () => set({ anchor: anchor.value === "base" ? "base" : "center" });
  showOptions();

  // ---------- The scene, kept up to date ----------
  let items = await OBR.scene.items.getItems();
  let sceneMetadata = metadata;
  let [dpi, scale] = await Promise.all([OBR.scene.grid.getDpi(), OBR.scene.grid.getScale()]);
  // The templates' size is typed in the grid's own unit.
  $("templateUnit").textContent = scale.parsed.unit;
  // Digits only, 1 to 999, typed or stepped.
  const templateSize = $<HTMLInputElement>("templateSize");
  const sizeTo = (value: number) => (templateSize.value = String(Math.min(999, Math.max(1, Math.round(value) || 1))));
  templateSize.oninput = () => (templateSize.value = templateSize.value.replace(/\D/g, ""));
  templateSize.onchange = () => sizeTo(Number(templateSize.value));
  for (const step of templateSize.parentElement!.querySelectorAll<HTMLButtonElement>(".step")) {
    step.onclick = () => sizeTo(Number(templateSize.value) + Number(step.dataset.by));
  }
  // On a hex grid, one cell's center: where its cells are drawn from (see useTexture).
  const findHexCenter = async () =>
    gridType === "HEX_HORIZONTAL" || gridType === "HEX_VERTICAL" ? await OBR.scene.grid.snapPosition({ x: 0, y: 0 }, 1, false, true) : null;
  let hexCenter = await findHexCenter().catch(() => null);
  let selection: string[] = (await OBR.player.getSelection()) ?? [];
  /** The token being dragged (here, or with the Medición tool): its rings stay where the drag began, as on the map. */
  let draggingId: string | null = null;
  /** The selected token, or prop (with the lines to props on): where the lines and rings go from. */
  const selectedOrigin = () => {
    // The free point, while there's one (selecting a token takes it away).
    if (freePoint) {
      return pointOrigin();
    }
    if (!scene || selection.length !== 1) {
      return undefined;
    }
    const withProps = options.propDistances && options.showProps;
    return scene.tokens.find((token) => token.id === selection[0]) ?? (withProps ? scene.props.find((prop) => prop.id === selection[0]) : undefined);
  };
  /**
   * The free point as an origin, a token's size (one cell), at the ground
   * there plus its own height: the item the distance math reads is made up.
   */
  const pointOrigin = () => {
    if (!scene || !freePoint) {
      return undefined;
    }
    const terrain = scene.measuredAt(freePoint.x, freePoint.y);
    const item = {
      id: FREE_POINT,
      type: "IMAGE",
      name: "",
      position: { x: freePoint.x, y: freePoint.y },
      rotation: 0,
      scale: { x: 1, y: 1 },
      image: { width: dpi, height: dpi, url: "", mime: "image/png" },
      grid: { dpi, offset: { x: dpi / 2, y: dpi / 2 } },
      metadata: {},
      text: { plainText: "" },
    } as unknown as Image;
    return { id: FREE_POINT, x: freePoint.x, y: freePoint.y, terrain, own: freePoint.own, item };
  };
  /** The free point (scene px, and its own height over the ground there), or none. */
  let freePoint: { x: number; y: number; own: number } | null = null;
  function placePoint(point: { x: number; y: number; own: number } | null) {
    // On a hex grid, as the map's Medición: at its cell's center or, near one, a corner (see snapToOrigin).
    const shape = onGrid(bandSetFromMetadata(sceneMetadata), gridType).shape;
    if (point && hexCenter && isHexShape(shape)) {
      point = { ...snapToOrigin(point, hexCenter, dpi, shape).point, own: point.own };
    }
    freePoint = point;
    // The scene's keys move the point now, not a template.
    if (point) {
      activeTemplate = null;
    }
    if (point && scene) {
      // A token selected is measured from first: the point takes its place.
      // Cleared here too, at once: Owlbear tells us a moment later.
      if (selection.length > 0) {
        selection = [];
        view.setSelected([]);
        void OBR.player.deselect();
      }
      view.setPoint({ x: point.x, y: point.y, height: scene.measuredAt(point.x, point.y) + point.own });
    } else {
      view.setPoint(null);
    }
    showDistances();
  }
  clearPoint = () => {
    if (!freePoint) {
      return false;
    }
    placePoint(null);
    return true;
  };
  /**
   * With one token selected, lines to every other token within a Banda —
   * the same readings as the Distancias panel (heights with the terrain).
   */
  const showDistances = () => {
    updateAffected();
    const origin = selectedOrigin();
    if (!scene || !origin) {
      view.setDistances(null, []);
      view.setReach(null);
      return;
    }
    const bandSet = onGrid(bandSetFromMetadata(sceneMetadata), gridType);
    const theme = getStoredTheme();
    // The Bandas' reach around it, measured as a Lectura would (against a standard-sized token);
    // left where it was while it's dragged.
    const radius = getTokenRadius(origin.item, dpi, 0);
    if (origin.id === draggingId) {
      showLines();
      return;
    }
    const tolerance = (bandSet.tolerance ?? DEFAULT_TOLERANCE) / 100;
    view.setReach({
      x: origin.x,
      y: origin.y,
      z: bodyCenterHeight(origin.terrain + origin.own, radius),
      excess: excessRadius(radius),
      shape: bandSet.shape,
      // On a hex grid, the cells it's measured from: its own, or the three round a corner (as the map's).
      cells: isHexShape(bandSet.shape) && hexCenter ? originCellsAt(origin, hexCenter, dpi, bandSet.shape) : [{ x: 0, y: 0 }],
      bands: bandSet.bands.map((band, index) => ({ reach: band.radius + tolerance, color: getColorString(theme.colors[index % theme.colors.length]) })),
    });
    showLines();
  };
  /** The distance lines from the selected token, where it is now. */
  const showLines = () => {
    const origin = selectedOrigin();
    if (!scene || !origin) {
      return;
    }
    const bandSet = onGrid(bandSetFromMetadata(sceneMetadata), gridType);
    const bands = measuredBands(bandSet);
    const theme = getStoredTheme();
    // To the props as well, with their option on (and the props shown): each at its own height.
    const props = options.propDistances && options.showProps ? scene.props.filter((prop) => prop.id !== origin.id) : [];
    const heights = new Map([...scene.heights, ...props.map((prop) => [prop.id, prop.terrain + prop.own] as const), [origin.id, origin.terrain + origin.own] as const]);
    const rows = computeDistanceRows(
      origin.item,
      [...scene.tokens.filter((token) => token.id !== origin.id).map((token) => token.item), ...props.map((prop) => prop.item)],
      heights,
      bandSet,
      dpi,
      0
    );
    const lines: DistanceLine[] = [];
    for (const row of rows) {
      if (row.bandIndex === null) {
        continue;
      }
      lines.push({
        id: row.token.id,
        color: getColorString(theme.colors[row.bandIndex % theme.colors.length]),
        band: bands[row.bandIndex].name,
        distance: formatDistance(scale, row.distance),
      });
    }
    view.setDistances(origin.id, lines);
  };
  view.setSelected(selection);
  OBR.player.onChange((player) => {
    selection = player.selection ?? [];
    view.setSelected(selection);
    // A token (or prop) selected: measured from instead of the free point.
    if (selection.length > 0 && freePoint) {
      freePoint = null;
      view.setPoint(null);
    }
    showDistances();
  });

  /**
   * Tokens being dragged (here or with the Medición tool), where they are now: kept
   * through any rebuild of the scene meanwhile (their light moving redoes the fog, from
   * the scene, which still has them where the drag began), and never hidden by the fog.
   */
  const live = new Map<string, { position: Vector2; own?: number }>();
  /** `from` with a token moved to `position` (and `own` height). */
  function placed(from: VistazoScene, tokenId: string, position: Vector2, own?: number): VistazoScene {
    const token = from.tokens.find((t) => t.id === tokenId);
    if (!token) {
      // A prop: drawn again from its image where it's been moved.
      const prop = from.props.find((p) => p.id === tokenId);
      if (!prop) {
        return from;
      }
      const moved = propOf({ ...prop.item, position }, dpi, from.measuredAt, own ?? prop.own);
      return { ...from, props: from.props.map((p) => (p.id === tokenId ? moved : p)) };
    }
    const x = token.x + position.x - token.item.position.x;
    const y = token.y + position.y - token.item.position.y;
    const moved = { ...token, x, y, own: own ?? token.own, terrain: from.measuredAt(x, y), item: { ...token.item, position } };
    return { ...from, tokens: from.tokens.map((t) => (t.id === tokenId ? moved : t)), heights: new Map(from.heights).set(tokenId, moved.terrain + moved.own) };
  }
  /** A token shown here at `position` (and `own` height, if given) before the scene says so. */
  function showTokenAt(tokenId: string, position: Vector2, own?: number) {
    if (!scene?.tokens.some((t) => t.id === tokenId) && !scene?.props.some((p) => p.id === tokenId)) {
      return;
    }
    draggingId = tokenId;
    live.set(tokenId, { position, own });
    scene = placed(scene, tokenId, position, own);
    // Drawn once a frame at most: a drag sends far more moves than the screen shows.
    if (!showFrame) {
      showFrame = requestAnimationFrame(() => {
        showFrame = 0;
        if (scene) {
          view.setScene(scene);
          showDistances();
        }
      });
    }
  }
  let showFrame = 0;

  /** A move here released: its position saved (ending Owlbear's drag), then its height marker if it changed. */
  async function finishMove(move: NonNullable<typeof moving>): Promise<Vector2 | null> {
    try {
      if (move.started && move.interaction) {
        const [update, stop] = await move.interaction;
        // Snapped to the grid where it's let go, as Owlbear's own move does.
        const snapped = await OBR.scene.grid.snapPosition(move.position);
        move.position = snapped;
        // Shown there now (not where it was let go, nor the steps it's saved along: see endMove); the
        // drag's over (it isn't taken for one again: showTokenAt would).
        if (live.has(move.id) && scene) {
          live.set(move.id, { position: snapped, own: move.own });
          scene = placed(scene, move.id, snapped, move.own);
          view.setScene(scene);
        }
        const final = update((token) => {
          token.position = snapped;
        });
        try {
          // Along the way it was dragged, so the fog's walls don't stop it where it went around them, with
          // its attachments, as the Medición saves it (see saveDraggedToken).
          const saved = await saveDraggedToken(final, move.path);
          if (!saved) {
            // Not saved: ending the drag puts it back where it started (its height marker too, below).
            move.position = move.item.position;
            refresh();
          }
        } finally {
          stop();
        }
      }
      if (move.own !== move.startOwn) {
        await setTokenHeightMarker([{ ...move.item, position: move.position }], move.own);
      }
      return move.position;
    } catch (error) {
      console.error("Rising Ranges: 3D Glance couldn't save the moved token", error);
      refresh();
      return null;
    }
  }

  // The fog, for the player view: Owlbear's setting, and this client's local items (Smoke & Spectre's lights and walls).
  let fogFilled = await OBR.scene.fog.getFilled().catch(() => false);
  let fogColor = await OBR.scene.fog.getColor().catch(() => "#222222");
  let localItems = options.playerView ? await OBR.scene.local.getItems().catch(() => []) : [];
  /** What of the local items the fog depends on (lights and walls), so other local changes don't redo it. */
  const sightKey = (list: typeof localItems) =>
    JSON.stringify(list.filter((item) => item.type === "LIGHT" || item.type === "WALL").map((item) => [item.id, item.position, item.rotation, item.visible, (item as { points?: unknown }).points, (item as { attenuationRadius?: unknown }).attenuationRadius]));
  let localSight = sightKey(localItems);
  let fogKey = "";
  let lastFog: ReturnType<typeof fogOver> | null = null;
  /** The fog the relief was last cut to (see refresh), its key, and the wait for the fog to settle. */
  let sightFog: ReturnType<typeof fogOver> | null = null;
  let sightFogKey = "";
  let sightTimer: ReturnType<typeof setTimeout> | null = null;
  OBR.scene.fog.onChange((fog) => {
    fogFilled = fog.filled;
    fogColor = fog.style.color;
    fogKey = "";
    later();
  });
  // Followed only for the player view: every local item comes with each change, and the Medición
  // redraws its own (the ruler, a free point's cells) on every move of the pointer.
  let unwatchLocal: (() => void) | null = null;
  const watchLocal = (on: boolean) => {
    if (on && !unwatchLocal) {
      unwatchLocal = OBR.scene.local.onChange((next) => {
        localItems = next;
        const key = sightKey(next);
        if (key !== localSight) {
          localSight = key;
          later();
        }
      });
      // What changed while it wasn't followed.
      void OBR.scene.local.getItems().then((next) => {
        localItems = next;
        localSight = sightKey(next);
        later();
      }, () => {});
    } else if (!on && unwatchLocal) {
      unwatchLocal();
      unwatchLocal = null;
    }
  };
  watchLocal(options.playerView);

  /** Only the relief's heights changed since it was drawn (a brush), within this box (scene px): moved where they are (see VistazoView.reheight). */
  let heightsOnly: Region | null = null;
  /** Where a brush went since the terrain was last built whole (scene px): let go, see settles. */
  let brushed: Region | null = null;
  /** A brush let go that settles: the next build, with the scene kept (see VistazoView.settleNext). */
  let settling = false;
  /** To tell, if something looks wrong after a brush: localStorage "rising-ranges/whole" = "1", and it's always built whole. */
  const wholeAlways = (() => {
    try {
      return localStorage.getItem("rising-ranges/whole") === "1";
    } catch {
      return false;
    }
  })();
  /** The reliefs' key the scene was last built with: a change of shapes since, and it's built again whatever. */
  let builtWith = "";
  /** Shapes being dragged whole (see VistazoView.moveShapes): till they're let go. */
  let dragging = false;
  const refresh = () => {
    try {
      // A brush's dab: the heights moved where they are, nothing built again (or all of it, if that can't be).
      if (heightsOnly && scene && builtWith === `${reliefs.key}${reliefs.surfaced}`) {
        const region = heightsOnly;
        heightsOnly = null;
        if (time("vistazo.reheight", () => view.reheight(scene!, region))) {
          if (!settling) {
            return;
          }
        } else {
          reliefs.key = String(++reliefVersion);
          settling = false;
        }
      }
      // The player view's fog, worked out again only when what it depends on changed (not on every token move).
      if (options.playerView) {
        const key = JSON.stringify([fogFilled, sightKey(items), localSight, items.filter((item) => item.layer === "FOG").map((item) => [item.id, item.visible, item.position, item.rotation, item.scale, item.lastModified])]);
        if (key !== fogKey || !lastFog) {
          fogKey = key;
          lastFog = fogOver(fogFilled, items, localItems, fogColor);
          view.setFog(lastFog);
        }
      }
      // The relief follows the fog once it settles: cutting the terrain to it costs more than drawing it,
      // and the fog's own picture (live) already covers what's moving meanwhile.
      // Not while a token's being dragged (its light comes and goes in bursts, Smoke & Spectre's every
      // half second or so): once it's dropped and the fog has settled.
      if (options.playerView && lastFog && sightFogKey !== fogKey && (live.size === 0 || !sightFog)) {
        if (!sightFog) {
          sightFog = lastFog;
          sightFogKey = fogKey;
        } else {
          // Once it's settled: every change (a light moving with a dragged token) puts it off again.
          if (sightTimer) {
            clearTimeout(sightTimer);
          }
          sightTimer = setTimeout(() => {
            sightTimer = null;
            if (live.size > 0) {
              return;
            }
            sightFog = lastFog;
            sightFogKey = fogKey;
            refresh();
          }, 600);
        }
      }
      if (!options.playerView) {
        sightFog = null;
        sightFogKey = "";
      }
      const fogNow = options.playerView ? sightFog : null;
      const t0 = stamp();
      // The map being edited drawn even hidden (a map got ready before it's shown).
      const drawn = session ? items.map((item) => (item.id === session!.imageId && !item.visible ? { ...item, visible: true } : item)) : items;
      scene = buildScene(
        sceneMetadata,
        drawn,
        dpi,
        scale,
        gridType,
        scene ?? undefined,
        hexCenter,
        options.playerView,
        fogNow ? { key: sightFogKey, clear: (world) => clearOf(fogNow, world) } : null,
        reliefs
      );
      // What it was built from: its terrain worked out away from the page from it (see terrainJob).
      scene.recipe = {
        metadata: sceneMetadata,
        items: drawn,
        dpi,
        scale,
        gridType,
        hexCenter,
        playerView: options.playerView,
        fog: fogNow ? { key: sightFogKey, filled: fogNow.filled, shapes: fogNow.shapes, lit: fogNow.lit } : null,
        reliefs,
      };
      since("vistazo.buildScene", t0);
      builtWith = `${reliefs.key}${reliefs.surfaced}`;
      heightsOnly = null;
      for (const [id, at] of live) {
        scene = placed(scene, id, at.position, at.own);
      }
      if (options.playerView) {
        // As a player sees it: what's under the fog, and what the GM hides, left out.
        const fog = lastFog!.at;
        scene = { ...scene, tokens: scene.tokens.filter((t) => live.has(t.id) || (!t.hidden && !fog(t.x, t.y))), props: scene.props.filter((p) => live.has(p.id) || !fog(p.x, p.y)) };
      } else if (lastFog) {
        lastFog = null;
        fogKey = "";
        view.setFog(null);
      }
      $("terrainOff").hidden = !scene.terrainOff;
      showCloudsChoice();
      if (settling) {
        settling = false;
        view.settleNext();
      }
      time("vistazo.setScene", () => view.setScene(scene!));
      showDistances();
    } catch (error) {
      console.error("Rising Ranges: 3D Glance couldn't draw the scene", error);
    } finally {
      $("loading").hidden = true;
    }
  };
  let pending = 0;
  const later = () => {
    clearTimeout(pending);
    pending = window.setTimeout(refresh, 150);
  };
  // The reliefs kept on this device (the relief editor's), from the background page: where there's one,
  // its map image's terrain is the relief's (see relief/vistazo.ts).
  let reliefVersion = 0;
  /** The background has answered: the reliefs kept here are all known (editing can't start before, or it'd start from nothing). */
  let reliefsKnown = false;
  watchReliefs(
    (image, data) => {
      // The one being edited is the editor's: what comes back is its own save.
      if (session?.imageId === image) {
        return;
      }
      if (data) {
        reliefs.byImage.set(image, new Relief(data));
      } else {
        reliefs.byImage.delete(image);
      }
      reliefs.key = String(++reliefVersion);
      later();
    },
    () => {
      reliefsKnown = true;
      if (editAsked) {
        enterEdit();
      }
    }
  );

  // ---------- Editing the relief (the GM's, in full screen) ----------
  let session: EditSession | null = null;
  /** Opened to edit (from the panel's button): editing starts once the reliefs are known. */
  let editAsked = FULL && new URLSearchParams(location.search).has("edit");
  /**
   * The relief editor's code and look, fetched the first time they're needed (see enterEdit), not with
   * the Glance's: players never edit. Opened to edit, fetched at once, while the reliefs come in.
   */
  type EditorModule = typeof import("../relief/editor/session");
  let editor: EditorModule | null = null;
  let editorLoading: Promise<EditorModule> | null = null;
  const loadEditor = () =>
    (editorLoading ??= Promise.all([import("../relief/editor/session"), import("../relief/editor/editor.css")]).then(([module]) => (editor = module)));
  if (editAsked && isGM) {
    void loadEditor();
  }
  /** Opened to edit from the panel: done editing, back to the panel as it was (its size, where it was). */
  const backToPanel = FULL && new URLSearchParams(location.search).has("back");
  /** While editing, the scene drawn again a few times a second at most (not only once it's still). */
  let soonTimer = 0;
  const soon = (ms = 150) => {
    if (!soonTimer) {
      soonTimer = window.setTimeout(() => {
        soonTimer = 0;
        refresh();
      }, ms);
    }
  };
  /** The map images to edit, the largest (in the scene) first. */
  const mapImages = () =>
    items
      .filter(isMapImage)
      .map((item) => ({ item, size: Math.abs(item.image.width * item.image.height * item.scale.x * item.scale.y) / item.grid.dpi ** 2 }))
      // Hidden ones too (a map got ready before it's shown), after those shown.
      .sort((a, b) => Number(b.item.visible) - Number(a.item.visible) || b.size - a.size)
      .map(({ item }) => item);
  function enterEdit() {
    editAsked = false;
    if (!isGM || session || !reliefsKnown) {
      return;
    }
    // Its code not here yet: fetched, then in (the button waiting meanwhile).
    if (!editor) {
      $("reliefEdit").classList.add("waiting");
      void loadEditor()
        .then(() => enterEdit())
        .catch((error) => console.error("Rising Ranges: the relief editor couldn't load", error))
        .finally(() => $("reliefEdit").classList.remove("waiting"));
      return;
    }
    const images = mapImages();
    if (images.length === 0) {
      // Nothing to edit: said, and back where it was opened from (the panel), not left on an empty screen.
      void OBR.notification.show(t("relief.noMaps"), "WARNING");
      if (backToPanel) {
        leaveFull();
      }
      return;
    }
    $("app").classList.add("editing");
    $("reMap").hidden = false;
    // Every piece with its surface while it's edited: a brush's heights move them where they are.
    reliefs.surfaced = true;
    // Opened from a map image's menu: that one (see createReliefMenu); otherwise the largest.
    const asked = new URLSearchParams(location.search).get("image");
    session = editor.startEditing({
      t,
      images,
      reliefs: reliefs.byImage,
      root: $("reMap"),
      map: $<HTMLCanvasElement>("reMapCanvas"),
      unit: (h) => formatDistance(scale, Math.abs(h)),
      onRelief: (image, relief, lite, heights, moving, settle) => {
        reliefs.byImage.set(image, relief);
        // A brush let go, where it can be drawn so: the scene kept, built again from it (see settles).
        if (settle && !wholeAlways && !lite && scene && brushed && !dragging && builtWith === `${reliefs.key}${reliefs.surfaced}` && settles(scene, brushed)) {
          view.setLite(false, true);
          settling = true;
          brushed = null;
          soon(0);
          return;
        }
        view.setLite(lite);
        const map = items.find((item): item is Image => item.id === image && item.type === "IMAGE");
        // Shapes dragged whole: their meshes moved as they are; the first time, what's under them (where
        // they were) drawn, only there. Let go, all of it is built again.
        if (lite && moving && map && scene && (dragging || builtWith === `${reliefs.key}${reliefs.surfaced}`)) {
          const anchor = anchorOf(map);
          const moved = time("vistazo.moveShapes", () => view.moveShapes(moving.shapes, sceneMap(anchor, dpi, moving.map)));
          if (moved === "started") {
            dragging = true;
            time("vistazo.fillUnder", () => view.fillUnder(underShapes(relief, anchor, dpi, moving)));
          }
          if (moved) {
            return;
          }
        }
        dragging = false;
        if (lite && heights && map) {
          // The same pieces (their surfaces read the relief as it is): only their heights moved, there.
          const anchor = anchorOf(map);
          const corners = [
            [heights.x0, heights.y0],
            [heights.x1, heights.y0],
            [heights.x1, heights.y1],
            [heights.x0, heights.y1],
          ].map(([x, y]) => cellToScene(anchor, dpi, x, y));
          const grow = (before: Region | null): Region => ({
            x0: Math.min(before?.x0 ?? Infinity, ...corners.map((p) => p.x)),
            y0: Math.min(before?.y0 ?? Infinity, ...corners.map((p) => p.y)),
            x1: Math.max(before?.x1 ?? -Infinity, ...corners.map((p) => p.x)),
            y1: Math.max(before?.y1 ?? -Infinity, ...corners.map((p) => p.y)),
          });
          heightsOnly = grow(heightsOnly);
          brushed = grow(brushed);
          soon(50);
          return;
        }
        heightsOnly = null;
        brushed = null;
        reliefs.key = String(++reliefVersion);
        soon();
      },
      scene: () => ({ items, dpi }),
      onPick: (shapes) => view.highlight(shapes, getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#bb99ff"),
      onDone: leaveEdit,
    }, images.some((image) => image.id === asked) ? asked! : undefined);
  }
  function leaveEdit() {
    session?.stop();
    session = null;
    $("app").classList.remove("editing");
    $("reMap").hidden = true;
    reliefs.surfaced = false;
    heightsOnly = null;
    view.setLite(false);
    refresh();
    if (backToPanel) {
      leaveFull();
    } else if (vistazoAccess(settingsOf(sceneMetadata)) === "off") {
      // Hidden: opened from the map's menu only to edit, it closes once that's done.
      void OBR.modal.close(FULL_MODAL_ID);
    }
  }
  const reliefButton = $("reliefEdit");
  reliefButton.hidden = !isGM;
  reliefButton.onclick = () => {
    if (FULL) {
      enterEdit();
      return;
    }
    // From the panel: to full screen, editing there.
    handCamera();
    void OBR.modal.open({ id: FULL_MODAL_ID, url: "/vistazo.html?full&edit&back", fullScreen: true });
    void closeVistazoPanel(true);
  };
  // While editing, the keys are the editor's first. An Escape it had no use for is the Vistazo's
  // (the free point, a template), but it never leaves the full screen. The free point goes before
  // what's picked in the editor (its panel stays), not before a menu or an outline half drawn.
  document.addEventListener(
    "keydown",
    (event) => {
      if (!session) {
        return;
      }
      if (event.key === "Escape" && !(cancelMove || placing || aiming) && !session.pending() && clearPoint()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const taken = session.key(event);
      if (!taken && event.key === "Escape" && (cancelMove || placing || aiming)) {
        return;
      }
      if (taken || event.key === "Escape") {
        if (!taken) {
          clearPoint();
        }
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true
  );
  OBR.scene.items.onChange((next) => {
    items = next;
    if (landing.size > 0) {
      landed();
    }
    later();
  });
  OBR.scene.onMetadataChange((next) => {
    sceneMetadata = next;
    const now = vistazoAccess(settingsOf(next));
    if (now !== "everyone" && !isGM) {
      void (FULL ? OBR.modal.close(FULL_MODAL_ID) : closeVistazoPanel());
      return;
    }
    const nextLanguage = languageFromMetadata(next);
    if (nextLanguage !== language) {
      language = nextLanguage;
      fill();
      fitBar();
      session?.retext();
      showOptions();
      // What isn't filled in by key: the camera's readings, the templates' list, the tokens' labels.
      showCameraTexts();
      showTemplates();
      view.relabel();
    }
    later();
  });
  /** Turned isometric or dimetric while open: said so, and it starts over once the grid's seen from above again. */
  let axonometric = false;
  OBR.scene.grid.onChange(async (grid) => {
    if (axonometryOf(grid.type) > 0) {
      axonometric = true;
      message(t("vistazo.axonometric"));
      return;
    }
    if (axonometric) {
      window.location.reload();
      return;
    }
    gridType = grid.type;
    [dpi, scale] = await Promise.all([OBR.scene.grid.getDpi(), OBR.scene.grid.getScale()]);
    $("templateUnit").textContent = scale.parsed.unit;
    hexCenter = await findHexCenter().catch(() => null);
    // The free point on the new grid's cells (or a corner), as the map's Medición.
    if (freePoint) {
      placePoint(freePoint);
    }
    later();
  });
  // A token dragged with the Medición tool, moved here as it goes; the scene catches up once it's dropped.
  OBR.broadcast.onMessage(LIVE_DRAG_CHANNEL, (event) => {
    const { tokenId, position } = event.data as LiveDrag;
    if (position) {
      showTokenAt(tokenId, position);
    } else if (draggingId === tokenId || live.has(tokenId)) {
      // Dropped: its rings move to where it is (the scene has it there now, or soon).
      draggingId = null;
      live.delete(tokenId);
      showDistances();
      later();
    }
  });
  OBR.scene.onReadyChange((ready) => {
    if (!ready) {
      void (FULL ? OBR.modal.close(FULL_MODAL_ID) : closeVistazoPanel());
    }
  });

  refresh();
  // It opens from straight above and tilts up into 3D.
  // Coming from the other view (full screen or back): its camera, as it was. Otherwise it opens from
  // straight above and tilts up into 3D.
  const handed = takeCamera();
  if (handed) {
    Object.assign(camera, handed.camera);
    view.apply();
    // The GM's sync goes on across full screen and back.
    if (handed.syncing && isGM) {
      setSyncing(true);
    }
  } else {
    setTimeout(() => animateTo(POSE, 1200), 250);
  }
}

OBR.onReady(() => {
  start().catch((error) => console.error("Rising Ranges: failed to open the Vistazo 3D", error));
});
