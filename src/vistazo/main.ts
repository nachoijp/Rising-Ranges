import OBR, { type GridType, type Theme } from "@owlbear-rodeo/sdk";
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
import { buildScene, type Token, type VistazoScene } from "./scene";
import { VistazoView, type Camera, type DistanceLine, type Options } from "./render";
import { LIVE_DRAG_CHANNEL, type LiveDrag } from "./live";
import "./vistazo.css";

// The Vistazo 3D: the action's own popover, opened from its icon at the
// top, sized to most of the window. A quick look at where everything is in
// 3D — the map raised by its terrain, the tokens at their heights — that
// changes nothing in the scene. GM only for now.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const POSE = { tilt: 55, yaw: -25 };
const OPTIONS_KEY = "rising-ranges/vistazo-options";

function readOptions(): Options {
  const defaults: Options = { heightScale: 1, shade: 0.6, perspective: 45, tint: false, tokens: true, xray: false, edges: true, anchor: "center", levels: true, grid: false, distances: true };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}") };
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

function applyTheme(theme: Theme) {
  const root = document.documentElement.style;
  root.setProperty("--bg", theme.background.default);
  root.setProperty("--panel", theme.background.paper);
  root.setProperty("--fg", theme.text.primary);
  root.setProperty("--muted", theme.text.secondary);
  root.setProperty("--accent", theme.primary.main);
  root.setProperty("--accent-fg", theme.primary.contrastText);
  document.documentElement.style.colorScheme = theme.mode === "DARK" ? "dark" : "light";
}

const SIZE_KEY = "rising-ranges/vistazo-size";
const MIN_WIDTH = 220;
const MIN_HEIGHT = 180;

type Size = { width: number; height: number; compact: boolean };

function readSize(): Partial<Size> {
  try {
    return JSON.parse(localStorage.getItem(SIZE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveSize(size: Partial<Size>) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify({ ...readSize(), ...size }));
  } catch {
    // Only a convenience.
  }
}

/** The popover's size: the one it was left at, or most of the window the first time. */
async function fitToWindow() {
  const [width, height] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight()]);
  const saved = readSize();
  const w = Math.min(width - 40, saved.width ?? width - 120);
  const h = Math.min(height - 80, saved.height ?? height - 140);
  await Promise.all([
    OBR.action.setWidth(Math.max(MIN_WIDTH, Math.round(w))),
    OBR.action.setHeight(Math.max(MIN_HEIGHT, Math.round(h))),
  ]);
}

/**
 * The corner handle resizes the popover (it's Owlbear's: the page asks for
 * a new size), and the panel button hides the controls: small, with only the
 * view, it's a minimap that keeps up with the scene.
 */
