import type { Image, Item } from "@owlbear-rodeo/sdk";
import { anchorOf, reliefSize } from "../anchor";
import { emptyRelief, fromStored, toStored } from "../codec";
import type { Box } from "../geom";
import { Relief } from "../relief";
import { saveRelief, watchReliefs } from "../store";
import type { ReliefData } from "../types";
import { withZones } from "../zones";
import { DEFAULT_SETTINGS, ReliefEditor, type Settings, type ToolId } from "./editor";
import { icon } from "./icons";
import {
  COMBINES,
  TOOL_LIST,
  closeMenus,
  esc,
  installTips,
  openMenu,
  renderOptions,
  renderProps,
  renderShapes,
  renderTools,
  runCombine,
  shortcutsHtml,
  tip,
  type MenuItem,
  type T,
} from "./panel";
import { duplicate, setType, swap } from "./shapes";
import { MapView } from "./view2d";

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
};

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
   * The relief of an image changed: drawn again (`lite`: something's being
   * dragged; `heights`: only its heights changed, within that box of cells).
   */
  onRelief: (imageId: string, relief: Relief, lite: boolean, heights?: Box | null) => void;
  /** The scene's items and its dpi now (for its old terrain zones). */
  scene: () => { items: Item[]; dpi: number };
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

/** A map image's picture on a canvas. */
async function pictureOf(url: string): Promise<HTMLCanvasElement | null> {
  try {
    const img = document.createElement("img");
    img.crossOrigin = "anonymous";
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(PICTURE_WIDTH, img.naturalWidth);
    canvas.height = Math.round((canvas.width * img.naturalHeight) / img.naturalWidth);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch (error) {
    console.error("Rising Ranges: the map's picture couldn't be read for the relief editor", error);
    return null;
  }
}

/** An image's name, as the list shows it. */
const imageName = (image: Image, i: number) => image.text?.plainText || image.name || `#${i + 1}`;

export function startEditing(o: SessionOptions, imageId = o.images[0]?.id ?? ""): EditSession {
  const { t, root } = o;
  const image = o.images.find((i) => i.id === imageId) ?? o.images[0];
  const [w, h] = reliefSize(anchorOf(image));
  // Its own copy (the Vistazo's goes on drawing the one it has until this one's handed over); as it
  // was, for the X.
  const kept = o.reliefs.get(image.id);
  const original = kept ? JSON.stringify(toStored(kept.data)) : null;
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
      <label class="re-image" ${tip(t("relief.image"), t("relief.imageHint"))}><select data-k="image">${o.images.map((i, k) => `<option value="${esc(i.id)}" ${i.id === image.id ? "selected" : ""}>${esc(imageName(i, k))}</option>`).join("")}</select></label>
      <div class="vsep"></div>
      <button type="button" class="ib sm" data-k="undo" ${tip(t("relief.undoName"), "", "Ctrl+Z")}>${icon("undo")}</button>
      <button type="button" class="ib sm" data-k="redo" ${tip(t("relief.redo"), "", "Ctrl+Y")}>${icon("redo")}</button>
      <button type="button" class="ib sm on" data-k="heights" aria-pressed="true" ${tip(t("relief.heights"), t("relief.heightsHint"))}>${icon("heights")}</button>
      <div class="vsep"></div>
      <div class="re-options" data-k="options"></div>
      <button type="button" class="ib sm re-help" data-k="help" ${tip(t("relief.shortcuts"), t("relief.shortcutsHint"), "?")}>?</button>
      <div class="vsep"></div>
      <button type="button" class="ib sm" data-k="more" ${tip(t("relief.more"), t("relief.moreHint"))}>${icon("more")}</button>
      <input type="file" data-k="file" accept=".json,application/json" hidden />
      <button type="button" class="ib sm" data-k="exit" ${tip(t("relief.exit"), t("relief.exitHint"))}>${icon("close")}</button>
      <button type="button" class="done" data-k="done" ${tip(t("vistazo.editDone"), t("relief.localOnly"))}>${esc(t("vistazo.editDone"))}</button>
    </div>
    <div class="re-tools glass" data-k="tools"></div>
    <div class="re-props glass" data-k="props" hidden></div>
    <div class="re-shapes glass" data-k="shapes"></div>
    <div class="re-pop glass" data-k="pop" hidden></div>
    <div class="re-toast" data-k="toast" role="status" hidden></div>`;
  root.append(pieces);
  const $ = <E extends HTMLElement = HTMLElement>(k: string) => pieces.querySelector<E>(`[data-k="${k}"]`)!;
  const untip = installTips(root);

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
  let sent = "";
  const saveNow = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    sent = JSON.stringify(toStored(editor.data));
    saveRelief(image.id, editor.data);
  };
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_AFTER);
  };
  const stopWatching = watchReliefs((id, relief) => {
    if (id === image.id && sent) {
      if (!(relief && JSON.stringify(toStored(relief)) === sent)) {
        notice(t("relief.notSaved"));
      }
      sent = "";
    }
  });

  // ---------- The editor ----------
  let frame = 0;
  const focusName = () => {
    const name = pieces.querySelector<HTMLInputElement>('[data-k="props"] [data-k="name"]');
    name?.focus();
    name?.select();
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
      renderTools($("tools"), editor, t, setTool);
      renderOptions($("options"), editor, t);
      renderProps($("props"), editor, t, o.unit, panelFolds);
      renderShapes($("shapes"), editor, t, shapesFold, shapeMenu, focusName);
      history();
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
      renderShapes($("shapes"), editor, t, shapesFold, shapeMenu, focusName);
      history();
    });
  };
  const busy = () => !!(editor.xf || editor.drag || editor.brushing || editor.arrowEnd);
  // eslint-disable-next-line prefer-const
  let map: MapView;
  const editor: ReliefEditor = new ReliefEditor(
    data,
    {
      changed: () => {
        map.redraw();
        list();
        save();
        o.onRelief(image.id, editor.relief, busy() || editor.heightsOnly, editor.heightsOnly ? editor.takeDirty() : null);
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
  // Picking (Elegir) to start with.
  editor.setTool("edit");
  // Let go: the Vistazo draws all of it again.
  map.onUp = () => o.onRelief(image.id, editor.relief, false);
  void pictureOf(image.image.url).then((picture) => {
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
  /** A shape's menu (what's picked, with it). */
  function shapeMenu(i: number, clientX: number, clientY: number) {
    const shapes = editor.data.shapes;
    const many = editor.sel?.kind === "shape" && (editor.sel.more?.length ?? 0) > 0;
    const redo = () => {
      editor.changed();
      editor.host.showProps();
    };
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
  $("more").onclick = () => {
    const r = $("more").getBoundingClientRect();
    const [x, y] = rootPoint(r.right, r.bottom + 4);
    let sure = false;
    const items = (): MenuItem[] => [
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
            again[again.length - 1] = { icon: "delete", label: t("relief.clearSure"), run: () => editor.replace(emptyRelief(editor.data.w, editor.data.h)) };
            setTimeout(() => openMenu(root, x - 220, y, again), 0);
          }
        },
      },
    ];
    openMenu(root, x - 220, y, items());
  };
  $("done").onclick = () => o.onDone();
  // The X: the relief back as it was when editing began, and editing over.
  $("exit").onclick = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    const back = original ? fromStored(JSON.parse(original)) : null;
    saveRelief(image.id, back);
    if (back) {
      o.onRelief(image.id, new Relief(back), false);
    }
    o.onDone();
  };
  // Another image: this one saved, and the editor started again on that one.
  let session: EditSession;
  $<HTMLSelectElement>("image").onchange = (event) => {
    const next = (event.target as HTMLSelectElement).value;
    session.stop();
    Object.assign(session, startEditing(o, next));
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
        if (tool) {
          setTool(tool.id);
          return true;
        }
      }
      return false;
    },
    retext() {
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
      document.removeEventListener("pointerdown", outside, true);
      clearTimeout(toastTimer);
      map.dispose();
      pieces.remove();
    },
  };
  return session;
}
