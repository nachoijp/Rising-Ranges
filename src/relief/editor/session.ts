import type { Image, Item } from "@owlbear-rodeo/sdk";
import { anchorOf, reliefSize } from "../anchor";
import { emptyRelief, fromStored, toStored } from "../codec";
import type { Box } from "../geom";
import { Relief } from "../relief";
import { backupsOf, keepBackup } from "../backups";
import { pack } from "../sceneItems";
import { onSaved, saveRelief } from "../store";
import type { Affine, ReliefData, Shape } from "../types";
import { withZones } from "../zones";
import { DEFAULT_SETTINGS, ReliefEditor, type Mods, type Settings, type ToolId } from "./editor";
import { icon } from "./icons";
import {
  COMBINES,
  TOOL_LIST,
  closeMenus,
  esc,
  installTips,
  liveHint,
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
import { duplicate, nameShapes, setType, swap } from "./shapes";
import { installSplit } from "./split";
import { MapView } from "./view2d";
import { time } from "../../timing";

// Editing a relief in the Vistazo 3D (its full screen, the GM's): the map in
// 2D beside the Vistazo's own 3D, the editor's pieces floating over the map
// as Owlbear's own (see panel.ts), for one map image at a time (the largest
// first; a list to change it). Each change is drawn by the Vistazo (lightly
// while something's being dragged, all of it when it's let go) and saved in
// the scene a moment after; the X leaves it as it was when editing began.

const SETTINGS_KEY = "rising-ranges/relief-editor/settings";
const FOLDS_KEY = "rising-ranges/relief-editor/folds";
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
  /** The language changed: texts again. */
  retext(): void;
  /** Saved now, and the editor's pieces taken away. */
  stop(): void;
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
  onRelief: (imageId: string, relief: Relief, lite: boolean, heights?: Box | null, moving?: Moving | null, settle?: boolean) => void;
  /** The scene's items and its dpi now (for its old terrain zones). */
  scene: () => { items: Item[]; dpi: number };
  /** What's picked changed: these shapes (their indexes) are, shown in the 3D. */
  onPick?: (shapes: number[]) => void;
  /** "Done" (or the X): editing over. */
  onDone: () => void;
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

/** Under this width (or height) of the map, the narrow layout: the tools in a menu, the panels at the bottom. */
const NARROW_W = 600;
const NARROW_H = 520;

/** How big (packed, as the scene keeps it) a relief is when the editor says it's big: it slows the scene loading for everyone. */
const SIZE_WARN = 4_000_000;

/** A size in characters (one byte each), as KB or MB. */
const sizeOf = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

/**
 * `before`: the images changed earlier in this editing (another picked in the dropdown, theirs saved),
 * each as it was when editing began (null: none), for the X to put back too.
 */
export function startEditing(o: SessionOptions, imageId = o.images[0]?.id ?? "", before = new Map<string, string | null>()): EditSession {
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
      <input type="file" data-k="file" accept=".json,application/json" hidden />
      <button type="button" class="ib sm" data-k="exit">${icon("close")}</button>
      <button type="button" class="done" data-k="done"></button>
    </div>
    <div class="re-optbar glass" data-k="optbar" hidden><button type="button" class="ib sm scr" data-k="prev">${icon("expand")}</button><button type="button" class="ib sm scr next" data-k="next">${icon("expand")}</button></div>
    <div class="re-tools glass" data-k="tools"></div>
    <div class="re-props glass" data-k="props" hidden></div>
    <div class="re-shapes glass" data-k="shapes"></div>
    <div class="re-drawer" data-k="drawer" hidden></div>
    <div class="re-pop glass" data-k="pop" hidden></div>
    <div class="re-chip" data-k="chip" aria-live="polite" hidden></div>
    <div class="re-toast" data-k="toast" role="status" hidden></div>`;
  root.append(pieces);
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
    const area = pieces.getBoundingClientRect();
    const narrow = area.width > 0 && (area.width < NARROW_W || area.height < NARROW_H);
    pieces.classList.toggle("re-narrow", narrow);
    const drawer = $("drawer");
    drawer.hidden = !narrow;
    if (narrow && $("props").parentElement !== drawer) {
      drawer.append($("props"), $("shapes"));
    } else if (!narrow && $("props").parentElement === drawer) {
      pieces.insertBefore($("props"), drawer);
      pieces.insertBefore($("shapes"), drawer);
    }
    const el = $("options");
    const top = pieces.querySelector<HTMLElement>(".re-top")!;
    if (el.parentElement !== top) {
      top.insertBefore(el, $("help"));
    }
    // The top bar itself, when even its own buttons don't fit: no separators, then the "?" in "⋯".
    pieces.classList.remove("re-tight", "re-tighter");
    const over = () => top.scrollWidth > top.clientWidth + 1;
    if (over()) {
      pieces.classList.add("re-tight");
      if (over()) {
        pieces.classList.add("re-tighter");
      }
    }
    $("optbar").hidden = true;
    pieces.classList.remove("re-compact", "re-wrapped");
    const fits = () => el.scrollWidth <= el.clientWidth + 1;
    if (el.childElementCount && !fits()) {
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
    const more = pieces.classList.contains("re-wrapped") && el.scrollWidth > el.clientWidth + 1;
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
  const split = root.parentElement ? installSplit(root.parentElement, t) : { stop() {}, retext() {} };

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
      time("editor.panel.options", () => renderOptions($("options"), editor, t));
      $("toolBtn").innerHTML = toolButton(editor, t);
      time("editor.panel.fit", fitOptions);
      time("editor.panel.props", () => renderProps($("props"), editor, t, o.unit, panelFolds));
      time("editor.panel.shapes", () => renderShapes($("shapes"), editor, t, listUi()));
      history();
      tellPicked();
      if (!$("pop").hidden) {
        $("pop").innerHTML = shortcutsHtml(editor, t);
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
  const busy = () => !!(editor.xf || editor.drag || editor.brushing || editor.arrowEnd);
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
  // eslint-disable-next-line prefer-const
  let map: MapView;
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
        o.onRelief(image.id, editor.relief, busy() || editor.heightsOnly, editor.heightsOnly ? editor.takeDirty() : null, moving);
      },
      showProps: () => {
        panel();
        map.redraw();
      },
      redraw: () => map.redraw(),
      setCursor: (cursor) => (o.map.style.cursor = cursor),
      snapReach: () => 10 / map.scale,
      toScreen: (x, y) => map.toScreen(x, y),
      saveSettings: () => keepJson(SETTINGS_KEY, editor.settings),
    },
    loadJson<Settings>(SETTINGS_KEY, DEFAULT_SETTINGS)
  );
  const texts = () => ({ rampNoArrow: t("relief.label.rampNoArrow"), inclined: t("relief.label.inclined"), relative: t("relief.label.relative") });
  map = new MapView(o.map, editor, texts());
  // What the keys do in what's being done, on the map while it's being done.
  const chip = $("chip");
  const drawMap = map.redraw.bind(map);
  map.redraw = () => {
    drawMap();
    const text = liveHint(editor, t, o.unit);
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
  };
  void pictureOf(image.image.url, image.image.mime.startsWith("video")).then((picture) => {
    map.picture = picture;
    map.fit();
  });
  const setTool = (id: ToolId) => {
    editor.setTool(id);
    closeMenus();
  };

  // ---------- Menus ----------
  const rootPoint = (clientX: number, clientY: number): [number, number] => {
    const r = root.getBoundingClientRect();
    return [clientX - r.left, clientY - r.top];
  };
  /** The groups folded in the shapes' list (this time the editor's open). */
  const groupsFolded = new Set<string>();
  const listUi = (): ShapesList => ({ folded: shapesFold, groupsFolded, onMenu: shapeMenu, onGroupMenu: groupMenu, focusName });
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
  function shapeMenu(i: number, clientX: number, clientY: number) {
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
    openMenu(root, x + 2, y + 2, items);
  }
  // A right click on the map: on a shape, its menu (picked first, unless it's among what's picked).
  map.onMenu = (sx, sy, at) => {
    const i = editor.shapeAt(at.x, at.y);
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
  // A click anywhere else closes a menu.
  const outside = (event: PointerEvent) => {
    if (!(event.target as HTMLElement).closest(".re-menu")) {
      closeMenus();
    }
  };
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
    let read: ReliefData | null = null;
    try {
      read = fromStored(JSON.parse(await chosen.text()));
    } catch {
      read = null;
    }
    if (!read) {
      notice(t("relief.importBad"));
      return;
    }
    editor.replace(read);
  };
  $("toolBtn").onclick = () => {
    const r = $("toolBtn").getBoundingClientRect();
    const [x, y] = rootPoint(r.left, r.bottom + 4);
    openMenu(root, x, y, toolsMenu(editor, t, setTool));
  };
  $("more").onclick = async () => {
    const r = $("more").getBoundingClientRect();
    const [x, y] = rootPoint(r.right, r.bottom + 4);
    let sure = false;
    // How big it is as the scene keeps it, and the versions kept here.
    const [packed, backups] = await Promise.all([pack(JSON.stringify(toStored(editor.data))).catch(() => ""), backupsOf(image.id)]);
    const versions: MenuItem[] = backups.length
      ? backups.map((backup) => ({
          label: new Date(backup.at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }),
          run: () => {
            const read = fromStored(JSON.parse(backup.json));
            if (read) {
              editor.replace(read);
              notice(t("relief.versionBack"));
            }
          },
        }))
      : [{ label: t("relief.versionsNone"), disabled: true }];
    // On a narrow map, what the top bar has no room for.
    const narrow = (): MenuItem[] =>
      pieces.classList.contains("re-narrow")
        ? [
            {
              label: t("relief.image"),
              items: o.images.map((i, k): MenuItem => ({
                label: i.id === image.id ? `${imageName(i, k)} ✓` : imageName(i, k),
                run: () => {
                  if (i.id !== image.id) {
                    const select = $<HTMLSelectElement>("image");
                    select.value = i.id;
                    select.dispatchEvent(new Event("change"));
                  }
                },
              })),
            },
            { icon: "heights", label: map.showHeights ? `${t("relief.heights")} ✓` : t("relief.heights"), run: () => $("heights").click() },
            { icon: "magnet", label: editor.settings.grid ? `${t("relief.grid")} ✓` : t("relief.grid"), run: () => $("grid").click() },
            ...(pieces.classList.contains("re-tighter") ? [{ label: t("relief.shortcuts"), key: "?", run: toggleHelp }] : []),
            "-",
          ]
        : [];
    const items = (): MenuItem[] => [
      ...narrow(),
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
      { label: t("relief.import"), run: () => file.click() },
      { label: t("relief.versions"), items: versions },
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
      { label: t("relief.size", { size: packed ? sizeOf(packed.length) : "?" }), disabled: true },
    ];
    openMenu(root, x - 220, y, items());
  };
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
    session.stop();
    Object.assign(session, startEditing(o, next, before));
  };

  // The keys, all of them (the "?").
  function toggleHelp() {
    const pop = $("pop");
    pop.hidden = !pop.hidden;
    pop.innerHTML = pop.hidden ? "" : shortcutsHtml(editor, t);
    $("help").classList.toggle("on", !pop.hidden);
  }

  panel();
  o.onRelief(image.id, editor.relief, false);

  session = {
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
    stop() {
      if (saveTimer) {
        saveNow();
      }
      stopWatching();
      closeMenus();
      untip();
      split.stop();
      fitter.disconnect();
      toolsEnd.disconnect();
      o.onPick?.([]);
      document.removeEventListener("pointerdown", outside, true);
      clearTimeout(toastTimer);
      map.dispose();
      pieces.remove();
    },
  };
  return session;
}
