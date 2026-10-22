import type { Image, Item } from "@owlbear-rodeo/sdk";
import { anchorOf, reliefSize } from "../anchor";
import { emptyRelief, fromStored, toStored } from "../codec";
import type { Relief } from "../relief";
import { saveRelief, watchReliefs } from "../store";
import type { ReliefData } from "../types";
import { withZones } from "../zones";
import { DEFAULT_SETTINGS, ReliefEditor, type Settings, type ToolId } from "./editor";
import { TOOLS, esc, renderHint, renderLayers, renderProps, renderTools, type T } from "./panel";
import { MapView } from "./view2d";

// Editing a relief in the Vistazo 3D (its full screen, the GM's): the editor's
// panel and the map in 2D beside the Vistazo's own 3D, for one map image at a
// time (the largest first; a list to change it). Each change is drawn by the
// Vistazo (lightly while something's being dragged, all of it when it's let
// go) and saved on this device a moment after.

const SETTINGS_KEY = "rising-ranges/relief-editor/settings";
/** How long after the last change the relief is saved (ms). */
const SAVE_AFTER = 500;
/** The picture's size for the map view (px across): enough to trace on. */
const PICTURE_WIDTH = 2048;

export type EditSession = {
  /** The image being edited. */
  imageId: string;
  /** A key pressed while editing: whether the editor took it (Escape always: it doesn't leave the full screen). */
  key(event: KeyboardEvent): boolean;
  /** The language changed: texts again. */
  retext(): void;
  /** Saved now, and the panel and the map taken away. */
  stop(): void;
};

export type SessionOptions = {
  t: T;
  /** The scene's map images, the largest first. */
  images: Image[];
  /** The reliefs the Vistazo has (to start from). */
  reliefs: Map<string, Relief>;
  side: HTMLElement;
  map: HTMLCanvasElement;
  /** The relief of an image changed: drawn again (`lite`: something's being dragged). */
  onRelief: (imageId: string, relief: Relief, lite: boolean) => void;
  /** The scene's items and its dpi now (for its old terrain zones). */
  scene: () => { items: Item[]; dpi: number };
  /** "Done": editing over. */
  onDone: () => void;
};