function setUpResizing() {
  const app = $("app");
  const compact = (on: boolean) => {
    app.classList.toggle("compact", on);
    $("panelToggle").setAttribute("aria-pressed", String(!on));
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
      void OBR.action.setWidth(width);
      void OBR.action.setHeight(height);
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
  void fitToWindow();
  let language: Language = languageFromMetadata(metadata ?? {});
  const t = (key: TranslationKey, vars?: Record<string, string | number>) => translate(language, key, vars);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      void OBR.action.close();
    }
  });

  if (role !== "GM") {
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
    return;
  }

  setUpResizing();

  // ---------- Texts ----------
  const fill = () => {
    for (const el of document.querySelectorAll<HTMLElement>("[data-t]")) {
      el.textContent = t(el.dataset.t as TranslationKey);
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-title]")) {
      el.title = t(el.dataset.title as TranslationKey);
      el.setAttribute("aria-label", el.title);
    }
  };
  fill();

  let scene: VistazoScene | null = null;
  const distance = (units: number) => (scene ? formatDistance(scene.scale, units) : String(units));
  const tokenText = (token: Token) => {
    const total = token.terrain + token.own;
    const detail =
      token.own > 0
        ? t("vistazo.flying", { terrain: distance(token.terrain), own: distance(token.own) })
        : token.own < 0
          ? t(token.terrain === 0 ? "vistazo.buriedGround" : "vistazo.buriedTerrain", { depth: distance(-token.own) })
          : token.terrain > 0
            ? t("vistazo.onTerrain")
            : token.terrain < 0
              ? t("vistazo.inPit")
              : t("vistazo.onGround");
    return { title: `${token.name} · ${distance(total)}`, detail: token.hidden ? `${detail} · ${t("vistazo.hidden")}` : detail };
  };

  // ---------- View ----------
  const stage = $("stage");
  let options = readOptions();
  const view = new VistazoView(stage, tokenText, options);
  view.setOptions(options);
  const camera = view.camera;

  const tilt = $<HTMLInputElement>("tilt");
  const yaw = $<HTMLInputElement>("yaw");
  view.onCamera = () => {
    tilt.value = String(camera.tilt);
    yaw.value = String(camera.yaw);
    $("tiltOut").textContent = `${Math.round(camera.tilt)}°`;
    $("yawOut").textContent = `${Math.round(camera.yaw)}°`;
    $("status").textContent = t("vistazo.status", { turn: Math.round(camera.yaw), tilt: Math.round(camera.tilt) });
    $("needle").setAttribute("transform", `rotate(${camera.yaw})`);
    $("toggle").textContent = t(camera.tilt < 1 ? "vistazo.to3d" : "vistazo.toTop");
  };

  const wrapYaw = (y: number) => ((((y + 180) % 360) + 360) % 360) - 180;
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

  // Pointer: drag orbits; the wheel held down (or Shift) pans, as in Owlbear; two fingers zoom and pan.
  const pointers = new Map<number, [number, number]>();
  let mode: "orbit" | "pan" | "pinch" | null = null;
  let last: [number, number] | null = null;
  let pinch: { d: number; zoom: number; mid: [number, number]; pan: [number, number] } | null = null;
  // A click on a token (no drag) selects it in Owlbear; a second one soon after turns the camera around it.
  let press: { token: string | null; x: number; y: number } | null = null;
  let lastClick = { token: "", at: 0 };
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
    event.preventDefault();
    stage.focus({ preventScroll: true });
    cancelAnimationFrame(frame);
    press = pointers.size === 0 && event.button === 0 ? { token: view.tokenAt(event.target), x: event.clientX, y: event.clientY } : null;
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    stage.classList.add("dragging");
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: camera.zoom, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], pan: [camera.panX, camera.panY] };
      mode = "pinch";
    } else {
      mode = event.button === 1 || event.shiftKey ? "pan" : "orbit";
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
      camera.panX = pinch.pan[0] + (a[0] + b[0]) / 2 - pinch.mid[0];
      camera.panY = pinch.pan[1] + (a[1] + b[1]) / 2 - pinch.mid[1];
    } else if (last) {
      const dx = event.clientX - last[0];
      const dy = event.clientY - last[1];
      last = [event.clientX, event.clientY];
      if (mode === "pan") {
        camera.panX += dx;
        camera.panY += dy;
      } else {
        camera.yaw = wrapYaw(camera.yaw - dx * 0.3);
        camera.tilt = clampTilt(camera.tilt - dy * 0.25);
      }
    }
    view.apply();
  });
  const up = (event: PointerEvent) => {
    if (press?.token && event.type === "pointerup" && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 5) {
      const id = press.token;
      const now = performance.now();
      if (lastClick.token === id && now - lastClick.at < 400) {
        animateTo({ focus: view.tokenFocus(id), panX: 0, panY: 0, zoom: Math.max(camera.zoom, 2.5) });
        lastClick = { token: "", at: 0 };
      } else {
        void OBR.player.select([id]);
        lastClick = { token: id, at: now };
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
  stage.addEventListener("pointercancel", up);
  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      cancelAnimationFrame(frame);
      camera.zoom = Math.max(0.35, Math.min(8, camera.zoom * Math.exp(-event.deltaY * 0.0015)));
      view.apply();
    },
    { passive: false }
  );
  stage.addEventListener("keydown", (event) => {
    const keys: Record<string, () => void> = {
      ArrowLeft: () => (camera.yaw = wrapYaw(camera.yaw + 5)),
      ArrowRight: () => (camera.yaw = wrapYaw(camera.yaw - 5)),
      ArrowUp: () => (camera.tilt = clampTilt(camera.tilt + 3)),
      ArrowDown: () => (camera.tilt = clampTilt(camera.tilt - 3)),
      "+": () => (camera.zoom = Math.min(8, camera.zoom * 1.15)),
      "=": () => (camera.zoom = Math.min(8, camera.zoom * 1.15)),
      "-": () => (camera.zoom = Math.max(0.35, camera.zoom / 1.15)),
    };
    if (keys[event.key]) {
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
  const set = (change: Partial<Options>) => {
    options = { ...options, ...change };
    saveOptions(options);
    view.setOptions(change);
    showOptions();
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
    check("xray").checked = options.xray;
    check("edges").checked = options.edges;
    check("levels").checked = options.levels;
    check("grid").checked = options.grid;
    check("distances").checked = options.distances;
    anchor.value = options.anchor;
  }
  persp.oninput = () => set({ perspective: Number(persp.value) });
  hscale.oninput = () => set({ heightScale: Number(hscale.value) });
  shade.oninput = () => set({ shade: Number(shade.value) / 100 });
  check("tint").onchange = () => set({ tint: check("tint").checked });
  check("showTok").onchange = () => set({ tokens: check("showTok").checked });
  check("xray").onchange = () => set({ xray: check("xray").checked });
  check("edges").onchange = () => set({ edges: check("edges").checked });
  check("levels").onchange = () => set({ levels: check("levels").checked });
  check("grid").onchange = () => set({ grid: check("grid").checked });
  check("distances").onchange = () => set({ distances: check("distances").checked });
  anchor.onchange = () => set({ anchor: anchor.value === "base" ? "base" : "center" });
  showOptions();

  // ---------- The scene, kept up to date ----------
  let items = await OBR.scene.items.getItems();
  let sceneMetadata = metadata;
  let [dpi, scale] = await Promise.all([OBR.scene.grid.getDpi(), OBR.scene.grid.getScale()]);
  let selection: string[] = (await OBR.player.getSelection()) ?? [];
  /**
   * With one token selected, lines to every other token within a Banda —
   * the same readings as the Distancias panel (heights with the terrain).
   */
  const showDistances = () => {
    const origin = selection.length === 1 ? scene?.tokens.find((token) => token.id === selection[0]) : undefined;
    if (!scene || !origin) {
      view.setDistances(null, []);
      return;
    }
    const bandSet = onGrid(bandSetFromMetadata(sceneMetadata), gridType);
    const bands = measuredBands(bandSet);
    const theme = getStoredTheme();
    const rows = computeDistanceRows(
      origin.item,
      scene.tokens.filter((token) => token.id !== origin.id).map((token) => token.item),
      scene.heights,
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
        label: `${bands[row.bandIndex].name} · ${formatDistance(scale, row.distance)}`,
      });
    }
    view.setDistances(origin.id, lines);
  };
  view.setSelected(selection);
  OBR.player.onChange((player) => {
    selection = player.selection ?? [];
    view.setSelected(selection);
    showDistances();
  });

  const refresh = () => {
    try {
      scene = buildScene(sceneMetadata, items, dpi, scale, gridType, scene ?? undefined);
      $("terrainOff").hidden = !scene.terrainOff;
      view.setScene(scene);
      showDistances();
    } catch (error) {
      console.error("Rising Ranges: Vistazo couldn't draw the scene", error);
    } finally {
      $("loading").hidden = true;
    }
  };
  let pending = 0;
  const later = () => {
    clearTimeout(pending);
    pending = window.setTimeout(refresh, 150);
  };
  OBR.scene.items.onChange((next) => {
    items = next;
    later();
  });
  OBR.scene.onMetadataChange((next) => {
    sceneMetadata = next;
    const nextLanguage = languageFromMetadata(next);
    if (nextLanguage !== language) {
      language = nextLanguage;
      fill();
      showOptions();
    }
    later();
  });
  OBR.scene.grid.onChange(async (grid) => {
    gridType = grid.type;
    [dpi, scale] = await Promise.all([OBR.scene.grid.getDpi(), OBR.scene.grid.getScale()]);
    later();
  });
  // A token dragged with the Medición tool, moved here as it goes; the scene catches up once it's dropped.
  OBR.broadcast.onMessage(LIVE_DRAG_CHANNEL, (event) => {
    const { tokenId, position } = event.data as LiveDrag;
    const token = scene?.tokens.find((t) => t.id === tokenId);
    if (!scene || !token || !position) {
      return;
    }
    const x = token.x + position.x - token.item.position.x;
    const y = token.y + position.y - token.item.position.y;
    const moved = { ...token, x, y, terrain: scene.measuredAt(x, y), item: { ...token.item, position } };
    scene = { ...scene, tokens: scene.tokens.map((t) => (t.id === tokenId ? moved : t)), heights: new Map(scene.heights).set(tokenId, moved.terrain + moved.own) };
    view.setScene(scene);
    showDistances();
  });
  OBR.scene.onReadyChange((ready) => {
    if (!ready) {
      void OBR.action.close();
    }
  });

  refresh();
  // It opens from straight above and tilts up into 3D.
  setTimeout(() => animateTo(POSE, 1200), 250);
}

OBR.onReady(() => {
  start().catch((error) => console.error("Rising Ranges: failed to open the Vistazo 3D", error));
});
