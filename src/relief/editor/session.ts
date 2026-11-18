import type { Image, Item } from "@owlbear-rodeo/sdk";
import { anchorOf, reliefSize } from "../anchor";
import { emptyRelief, fromStored, toStored, type StoredRelief } from "../codec";
import type { Box } from "../geom";
import { Relief } from "../relief";
import { backupsOf, keepBackup } from "../backups";
import { pack } from "../sceneItems";
import { onSaved, saveRelief } from "../store";
import type { Affine, ReliefData, Shape } from "../types";
import { withZones } from "../zones";
import { importUvtt } from "./uvttImport";
import { openGenerate } from "./generateDialog";
import { openPick } from "./pickDialog";
import { fogPlans } from "../trace/fogPlan";
import { DEFAULT_SETTINGS, ReliefEditor, type Mods, type Settings, type ToolId } from "./editor";
import { icon } from "./icons";
import {
  COMBINES,
  TOOL_LIST,
  closeMenus,
  esc,
  installTips,
  liveHint,
  gesturesHtml,
  menuToggle,
  pressedAt,
  swallowNextClick,
  openMenu,
  placeUnder,
  renderOptions,
  toolButton,
  toolsMenu,
  renderProps,
  renameGroup,
  renderShapes,
  renderTools,
  runCombine,
  shortcutsHtml,
  type MenuItem,
  type ShapesList,
  type T,
} from "./panel";
import { groupPicked, nameGroups, ungroup } from "./groups";
import { copyShapes, duplicate, nameShapes, paste, prunePoints, setType, swap, togglePick } from "./shapes";
import { installSplit, type Split } from "./split";
import { MapView } from "./view2d";
import { time } from "../../timing";

// Editing a relief in the Vistazo 3D (its full screen, the GM's): the map in
// 2D beside the Vistazo's own 3D, the editor's pieces floating over the map
// as Owlbear's own (see panel.ts), for one map image at a time (the largest
// first; a list to change it). Each change is drawn by the Vistazo (lightly
// while something's being dragged, all of it when it's let go) and saved in
// the scene a moment after; the X leaves it as it was when editing began.

const SETTINGS_KEY = "rising-ranges/relief-editor/settings";
/** Set once the grid's been turned on for this device (2.1: on by default, for those who had settings kept already too). */
const GRID_ON_KEY = "rising-ranges/relief-editor/grid-on-2.1";
const FOLDS_KEY = "rising-ranges/relief-editor/folds";
/** Shapes copied (Ctrl+C), kept on this device: pasted on another image too, or the next time. */
const CLIP_KEY = "rising-ranges/relief-editor/clipboard";
/** How long after the last change the relief is saved (ms): it goes to every client, not at every stroke. */
const SAVE_AFTER = 2000;
/** The picture's size for the map view (px across): enough to trace on. */
const PICTURE_WIDTH = 2048;
/** How long a notice stays (ms). */
const NOTICE_MS = 4000;

export type EditSession = {
  /** The image being edited. */
  imageId: string;
  /** A key pressed while editing: whether the editor took it (Escape only if it had something to drop). */
  key(event: KeyboardEvent): boolean;
  /** Something open or half done that Escape drops before anything else: a menu, the shortcuts, an outline being drawn, a skin being picked. */
  pending(): boolean;
  /** The language changed: texts again. */
  retext(): void;
  /** Saved now, and the editor's pieces taken away; `switching`: another image's editor follows. */
  stop(switching?: boolean): void;
  /**
   * The terrain brush from the Vistazo's 3D view, at a cell of the map: whether it's in hand (and its
   * size), a press, a move (held or not), a let go, the pointer gone. As the 2D map's own.
   */
  brush: {
    active(): boolean;
    radius(): number;
    down(p: { x: number; y: number }, mods: Mods): void;
    move(p: { x: number; y: number }, mods: Mods, held: boolean): void;
    up(): void;
    leave(): void;
  };
};

/** Shapes being dragged whole (moved, turned, sized): which, and the map of the relief's cells from where they started. */
export type Moving = { shapes: number[]; map: Affine };

export type SessionOptions = {
  t: T;
  /** The scene's map images, the largest first. */
  images: Image[];
  /** The reliefs the Vistazo has (to start from). */
  reliefs: Map<string, Relief>;
  /** Where the editor goes: the 2D map's own box, with its canvas. */
  root: HTMLElement;
  map: HTMLCanvasElement;
  /** A height in the scene's own measure ("10 ft"). */
  unit: (h: number) => string;
  /**
   * The relief changed (`lite`: while something's in hand; `heights`: only its heights, there). Let go,
   * `settle`: what was in hand only changed heights (a brush), see vistazo/settle.ts.
   */
  onRelief: (imageId: string, relief: Relief, lite: boolean, heights?: Box | null, moving?: Moving | null, settle?: boolean, dab?: Box | null) => void;
  /** The scene's items and its dpi now (for its old terrain zones). */
  scene: () => { items: Item[]; dpi: number };
  /** Only the relief's doors changed: shown again, nothing else built. */
  onDoors?: (imageId: string, relief: Relief) => void;
  /** What's picked changed: these shapes (their indexes) are, shown in the 3D. */
  onPick?: (shapes: number[]) => void;
  /** "Done" (or the X): editing over. */
  onDone: () => void;
  /** The 3D shown or hidden beside the map (not worth drawing while it's hidden). */
  onStage?: (shown: boolean) => void;
};

function loadJson<V extends object>(key: string, fallback: V): V {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? "{}") };
  } catch {
    return { ...fallback };
  }
}

function keepJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not kept: the next time starts from the defaults.
  }
}

/**
 * The editor's settings kept on this device. Since 2.1 the grid is on by
 * default; settings are kept whole, so it's turned on once for everyone
 * (anyone can turn it off again, and it stays off).
 */
function loadSettings(): Settings {
  const settings = loadJson<Settings>(SETTINGS_KEY, DEFAULT_SETTINGS);
  try {
    if (!localStorage.getItem(GRID_ON_KEY)) {
      settings.grid = true;
      keepJson(SETTINGS_KEY, settings);
      localStorage.setItem(GRID_ON_KEY, "1");
    }
  } catch {
    // No storage: the defaults (grid on) every time.
  }
  return settings;
}

/** A video's first frame, once it has one (it isn't played on). */
function firstFrame(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onloadeddata = () => {
      video.pause();
      resolve(video);
    };
    video.onerror = () => reject(video.error ?? new Error("the video couldn't be read"));
    video.src = url;
  });
}