function loadSettings(): Partial<Settings> {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function keepSettings(settings: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
  const { t, side } = o;
  const image = o.images.find((i) => i.id === imageId) ?? o.images[0];
  side.innerHTML = `
    <div class="re-head">
      <label class="re-image">${esc(t("relief.image"))}
        <select id="reImage">${o.images.map((i, k) => `<option value="${esc(i.id)}" ${i.id === image.id ? "selected" : ""}>${esc(imageName(i, k))}</option>`).join("")}</select>
      </label>
      <button type="button" class="primary" id="reDone">${esc(t("vistazo.editDone"))}</button>
    </div>
    <div class="re-actions">
      <button type="button" id="reUndo" title="${esc(t("relief.undo"))}" disabled>${esc(t("relief.undo"))}</button>
      <label class="check"><input type="checkbox" id="reHeights" checked /> ${esc(t("relief.heights"))}</label>
      <button type="button" id="reExport" title="${esc(t("relief.exportHint"))}">${esc(t("relief.export"))}</button>
      <button type="button" id="reImport" title="${esc(t("relief.importHint"))}">${esc(t("relief.import"))}</button>
      <input type="file" id="reFile" accept=".json,application/json" hidden />
      <button type="button" id="reZones" title="${esc(t("relief.zonesHint"))}">${esc(t("relief.zones"))}</button>
      <button type="button" id="reClear">${esc(t("relief.clear"))}</button>
    </div>
    <p class="re-status" id="reStatus" role="status"></p>
    <div class="re-tools" id="reTools"></div>
    <div class="re-hint" id="reHint"></div>
    <div class="re-props" id="reProps"></div>
    <div class="re-layers" id="reLayers"></div>
    <p class="re-note">${esc(t("relief.localOnly"))}</p>`;
  const $ = (id: string) => side.querySelector<HTMLElement>(`#${id}`)!;
  const [w, h] = reliefSize(anchorOf(image));
  // Its own copy (the Vistazo's goes on drawing the one it has until this one's handed over).
  const kept = o.reliefs.get(image.id);
  const data: ReliefData = (kept && fromStored(JSON.parse(JSON.stringify(toStored(kept.data))))) || emptyRelief(w, h);

  // Saving: a moment after the last change; the background's answer says whether it was kept.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let sent = "";
  const status = $("reStatus");
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
      status.textContent = relief && JSON.stringify(toStored(relief)) === sent ? t("relief.saved") : t("relief.notSaved");
      sent = "";
    }
  });

  const keysOpen = { value: false };
  let frame = 0;
  const focusName = () => {
    const name = side.querySelector<HTMLInputElement>('#reProps [data-k="name"]');
    name?.focus();
    name?.select();
  };
  /** The panel, the tools and the layers, at the next frame. */
  const panel = () => {
    if (frame) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderTools($("reTools"), editor, t, setTool);
      renderHint($("reHint"), editor, t, keysOpen);
      renderProps($("reProps"), editor, t);
      renderLayers($("reLayers"), editor, t, focusName);
      ($("reUndo") as HTMLButtonElement).disabled = !editor.canUndo;
    });
  };
  let layersFrame = 0;
  const layers = () => {
    if (layersFrame) {
      return;
    }
    layersFrame = requestAnimationFrame(() => {
      layersFrame = 0;
      renderLayers($("reLayers"), editor, t, focusName);
      ($("reUndo") as HTMLButtonElement).disabled = !editor.canUndo;
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
        layers();
        save();
        o.onRelief(image.id, editor.relief, busy());
      },
      showProps: () => {
        panel();
        map.redraw();
      },
      redraw: () => map.redraw(),
      setCursor: (cursor) => (o.map.style.cursor = cursor),
      snapReach: () => 10 / map.scale,
      toScreen: (x, y) => map.toScreen(x, y),
      saveSettings: () => keepSettings(editor.settings),
    },
    loadSettings()
  );
  const texts = () => ({ rampNoArrow: t("relief.label.rampNoArrow"), inclined: t("relief.label.inclined"), relative: t("relief.label.relative") });
  map = new MapView(o.map, editor, texts());
  // Let go: the Vistazo draws all of it again.
  map.onUp = () => o.onRelief(image.id, editor.relief, false);
  void pictureOf(image.image.url).then((picture) => {
    map.picture = picture;
    map.fit();
  });
  const setTool = (id: ToolId) => editor.setTool(id);
  panel();
  o.onRelief(image.id, editor.relief, false);

  // The panel's own buttons.
  $("reDone").onclick = () => o.onDone();
  $("reUndo").onclick = () => editor.undo();
  ($("reHeights") as HTMLInputElement).onchange = (event) => {
    map.showHeights = (event.target as HTMLInputElement).checked;
    map.redraw();
  };
  $("reExport").onclick = () => {
    const blob = new Blob([JSON.stringify(toStored(editor.data))], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${imageName(image, 0).replace(/[^\w.-]+/g, "_")}.relief.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const file = $("reFile") as HTMLInputElement;
  $("reImport").onclick = () => file.click();
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
      status.textContent = t("relief.importBad");
      return;
    }
    editor.replace(read);
  };
  $("reZones").onclick = () => {
    const { items, dpi } = o.scene();
    // Its own copy to add to (what's undone keeps the one before).
    const own = fromStored(JSON.parse(JSON.stringify(toStored(editor.data))))!;
    const { data: next, count } = withZones(items, image, dpi, own);
    if (count === 0) {
      status.textContent = t("relief.zonesNone");
      return;
    }
    editor.replace(next);
    status.textContent = t("relief.zonesDone", { count });
  };
  let armed: ReturnType<typeof setTimeout> | undefined;
  $("reClear").onclick = () => {
    const button = $("reClear");
    if (!armed) {
      button.textContent = t("relief.clearSure");
      armed = setTimeout(() => {
        armed = undefined;
        button.textContent = t("relief.clear");
      }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = undefined;
    button.textContent = t("relief.clear");
    editor.replace(emptyRelief(editor.data.w, editor.data.h));
  };
  // Another image: this one saved, and the editor started again on that one.
  let session: EditSession;
  ($("reImage") as HTMLSelectElement).onchange = (event) => {
    const next = (event.target as HTMLSelectElement).value;
    session.stop();
    Object.assign(session, startEditing(o, next));
  };

  session = {
    imageId: image.id,
    key(event) {
      const target = event.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
        return false;
      }
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && event.code === "KeyZ") {
        editor.undo();
        return true;
      }
      if (editor.key({ key: event.key, code: event.code, ctrl, shift: event.shiftKey, alt: event.altKey })) {
        return true;
      }
      if (!ctrl && !event.altKey && event.key.length === 1) {
        const tool = TOOLS.find((x) => x.key === event.key.toLowerCase());
        if (tool) {
          setTool(tool.id);
          return true;
        }
      }
      return event.key === "Escape";
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
      map.dispose();
      side.innerHTML = "";
    },
  };
  return session;
}