/** A map image's picture on a canvas (a video map's: its first frame, as the Vistazo draws it). */
async function pictureOf(url: string, video: boolean): Promise<HTMLCanvasElement | null> {
  try {
    let source: HTMLImageElement | HTMLVideoElement;
    let [w, h] = [0, 0];
    if (video) {
      source = await firstFrame(url);
      [w, h] = [source.videoWidth, source.videoHeight];
    } else {
      const img = document.createElement("img");
      img.crossOrigin = "anonymous";
      img.src = url;
      await img.decode();
      source = img;
      [w, h] = [img.naturalWidth, img.naturalHeight];
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(PICTURE_WIDTH, w);
    canvas.height = Math.round((canvas.width * h) / w);
    canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch (error) {
    console.error("Rising Ranges: the map's picture couldn't be read for the relief editor", error);
    return null;
  }
}

/** An image's name, as the list shows it. */
const imageName = (image: Image, i: number) => image.text?.plainText || image.name || `#${i + 1}`;

/** Where the bars at the bottom being minimized (touch layout) is kept. */
const BARS_KEY = "rising-ranges/relief-editor/bars";

/** Under this width (or height) of the map, the narrow layout: the tools in a menu, the panels at the bottom. */
const NARROW_W = 600;
const NARROW_H = 520;

/** How big (packed, as the scene keeps it) a relief is when the editor says it's big: it slows the scene loading for everyone. */
const SIZE_WARN = 4_000_000;

/** A size in characters (one byte each), as KB or MB. */
const sizeOf = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

/**
 * The editor on a map image. `into`: the session object to fill (another image picked: the one the Vistazo
 * holds, so its keys, pointer and redraws reach this one, not the one left).
 * `before`: the images changed earlier in this editing (another picked in the dropdown, theirs saved),
 * each as it was when editing began (null: none), for the X to put back too.
 */
export function startEditing(o: SessionOptions, imageId = o.images[0]?.id ?? "", before = new Map<string, string | null>(), into?: EditSession): EditSession {
  const { t, root } = o;
  const image = o.images.find((i) => i.id === imageId) ?? o.images[0];
  const [w, h] = reliefSize(anchorOf(image));
  // Its own copy (the Vistazo's goes on drawing the one it has until this one's handed over); as it
  // was, for the X.
  const kept = o.reliefs.get(image.id);
  const original = kept ? JSON.stringify(toStored(kept.data)) : null;
  // What editing began from, kept on this device (see backups.ts).
  if (original) {
    void keepBackup(image.id, original);
  }
  const data: ReliefData = (original && fromStored(JSON.parse(original))) || emptyRelief(w, h);
  // What's folded away, kept between times.
  const folds = loadJson(FOLDS_KEY, { body: false, look: true, shapes: false });
  const keepFolds = () => keepJson(FOLDS_KEY, folds);
  const panelFolds = {
    get body() {
      return folds.body;
    },
    set body(v: boolean) {
      folds.body = v;
      keepFolds();
    },
    get look() {
      return folds.look;
    },
    set look(v: boolean) {
      folds.look = v;
      keepFolds();
    },
  };
  const shapesFold = {
    get value() {
      return folds.shapes;
    },
    set value(v: boolean) {
      folds.shapes = v;
      keepFolds();
    },
  };

  // ---------- The pieces over the map ----------
  const pieces = document.createElement("div");
  pieces.className = "re-ui";
  pieces.innerHTML = `
    <div class="re-top glass">
      <button type="button" class="ib sm re-toolbtn" data-k="toolBtn" aria-haspopup="menu"></button>
      <div class="vsep re-toolsep"></div>
      <label class="re-image" data-k="imageBox"><select data-k="image">${o.images.map((i, k) => `<option value="${esc(i.id)}" ${i.id === image.id ? "selected" : ""}>${esc(imageName(i, k))}</option>`).join("")}</select></label>
      <div class="vsep re-imagesep"></div>
      <button type="button" class="ib sm" data-k="undo">${icon("undo")}</button>
      <button type="button" class="ib sm" data-k="redo">${icon("redo")}</button>
      <button type="button" class="ib sm on" data-k="heights" aria-pressed="true">${icon("heights")}</button>
      <button type="button" class="ib sm" data-k="grid" aria-pressed="false">${icon("magnet")}</button>
      <div class="vsep"></div>
      <div class="re-options" data-k="options"></div>
      <button type="button" class="ib sm re-help" data-k="help">?</button>
      <div class="vsep"></div>
      <button type="button" class="ib sm" data-k="more">${icon("more")}</button>
      <input type="file" data-k="file" accept=".json,application/json,.uvtt,.dd2vtt,.df2vtt" hidden />
      <button type="button" class="ib sm" data-k="exit">${icon("close")}</button>
      <button type="button" class="done" data-k="done"></button>
    </div>
    <div class="re-optbar glass" data-k="optbar" hidden><button type="button" class="ib re-barshide" data-k="barsHide">${icon("expand")}</button><div class="vsep re-barsep"></div><button type="button" class="ib sm scr" data-k="prev">${icon("expand")}</button><button type="button" class="ib sm scr next" data-k="next">${icon("expand")}</button></div>
    <div class="re-tools glass" data-k="tools"></div>
    <button type="button" class="ib re-barspill glass" data-k="barsPill">${icon("expand", 180)}</button>
    <button type="button" class="ib re-shapesbtn glass" data-k="shapesBtn" aria-expanded="false"></button>
    <div class="re-props glass" data-k="props" hidden></div>
    <div class="re-shapes glass" data-k="shapes"></div>
    <div class="re-drawer" data-k="drawer" hidden></div>
    <div class="re-pop glass" data-k="pop" hidden></div>
    <div class="re-chip" data-k="chip" aria-live="polite" hidden></div>
    <div class="re-toast" data-k="toast" role="status" hidden></div>`;
  root.append(pieces);
  /** The touch layout (one view at a time: see split.ts), as onSingle last said. */
  /** The 2D map (made below; the touch layout's switch may come first: see installSplit, so it's checked there). */
  // eslint-disable-next-line prefer-const
  let map!: MapView;
  let touchUi = false;
  /** The hand in hand (touch layout only: see setHand), and the editor's tool when it was taken. */
  let hand = false;
  let handFrom: ToolId = "edit";
  let barsMin = false;
  try {
    barsMin = localStorage.getItem(BARS_KEY) === "min";
  } catch {
    // No storage: the bars shown.
  }
  const $ = <E extends HTMLElement = HTMLElement>(k: string) => pieces.querySelector<E>(`[data-k="${k}"]`)!;
  /** The bar's own names and tooltips (again when the language changes: see retext). */
  const barTexts = () => {
    const name = (k: string, title: string, sub = "", key = "") => {
      const el = $(k);
      el.dataset.tip = title;
      for (const [field, value] of [["tipSub", sub], ["tipKey", key]] as const) {
        if (value) {
          el.dataset[field] = value;
        } else {
          delete el.dataset[field];
        }
      }
      el.setAttribute("aria-label", sub ? `${title}. ${sub}` : title);
    };
    name("toolBtn", t("relief.tools"), t("relief.toolsHint"));
    name("imageBox", t("relief.image"), t("relief.imageHint"));
    name("undo", t("relief.undoName"), "", "Ctrl+Z");
    name("redo", t("relief.redo"), "", "Ctrl+Y");
    name("heights", t("relief.heights"), t("relief.heightsHint"));
    name("grid", t("relief.grid"), t("relief.gridHint"));
    name("help", t("relief.shortcuts"), t("relief.shortcutsHint"), "?");
    name("more", t("relief.more"), t("relief.moreHint"));
    name("exit", t("relief.exit"), t("relief.exitHint"));
    name("done", t("vistazo.editDone"), t("relief.localOnly"));
    $("done").textContent = t("vistazo.editDone");
    $("prev").setAttribute("aria-label", t("relief.scrollPrev"));
    $("next").setAttribute("aria-label", t("relief.scrollNext"));
    name("barsHide", t("relief.bars.hide"));
    name("barsPill", t("relief.bars.show"));
    name("shapesBtn", t("relief.shapes"));
  };
  barTexts();
  const untip = installTips(root);
  /**
   * The tool's options as the map's width lets them, measured: as they are;
   * without names; in a bar of their own (with names if they fit there);
   * that bar without names, scrolled if even so.
   */
  const fitOptions = () => {
    // A narrow (or short) map: the tools in a menu, the image and the heights in "⋯", what's
    // picked and the shapes stacked at the bottom.
    // Touch layout (one view at a time, see split.ts): the tools and their options in bars at the
    // bottom, by the thumb, what's picked and the shapes stacked over them.
    const touch = touchUi;
    const area = pieces.getBoundingClientRect();
    const narrow = area.width > 0 && (area.width < NARROW_W || area.height < NARROW_H);
    pieces.classList.toggle("re-narrow", narrow);
    const drawer = $("drawer");
    const stacked = narrow || touch;
    drawer.hidden = !stacked;
    if (stacked && $("props").parentElement !== drawer) {
      drawer.append($("props"), $("shapes"));
    } else if (!stacked && $("props").parentElement === drawer) {
      pieces.insertBefore($("props"), drawer);
      pieces.insertBefore($("shapes"), drawer);
    }
    const el = $("options");
    const top = pieces.querySelector<HTMLElement>(".re-top")!;
    if (touch) {
      if (el.parentElement !== $("optbar")) {
        $("optbar").insertBefore(el, $("next"));
      }
      if ($("toolBtn").parentElement !== $("optbar")) {
        $("optbar").insertBefore($("toolBtn"), $("prev"));
      }
    } else {
      if (el.parentElement !== top) {
        top.insertBefore(el, $("help"));
      }
      if ($("toolBtn").parentElement !== top) {
        top.insertBefore($("toolBtn"), top.firstChild);
      }
    }
    // The top bar itself, when even its own buttons don't fit: no separators, then the "?" in "⋯",
    // then redo too (Done never cut off: the X beside it throws the changes away).
    pieces.classList.remove("re-tight", "re-tighter", "re-tightest");
    const over = () => top.scrollWidth > top.clientWidth + 1;
    if (over()) {
      pieces.classList.add("re-tight");
      if (over()) {
        pieces.classList.add("re-tighter");
        if (over()) {
          pieces.classList.add("re-tightest");
        }
      }
    }
    $("optbar").hidden = true;
    pieces.classList.remove("re-compact", "re-wrapped");
    const fits = () => el.scrollWidth <= el.clientWidth + 1;
    if (touch) {
      $("optbar").hidden = barsMin;
      if (!barsMin && el.childElementCount && !fits()) {
        pieces.classList.add("re-compact");
      }
      // What sits over the bar (the shapes' button, the drawer, the toast) starts where it (or its button, minimized) does.
      const r = (barsMin ? $("barsPill") : $("optbar")).getBoundingClientRect();
      pieces.style.setProperty("--re-bottom", `${r.height > 0 ? Math.max(8, area.bottom - r.top + 8) : 8}px`);
    } else if (el.childElementCount && !fits()) {
      pieces.classList.add("re-compact");
      if (!fits()) {
        pieces.classList.remove("re-compact");
        $("optbar").hidden = false;
        $("optbar").insertBefore(el, $("next"));
        pieces.classList.add("re-wrapped");
        if (!fits()) {
          pieces.classList.add("re-compact");
        }
      }
    }
    arrows();
    placeUnder(pieces);
  };
  /** The bar of their own's ends: a button each side while there's more of it that way. */
  const arrows = () => {
    const el = $("options");
    const more = (pieces.classList.contains("re-wrapped") || touchUi) && el.scrollWidth > el.clientWidth + 1;
    $("prev").hidden = $("next").hidden = !more;
    $<HTMLButtonElement>("prev").disabled = el.scrollLeft <= 0;
    $<HTMLButtonElement>("next").disabled = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
  };
  $("options").addEventListener("scroll", arrows, { passive: true });
  for (const [k, dir] of [["prev", -1], ["next", 1]] as const) {
    $(k).onclick = () => $("options").scrollBy({ left: dir * $("options").clientWidth * 0.6, behavior: "smooth" });
  }
  const fitter = new ResizeObserver(() => {
    fitOptions();
    // The menus were placed for the size before.
    closeMenus();
  });
  fitter.observe(pieces);
  // The shapes' list grows up to just under the tools' column (both at the left).
  const toolsEnd = new ResizeObserver(() => {
    const tools = $("tools");
    $("shapes").parentElement?.style.setProperty("--re-tools-end", `${tools.offsetHeight > 0 ? tools.offsetTop + tools.offsetHeight : 0}px`);
  });
  toolsEnd.observe($("tools"));
  toolsEnd.observe(pieces);
  // The line between the map and the 3D, dragged.
  // On a small screen (or in touch mode), one view at a time instead (see split.ts).
  const split: Split = root.parentElement
    ? installSplit(root.parentElement, t, (shown) => o.onStage?.(shown), (single) => {
        touchUi = single;
        root.classList.toggle("re-touch", single);
        if (map as MapView | undefined) {
          map.big = single;
          map.redraw();
        }
        // The hand's only the touch layout's.
        if (!single && hand) {
          setHand(false);
        }
        closeMenus();
        fitOptions();
      })
    : { stop() {}, retext() {}, single: () => false, small: () => false, touch: () => false, setTouch() {} };

  // The bars at the bottom, minimized (touch layout): only a button with the tool in hand, to get them back.
  const setBarsMin = (min: boolean) => {
    barsMin = min;
    try {
      if (min) {
        localStorage.setItem(BARS_KEY, "min");
      } else {
        localStorage.removeItem(BARS_KEY);
      }
    } catch {
      // Not kept (no storage): only this time.
    }
    pieces.classList.toggle("re-bars-min", min);
    if (min) {
      setShapesOpen(false);
    }
    closeMenus();
    fitOptions();
  };
  pieces.classList.toggle("re-bars-min", barsMin);
  $("barsPill").onclick = () => setBarsMin(false);
  $("barsHide").onclick = () => setBarsMin(true);
  // The shapes' list (touch layout): behind a button, over the map while it's open; what's picked beside it.
  const setShapesOpen = (open: boolean) => {
    pieces.classList.toggle("re-shapes-open", open);
    $("shapesBtn").setAttribute("aria-expanded", String(open));
    $("shapesBtn").classList.toggle("on", open);
    if (open && shapesFold.value) {
      shapesFold.value = false;
      list();
    }
  };
  $("shapesBtn").onclick = () => setShapesOpen(!pieces.classList.contains("re-shapes-open"));

  /** Vertices or height points picked, in the touch layout: their bin at the row's other end from its ✕ (they've no ⋯). */
  const binApart = () => {
    const head = $("props").querySelector<HTMLElement>(".head");
    const bin = head?.querySelector('[data-k="del"]');
    if (head && bin && touchUi) {
      head.prepend(bin);
    }
  };

  /** The shape's menu (what a right click opens) from a ⋯ in its panel's title: the touch layout's (a finger held picks several). */
  const shapeMoreButton = () => {
    const sel = editor.sel;
    const head = $("props").querySelector<HTMLElement>(".head");
    if (!head || (sel?.kind !== "shape" && sel?.kind !== "door") || !touchUi) {
      return;
    }
    // Its bin out of the row, beside the ✕ it was (a slip of the finger, the shape gone): Borrar's in the ⋯.
    head.querySelector('[data-k="del"]')?.remove();
    head.querySelector('[data-k="deselect"]')?.insertAdjacentHTML("beforebegin", `<button type="button" class="ib sm" data-k="shapeMore" aria-haspopup="menu" aria-label="${esc(t("relief.shapeMore"))}">${icon("more")}</button>`);
    const button = head.querySelector<HTMLElement>('[data-k="shapeMore"]');
    if (!button) {
      return;
    }
    menuToggle(button, () => {
      const r = button.getBoundingClientRect();
      const area = root.getBoundingClientRect();
      const menu =
        sel.kind === "shape"
          ? shapeMenu(sel.i, r.left, r.top)
          : openMenu(root, 0, 0, [
              {
                icon: "duplicate",
                label: t("relief.menu.duplicate"),
                key: "Ctrl+D",
                run: () => {
                  editor.key({ key: "d", code: "KeyD", ctrl: true });
                  editor.host.showProps();
                  editor.host.redraw();
                },
              },
              "-",
              { icon: "delete", label: t("relief.delete"), key: "Supr", run: () => editor.remove() },
            ]);
      // Over the panel (it's at the bottom), its right end at the button's.
      menu.style.left = `${Math.max(4, Math.min(area.width - menu.offsetWidth - 4, r.right - area.left - menu.offsetWidth))}px`;
      menu.style.top = `${Math.max(4, r.top - area.top - menu.offsetHeight - 6)}px`;
    });
  };

  /**
   * A ± beside the fields that can be below zero (heights), in the touch layout: an iPhone's number keypad
   * has no minus. It turns the sign of the field last in use there (a ramp's two: the one last touched).
   */
  const signButtons = () => {
    if (!touchUi) {
      return;
    }
    for (const row of pieces.querySelectorAll<HTMLElement>(".re-props .height, .re-options .numbox")) {
      const inputs = [...row.querySelectorAll<HTMLInputElement>("input.num")].filter((input) => Number(input.dataset.min) < 0);
      if (!inputs.length || row.querySelector(".re-sign")) {
        continue;
      }
      row.insertAdjacentHTML("beforeend", `<button type="button" class="ib sm re-sign" aria-label="${esc(t("relief.flipSign"))}">±</button>`);
      let last = inputs[0];
      for (const input of inputs) {
        input.addEventListener("focus", () => (last = input));
      }
      row.querySelector<HTMLButtonElement>(".re-sign")!.onclick = () => {
        const v = Number(last.value.replace(/,/g, "."));
        if (!last.value || !Number.isFinite(v) || v === 0) {
          return;
        }
        last.value = String(-v);
        // As typed: its step to undo armed, the value set, then shown as kept.
        for (const type of ["focus", "input", "change"]) {
          last.dispatchEvent(new Event(type));
        }
      };
    }
  };
  // Typing in a field of the panel or of the bar at the bottom (touch layout): that one up under the top bar,
  // over the keyboard coming up from below (wherever the browser leaves the page).
  pieces.addEventListener("focusin", (event) => {
    const field = event.target as HTMLElement;
    if (!touchUi || !field.matches('input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea')) {
      return;
    }
    const where = field.closest(".re-drawer") ? "re-typing-drawer" : field.closest(".re-optbar") ? "re-typing-bar" : "";
    if (where) {
      pieces.classList.add(where);
      requestAnimationFrame(() => field.scrollIntoView({ block: "nearest" }));
    }
  });
  pieces.addEventListener("focusout", () => pieces.classList.remove("re-typing-drawer", "re-typing-bar"));

  // A notice for a moment (only what went wrong, or what came of a choice).
  const toast = $("toast");
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const notice = (text: string) => {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), NOTICE_MS);
  };

  // ---------- Saving: a moment after the last change; the background's answer says whether it was kept ----------
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** The last save's id, till the background answers it (see onSaved). */
  let sent = "";
  /** Told once a session that the relief has grown big (see SIZE_WARN). */
  let toldBig = false;
  const saveNow = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    sent = saveRelief(image.id, editor.data);
    if (!toldBig) {
      const json = JSON.stringify(toStored(editor.data));
      void pack(json).then((packed) => {
        if (!toldBig && packed.length > SIZE_WARN) {
          toldBig = true;
          notice(t("relief.sizeWarn", { size: sizeOf(packed.length) }));
        }
      });
    }
  };
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_AFTER);
  };
  // Its window closing (the Vistazo closed, the scene changed) with a change still waiting: sent now, not
  // lost (the background keeps it only if its map's still in the scene: see startReliefService).
  const leaving = () => {
    if (saveTimer) {
      saveNow();
    }
  };
  window.addEventListener("pagehide", leaving);
  // Only the answer to the last save counts: an older one's (replaced while it was written) isn't told.
  const stopWatching = onSaved((id, save, ok) => {
    if (id === image.id && save === sent) {
      sent = "";
      if (!ok) {
        notice(t("relief.notSaved"));
      }
    }
  });

  // ---------- The editor ----------
  let frame = 0;
  const focusName = () => {
    const name = pieces.querySelector<HTMLInputElement>('[data-k="props"] [data-k="name"]');
    name?.focus();
    name?.select();
  };
  let toldPicked = "";
  /** The shapes picked, told the Vistazo (once each time they change). */
  const tellPicked = () => {
    const sel = editor.sel;
    const shapes = sel?.kind === "shape" ? [sel.i, ...(sel.more ?? [])] : [];
    const key = shapes.join(",");
    if (key !== toldPicked) {
      toldPicked = key;
      if (shapes.length && touchUi) {
        setShapesOpen(false);
      }
      o.onPick?.(shapes);
    }
  };
  const history = () => {
    $<HTMLButtonElement>("undo").disabled = !editor.canUndo;
    $<HTMLButtonElement>("redo").disabled = !editor.canRedo;
  };
  /** Everything of the panel, at the next frame. */
  const panel = () => {
    if (frame) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = 0;
      time("editor.panel.tools", () => renderTools($("tools"), editor, t, setTool, (button, items) => {
        const r = button.getBoundingClientRect();
        const [x, y] = rootPoint(r.right + 6, r.top);
        openMenu(root, x, y, items);
      }));
      // The tool changed by something else than the menu (the Ground row, a pick in the list): the hand let go.
      if (hand && editor.tool !== handFrom) {
        hand = false;
        map.hand = false;
        o.map.style.cursor = "";
      }
      time("editor.panel.options", () => renderOptions($("options"), editor, t));
      // The hand has no options.
      if (hand) {
        $("options").innerHTML = "";
      }
      // A chevron: it opens a menu (down from the top bar, up from the touch layout's bottom one: see the CSS).
      const tool = hand ? `${icon("hand")}<span class="sr">${esc(t("relief.hand"))}</span>` : toolButton(editor, t);
      $("toolBtn").innerHTML = `${tool}<span class="tchev">${icon("expand")}</span>`;
      $("shapesBtn").innerHTML = `${icon("layers")}<span class="count">${editor.data.shapes.length}</span>`;
      time("editor.panel.fit", fitOptions);
      // Picking several ends with nothing picked, or out of the touch layout.
      if (editor.multi && (editor.sel?.kind !== "shape" || !touchUi)) {
        editor.multi = false;
      }
      // Taking a texture (or a door's picture) from the map: the map clear for it (the touch layout's panel and list hidden: see the CSS).
      pieces.classList.toggle("re-picking", editor.skinPick !== null || editor.doorPick !== null);
      time("editor.panel.props", () => renderProps($("props"), editor, t, o.unit, panelFolds));
      shapeMoreButton();
      binApart();
      signButtons();
      time("editor.panel.shapes", () => renderShapes($("shapes"), editor, t, listUi()));
      history();
      tellPicked();
      if (!$("pop").hidden) {
        $("pop").innerHTML = touchUi ? gesturesHtml(t) : shortcutsHtml(editor, t);
      }
    });
  };
  let listFrame = 0;
  /** The list and the history buttons (what changes as something's dragged). */
  const list = () => {
    if (listFrame) {
      return;
    }
    listFrame = requestAnimationFrame(() => {
      listFrame = 0;
      renderShapes($("shapes"), editor, t, listUi());
      history();
    });
  };
  const busy = () => !!(editor.xf || editor.drag || editor.brushing || editor.arrowEnd || editor.doorGrab);
  /** The shapes named for good (see nameShapes): those of this relief (opened, or undone to) already seen. */
  let named: { relief: Relief; seen: WeakSet<Shape> } | null = null;
  const name = () => {
    const fresh = named?.relief !== editor.relief;
    const seen = fresh ? new WeakSet<Shape>() : named!.seen;
    named = { relief: editor.relief, seen };
    nameShapes(editor.data.shapes, (n) => t("relief.shape.name", { n }), fresh ? null : seen);
    nameGroups(editor.data, (n) => t("relief.group.name", { n }));
    if (fresh) {
      editor.data.shapes.forEach((s) => seen.add(s));
    }
  };
  /** What the pointer pressed has changed, till it's let go: nothing, only heights (a brush), more. */
  let gesture: "none" | "heights" | "more" = "none";
  const editor: ReliefEditor = new ReliefEditor(
    data,
    {
      changed: () => {
        name();
        map.redraw();
        list();
        save();
        const sel = editor.sel;
        // A whole shape (or those picked) dragged: moved as it is, nothing worked out again till it's let go.
        const moving = editor.xf && editor.xfMap && sel?.kind === "shape" ? { shapes: [sel.i, ...(sel.more ?? [])], map: editor.xfMap } : null;
        gesture = editor.heightsOnly && gesture !== "more" ? "heights" : "more";
        o.onRelief(image.id, editor.relief, busy() || editor.heightsOnly, editor.heightsOnly ? editor.takeDirty() : null, moving, false, editor.heightsOnly ? editor.takeDab() : null);
      },
      showProps: () => {
        panel();
        map.redraw();
      },
      redraw: () => map.redraw(),
      setCursor: (cursor) => (o.map.style.cursor = cursor),
      // Some pixels on screen; more for a finger (the touch layout).
      snapReach: () => (touchUi ? 20 : 10) / map.scale,
      // A vertex or a height point picked from further for a finger (a 64 px target), and a tap on one
      // only picks it: it moves once the finger has gone 8 px.
      pickReach: () => (touchUi ? 32 : 10) / map.scale,
      dragSlop: () => (touchUi ? 8 : 0) / map.scale,
      toScreen: (x, y) => map.toScreen(x, y),
      saveSettings: () => keepJson(SETTINGS_KEY, editor.settings),
      doorsChanged: (terrain) => {
        map.redraw();
        save();
        if (terrain) {
          // Where they cut through their walls (see doorCut.ts): built again, as any change.
          o.onRelief(image.id, editor.relief, busy());
        } else {
          o.onDoors?.(image.id, editor.relief);
        }
      },
      fogDoors: () => {
        const { items, dpi } = o.scene();
        return fogPlans(items, image, dpi, editor.data.w, editor.data.h).flatMap((plan) => plan.doors);
      },
    },
    loadSettings()
  );
  // Height points no shape takes (left by an earlier version, a shape removed then): let go, so a shape
  // drawn there doesn't take them up (see prunePoints). Kept with its next save.
  prunePoints(editor);
  const texts = () => ({ rampNoArrow: t("relief.label.rampNoArrow"), inclined: t("relief.label.inclined"), relative: t("relief.label.relative") });
  map = new MapView(o.map, editor, texts());
  map.big = touchUi;
  // What the keys do in what's being done, on the map while it's being done.
  const chip = $("chip");
  const drawMap = map.redraw.bind(map);
  map.redraw = () => {
    drawMap();
    // Picking several (a finger's): how it goes; and, a finger's, no keys.
    const touch = touchUi;
    const text = editor.multi ? t("relief.multiHint") : liveHint(editor, t, o.unit, !touch);
    if (chip.textContent !== text) {
      chip.textContent = text;
    }
    chip.hidden = !text;
  };
  // Its shapes named for good from the start (saved with the first change).
  name();
  // Picking (Elegir) to start with.
  editor.setTool("edit");
  // Let go: the Vistazo draws all of it again (only what follows the heights, after a brush; nothing, if
  // nothing changed: a click to pick).
  map.onDown = () => (gesture = "none");
  map.onUp = () => {
    const was = gesture;
    gesture = "none";
    // The chip of what the keys do: the brush is let go (nothing else draws the map again till the pointer moves).
    map.redraw();
    if (was !== "none") {
      o.onRelief(image.id, editor.relief, false, null, null, was === "heights");
    }
    // A finger's: the bar again (a pen's outline's buttons, as its points come).
    if (touchUi) {
      panel();
    }
  };
  void pictureOf(image.image.url, image.image.mime.startsWith("video")).then((picture) => {
    map.picture = picture;
    map.fit();
  });
  const setTool = (id: ToolId) => {
    if (hand) {
      setHand(false);
    }
    editor.setTool(id);
    closeMenus();
  };
  /** The hand (touch layout): one finger moves the map, nothing edited; the tool in hand before, back with another pick. */
  const setHand = (on: boolean) => {
    hand = on;
    handFrom = editor.tool;
    map.hand = on;
    o.map.style.cursor = on ? "grab" : "";
    closeMenus();
    panel();
  };

  // ---------- Menus ----------
  const rootPoint = (clientX: number, clientY: number): [number, number] => {
    const r = root.getBoundingClientRect();
    return [clientX - r.left, clientY - r.top];
  };
  /**
   * The groups opened in the shapes' list (this time the editor's open): the
   * others are folded, as they start. A group made while editing (Ctrl+G, a
   * paste) starts open, to see what went in it.
   */
  const groupsOpen = new Set<string>();
  const groupIds = () => new Set((editor.data.groups ?? []).map((g) => g.id));
  let groupsSeen = groupIds();
  const listUi = (): ShapesList => {
    const now = groupIds();
    for (const id of now) {
      if (!groupsSeen.has(id)) {
        groupsOpen.add(id);
      }
    }
    groupsSeen = now;
    return {
      folded: shapesFold,
      groupsOpen,
      // A row held (a finger's, the touch layout): picking several, as on the map.
      onMenu: (i: number, x: number, y: number) => (touchUi ? pickSeveral(i) : shapeMenu(i, x, y)),
      onGroupMenu: groupMenu,
      focusName,
    };
  };
  const redoAll = () => {
    editor.changed();
    editor.host.showProps();
  };
  /** A group's menu (its shapes picked): rename it, undo it. */
  function groupMenu(id: string, clientX: number, clientY: number) {
    const items: MenuItem[] = [
      {
        icon: "rename",
        label: t("relief.menu.rename"),
        run: () =>
          setTimeout(() => {
            const row = [...$("shapes").querySelectorAll<HTMLElement>(".item[data-g]")].find((r) => r.dataset.g === id);
            if (row) {
              renameGroup(row, editor, id);
            }
          }, 0),
      },
      {
        icon: "ungroup",
        label: t("relief.menu.ungroup"),
        key: "Ctrl+Shift+G",
        run: () => {
          ungroup(editor, id);
          redoAll();
        },
      },
    ];
    const [x, y] = rootPoint(clientX, clientY);
    openMenu(root, x + 2, y + 2, items);
  }
  /** A shape's menu (what's picked, with it). */
  /** Picking several (the touch layout): started on a shape held (it picked, alone or among those already), then a tap adds or takes one. */
  function pickSeveral(i: number) {
    if (editor.tool !== "edit") {
      setTool("edit");
    }
    const sel = editor.sel;
    if (!editor.multi) {
      editor.multi = true;
      if (!(sel?.kind === "shape" && (sel.i === i || sel.more?.includes(i)))) {
        editor.sel = { kind: "shape", i };
      }
    } else {
      togglePick(editor, i);
    }
    editor.host.showProps();
    editor.host.redraw();
  }

  function shapeMenu(i: number, clientX: number, clientY: number): HTMLElement {
    const shapes = editor.data.shapes;
    const many = editor.sel?.kind === "shape" && (editor.sel.more?.length ?? 0) > 0;
    const redo = redoAll;
    const group = shapes[i]?.group;
    const items: MenuItem[] = [
      {
        icon: "duplicate",
        label: t("relief.menu.duplicate"),
        key: "Ctrl+D",
        run: () => {
          duplicate(editor);
          redo();
        },
      },
      { icon: "duplicate", label: t("relief.menu.copy"), key: "Ctrl+C", run: copy },
      { icon: "rename", label: t("relief.menu.rename"), key: "F2", run: () => setTimeout(focusName, 0) },
      "-",
      {
        icon: "group",
        label: t("relief.menu.group"),
        key: "Ctrl+G",
        run: () => {
          if (groupPicked(editor)) {
            redo();
          }
        },
      },
      ...(group
        ? [
            {
              icon: "ungroup" as const,
              label: t("relief.menu.ungroup"),
              key: "Ctrl+Shift+G",
              run: () => {
                ungroup(editor, group);
                redo();
              },
            },
          ]
        : []),
      "-",
      {
        icon: "layer-up",
        label: t("relief.layerUp"),
        key: "]",
        disabled: i >= shapes.length - 1,
        run: () => {
          swap(editor, i, i + 1);
          redo();
        },
      },
      {
        icon: "layer-down",
        label: t("relief.layerDown"),
        key: "[",
        disabled: i <= 0,
        run: () => {
          swap(editor, i, i - 1);
          redo();
        },
      },
      "-",
      {
        icon: "convert",
        label: t("relief.menu.convert"),
        items: (
          [
            ["terrain", "terrain", "relief.shape.terrain"],
            ["slab", "slab", "relief.shape.slab"],
            ["stand", "stand", "relief.shape.stand"],
          ] as const
        ).map(([type, ic, label]) => ({
          icon: ic,
          label: t(label),
          run: () => {
            editor.pushUndo();
            setType(editor, i, type);
            redo();
          },
        })),
      },
      ...(many ? [{ icon: "combine" as const, label: t("relief.menu.combine"), items: COMBINES.map(([id, label]) => ({ label: t(label), run: () => runCombine(editor, id) })) }] : []),
      {
        icon: "texture",
        label: t("relief.menu.texture"),
        disabled: !!shapes[i]?.stand,
        run: () => {
          editor.sel = { kind: "shape", i };
          editor.skinPick = i;
          editor.host.showProps();
        },
      },
      "-",
      { icon: "delete", label: t("relief.delete"), key: "Supr", run: () => editor.remove() },
    ];
    const [x, y] = rootPoint(clientX, clientY);
    return openMenu(root, x + 2, y + 2, items);
  }
  // A right click on the map: on a shape, its menu (picked first, unless it's among what's picked).
  map.onMenu = (sx, sy, at, touch) => {
    const i = editor.shapeAt(at.x, at.y);
    // A finger held on a shape (the touch layout): picking several, as photos in a phone's gallery (its menu's
    // the ⋯ in the panel).
    if (touch && touchUi) {
      if (i >= 0) {
        swallowNextClick();
        pickSeveral(i);
      }
      return;
    }
    if (i < 0) {
      closeMenus();
      return;
    }
    const sel = editor.sel;
    if (!(sel?.kind === "shape" && (sel.i === i || sel.more?.includes(i)))) {
      editor.sel = { kind: "shape", i };
      editor.host.showProps();
    }
    const r = o.map.getBoundingClientRect();
    shapeMenu(i, r.left + sx, r.top + sy);
  };
  // A click anywhere else closes a menu (on the button that opened it, that button's click does: see menuToggle).
  const outside = (event: PointerEvent) => pressedAt(event.target as HTMLElement);
  document.addEventListener("pointerdown", outside, true);

  // ---------- The top bar ----------
  $("undo").onclick = () => editor.undo();
  $("help").onclick = () => toggleHelp();
  $("redo").onclick = () => editor.redo();
  // The magnet: points to the half-cell grid (kept for the next time).
  const showGrid = () => {
    $("grid").classList.toggle("on", editor.settings.grid);
    $("grid").setAttribute("aria-pressed", String(editor.settings.grid));
  };
  showGrid();
  $("grid").onclick = () => {
    editor.settings.grid = !editor.settings.grid;
    editor.host.saveSettings();
    showGrid();
  };
  $("heights").onclick = () => {
    map.showHeights = !map.showHeights;
    $("heights").classList.toggle("on", map.showHeights);
    $("heights").setAttribute("aria-pressed", String(map.showHeights));
    map.redraw();
  };
  const file = $<HTMLInputElement>("file");
  file.onchange = async () => {
    const chosen = file.files?.[0];
    file.value = "";
    if (!chosen) {
      return;
    }
    let json: unknown = null;
    try {
      json = JSON.parse(await chosen.text());
    } catch {
      json = null;
    }
    // A Universal VTT plan (.uvtt, .dd2vtt): its walls added to this relief.
    if (json && typeof json === "object" && "line_of_sight" in json) {
      notice(t("relief.uvttReading"));
      const done = await importUvtt(json, editor.data, t).catch(() => null);
      if (!done) {
        notice(t("relief.importBad"));
      } else if (done.empty) {
        notice(t("relief.uvttNone"));
      } else {
        editor.replace(done.data);
        notice(done.notes.join(" "));
      }
      return;
    }
    const read = json ? fromStored(json) : null;
    if (!read) {
      notice(t("relief.importBad"));
      return;
    }
    editor.replace(read);
  };
  menuToggle($("toolBtn"), () => {
    const r = $("toolBtn").getBoundingClientRect();
    if (touchUi) {
      const [x, y] = rootPoint(r.left, r.top);
      const menu = openMenu(root, x, y, toolsMenu(editor, t, setTool, { on: hand, take: () => setHand(true) }));
      menu.style.top = `${Math.max(4, y - menu.offsetHeight - 6)}px`;
      return;
    }
    const [x, y] = rootPoint(r.left, r.bottom + 4);
    openMenu(root, x, y, toolsMenu(editor, t, setTool));
  });
  menuToggle($("more"), async () => {
    const r = $("more").getBoundingClientRect();
    const [x, y] = rootPoint(r.right, r.bottom + 4);
    let sure = false;
    // How big it is as the scene keeps it, and the versions kept here.
    const [packed, backups] = await Promise.all([pack(JSON.stringify(toStored(editor.data))).catch(() => ""), backupsOf(image.id)]);
    // Picked in a window of their own (pickDialog.ts), the newest first; going back to one is a step to undo.
    const versions = () =>
      openPick({
        root,
        t,
        title: t("relief.versions"),
        rows: backups.map((backup) => ({
          label: new Date(backup.at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }),
          run: () => {
            const read = fromStored(JSON.parse(backup.json));
            if (read) {
              editor.replace(read);
              notice(t("relief.versionBack"));
            }
          },
        })),
        empty: t("relief.versionsNone"),
        foot: t("relief.versionsUndo"),
      });
    // On a narrow map, what the top bar has no room for.
    const narrow = (): MenuItem[] =>
      pieces.classList.contains("re-narrow")
        ? [
            {
              icon: "image",
              label: t("relief.imageMenu"),
              run: () =>
                openPick({
                  root,
                  t,
                  title: t("relief.image"),
                  rows: o.images.map((i, k) => ({
                    label: imageName(i, k),
                    on: i.id === image.id,
                    run: () => {
                      if (i.id !== image.id) {
                        const select = $<HTMLSelectElement>("image");
                        select.value = i.id;
                        select.dispatchEvent(new Event("change"));
                      }
                    },
                  })),
                }),
            },
            { icon: "heights", label: t("relief.heights"), on: map.showHeights, run: () => $("heights").click() },
            { icon: "magnet", label: t("relief.grid"), on: editor.settings.grid, run: () => $("grid").click() },
            ...(pieces.classList.contains("re-tighter") ? [{ label: t(touchUi ? "relief.gestures" : "relief.shortcuts"), key: "?", run: toggleHelp }] : []),
            ...(pieces.classList.contains("re-tightest") ? [{ icon: "redo" as const, label: t("relief.redo"), key: "Ctrl+Y", run: () => editor.redo() }] : []),
            "-",
          ]
        : [];
    let copied = false;
    try {
      copied = !!localStorage.getItem(CLIP_KEY);
    } catch {
      // No storage: nothing kept to paste.
    }
    const items = (): MenuItem[] => [
      ...narrow(),
      // What was copied (the shape's menu), here (the key's Ctrl+V).
      { icon: "duplicate", label: t("relief.menu.paste"), key: "Ctrl+V", disabled: !copied, run: () => void pasteCopied() },
      "-",
      {
        label: t("relief.export"),
        run: () => {
          const blob = new Blob([JSON.stringify(toStored(editor.data))], { type: "application/json" });
          const link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          link.download = `${imageName(image, 0).replace(/[^\w.-]+/g, "_")}.relief.json`;
          link.click();
          URL.revokeObjectURL(link.href);
        },
      },
      { icon: "terrain", label: t("relief.gen.menu"), run: () => openGenerate({ root, t, editor, image, scene: o.scene, notice }) },
      "-",
      { label: t("relief.import"), run: () => file.click() },
      { icon: "history", label: t("relief.versionsMenu"), run: versions },
      // One view at a time, for a tablet with no mouse or keyboard (on a small screen it's so anyway).
      {
        label: t("relief.touchMode"),
        on: split.single(),
        disabled: split.small(),
        run: () => split.setTouch(!split.touch()),
      },
      {
        icon: "terrain",
        label: t("relief.zones"),
        run: () => {
          const { items: sceneItems, dpi } = o.scene();
          // Its own copy to add to (what's undone keeps the one before).
          const own = fromStored(JSON.parse(JSON.stringify(toStored(editor.data))))!;
          const { data: next, count } = withZones(sceneItems, image, dpi, own);
          if (count === 0) {
            notice(t("relief.zonesNone"));
            return;
          }
          editor.replace(next);
          notice(t("relief.zonesDone", { count }));
        },
      },
      "-",
      {
        icon: "delete",
        label: t("relief.clear"),
        run: () => {
          if (!sure) {
            sure = true;
            // The same menu, the item asking again.
            const again = items();
            const at = again.findIndex((item) => item !== "-" && item.label === t("relief.clear"));
            again[at] = { icon: "delete", label: t("relief.clearSure"), run: () => editor.replace(emptyRelief(editor.data.w, editor.data.h)) };
            setTimeout(() => openMenu(root, x - 220, y, again), 0);
          }
        },
      },
      "-",
      { label: t("relief.sceneSize", { size: packed ? sizeOf(packed.length) : "?" }), info: true },
    ];
    openMenu(root, x - 220, y, items());
  });
  // Done: this version kept on this device too (see backups.ts).
  $("done").onclick = () => {
    void keepBackup(image.id, JSON.stringify(toStored(editor.data)));
    o.onDone();
  };
  // The X: every relief changed in this editing back as it was when editing began (this image's and
  // those before it, see `before`), and editing over. With changes made, a second click to be sure
  // (within a moment).
  const changedHere = () => JSON.stringify(toStored(editor.data)) !== (original ?? JSON.stringify(toStored(emptyRelief(w, h))));
  let exitArmed: ReturnType<typeof setTimeout> | undefined;
  $("exit").onclick = () => {
    const changed = changedHere() || before.size > 0;
    if (changed && !exitArmed) {
      $("exit").classList.add("armed");
      notice(t("relief.exitSure"));
      exitArmed = setTimeout(() => {
        exitArmed = undefined;
        $("exit").classList.remove("armed");
      }, NOTICE_MS);
      return;
    }
    clearTimeout(exitArmed);
    clearTimeout(saveTimer);
    saveTimer = undefined;
    const firsts = new Map(before);
    if (!firsts.has(image.id)) {
      firsts.set(image.id, original);
    }
    for (const [id, first] of firsts) {
      const back = first ? fromStored(JSON.parse(first)) : null;
      saveRelief(id, back);
      if (back) {
        o.onRelief(id, new Relief(back), false);
      }
    }
    o.onDone();
  };
  // Another image: this one saved, and the editor started again on that one.
  let session: EditSession;
  $<HTMLSelectElement>("image").onchange = (event) => {
    const next = (event.target as HTMLSelectElement).value;
    // As it was when editing began, for the X (the first time it's left changed only: later, it's no longer that).
    if (changedHere() && !before.has(image.id)) {
      before.set(image.id, original);
    }
    session.stop(true);
    startEditing(o, next, before, session);
    // The choice's list went with the editor it was in: the keys to the new one's map (else they'd go
    // nowhere it hears, to the browser).
    o.map.focus({ preventScroll: true });
  };

  // Copy and paste: the picked shapes kept on this device (see copyShapes), added where they were.
  function copy() {
    const copied = copyShapes(editor);
    if (copied) {
      keepJson(CLIP_KEY, copied);
      notice(t(copied.shapes.length > 1 ? "relief.copied" : "relief.copiedOne"));
    }
  }
  function pasteCopied(): boolean {
    let stored: StoredRelief | null = null;
    try {
      stored = JSON.parse(localStorage.getItem(CLIP_KEY) ?? "null") as StoredRelief | null;
    } catch {
      return false;
    }
    if (!stored || !paste(editor, stored)) {
      return false;
    }
    editor.changed();
    editor.host.showProps();
    editor.host.redraw();
    return true;
  }

  // The keys, all of them (the "?").
  function toggleHelp() {
    const pop = $("pop");
    pop.hidden = !pop.hidden;
    pop.innerHTML = pop.hidden ? "" : touchUi ? gesturesHtml(t) : shortcutsHtml(editor, t);
    $("help").classList.toggle("on", !pop.hidden);
  }

  panel();
  o.onRelief(image.id, editor.relief, false);

  session = Object.assign(into ?? ({} as EditSession), {
    imageId: image.id,
    brush: {
      active: () => editor.isBrush(),
      radius: () => editor.settings.radius,
      down(p, mods) {
        map.onDown();
        editor.down(p, mods);
      },
      move: (p, mods, held) => editor.move(p, mods, held),
      up() {
        editor.up();
        map.onUp();
      },
      leave() {
        editor.cursor = null;
        editor.hover = -1;
        map.redraw();
      },
    },
    pending() {
      return !!document.querySelector(".re-menu") || !$("pop").hidden || editor.drawing !== null || editor.skinPick !== null || editor.doorPick !== null;
    },
    key(event) {
      const target = event.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
        return false;
      }
      const ctrl = event.ctrlKey || event.metaKey;
      if (event.key === "Escape" && (document.querySelector(".re-menu") || !$("pop").hidden)) {
        closeMenus();
        $("pop").hidden = true;
        return true;
      }
      if (ctrl && (event.code === "KeyY" || (event.code === "KeyZ" && event.shiftKey))) {
        editor.redo();
        return true;
      }
      if (ctrl && event.code === "KeyZ") {
        editor.undo();
        return true;
      }
      if (ctrl && event.code === "KeyC" && !event.shiftKey && editor.sel?.kind === "shape") {
        copy();
        return true;
      }
      if (ctrl && event.code === "KeyV" && pasteCopied()) {
        return true;
      }
      const sel = editor.sel;
      if (event.key === "F2" && sel?.kind === "shape") {
        focusName();
        return true;
      }
      if ((event.key === "]" || event.key === "[") && editor.isBrush()) {
        const s = editor.settings;
        s.radius = Math.min(6, Math.max(0.25, Math.round((s.radius + (event.key === "]" ? 0.25 : -0.25)) * 4) / 4));
        editor.host.saveSettings();
        editor.host.showProps();
        editor.host.redraw();
        return true;
      }
      if ((event.key === "]" || event.key === "[") && sel?.kind === "shape" && !sel.more?.length) {
        swap(editor, sel.i, sel.i + (event.key === "]" ? 1 : -1));
        editor.changed();
        editor.host.showProps();
        return true;
      }
      if (editor.key({ key: event.key, code: event.code, ctrl, shift: event.shiftKey, alt: event.altKey })) {
        return true;
      }
      if (!ctrl && !event.altKey && event.key.length === 1) {
        if (event.key === "?") {
          toggleHelp();
          return true;
        }
        const tool = TOOL_LIST.find((x) => x.key === event.key.toLowerCase());
        // Elegir's key again: shapes ↔ vertices.
        if (tool?.id === "edit" && editor.tool === "edit") {
          editor.settings.pickMode = editor.settings.pickMode === "points" ? "shapes" : "points";
          editor.host.saveSettings();
          editor.host.showProps();
          editor.host.redraw();
          return true;
        }
        if (tool) {
          setTool(tool.id);
          return true;
        }
      }
      return false;
    },
    retext() {
      barTexts();
      split.retext();
      map.texts = texts();
      panel();
      map.redraw();
    },
    stop(switching = false) {
      if (saveTimer) {
        saveNow();
      }
      stopWatching();
      closeMenus();
      untip();
      split.stop(switching);
      fitter.disconnect();
      toolsEnd.disconnect();
      o.onPick?.([]);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("pagehide", leaving);
      clearTimeout(toastTimer);
      clearTimeout(exitArmed);
      // What was to be drawn of it at the next frame (its panel, its list): not, it's gone.
      cancelAnimationFrame(frame);
      cancelAnimationFrame(listFrame);
      map.dispose();
      pieces.remove();
    },
  } satisfies EditSession);
  return session;
}
