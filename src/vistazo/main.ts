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
import { buildScene, type Token, type VistazoScene } from "./scene";
import { VistazoView, type Camera, type DistanceLine, type Options } from "./render";
import { LIVE_DRAG_CHANNEL, type LiveDrag } from "./live";
import { stepHeight } from "../engine/heights";
import { globalSettingsFromMetadata, groundHotkey, letterToCode } from "../settings/globalSettings";
import { setTokenHeightMarker } from "../tokenHeight/markers";
import { bodyCenterHeight, DEFAULT_TOLERANCE, excessRadius } from "../engine/distance";
import { isHexShape } from "../engine/hex";
import { getTokenRadius } from "../render/iconAnchor";
import { getPluginId } from "../util/getPluginId";
import { clearOf, fogOver } from "./fog";
import { DragPath } from "../util/dragPath";
import "./vistazo.css";

/**
 * The same page opened full screen (an Owlbear modal, `?full`): the
 * action's own popover can't grow past what Owlbear leaves it under its top
 * bar. Going there and back keeps the camera (CAMERA_KEY, read once).
 */
const FULL = new URLSearchParams(location.search).has("full");
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
  const defaults: Options = { heightScale: 1, shade: 0.6, perspective: 45, tint: false, tokens: true, xray: false, edges: true, anchor: "center", levels: true, grid: false, distances: true, tokenLabels: "full", distanceLabels: "full", labelSize: 1, relief: 0.5, props: "flat", wallStyle: "fold", rings: true, ringFill: false, playerView: false };
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
  if (FULL) {
    document.documentElement.classList.add("full");
  } else {
    void fitToWindow();
  }
  let language: Language = languageFromMetadata(metadata ?? {});
  const t = (key: TranslationKey, vars?: Record<string, string | number>) => translate(language, key, vars);
  /** Set while a token is being moved here: Esc cancels that instead of closing. */
  let cancelMove: (() => void) | null = null;
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (cancelMove) {
        cancelMove();
      } else if (FULL) {
        leaveFull();
      } else {
        void OBR.action.close();
      }
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

  /** The camera handed over to the other view, for a few seconds. */
  function handCamera() {
    try {
      localStorage.setItem(CAMERA_KEY, JSON.stringify({ at: Date.now(), camera }));
    } catch {
      // It just opens as usual.
    }
  }
  function takeCamera(): Partial<Camera> | null {
    try {
      const stored = JSON.parse(localStorage.getItem(CAMERA_KEY) ?? "null");
      localStorage.removeItem(CAMERA_KEY);
      return stored && Date.now() - stored.at < 5000 ? stored.camera : null;
    } catch {
      return null;
    }
  }
  /** To full screen: this popover closes, the modal opens with its camera. */
  function enterFull() {
    handCamera();
    void OBR.modal.open({ id: FULL_MODAL_ID, url: "/vistazo.html?full", fullScreen: true });
    void OBR.action.close();
  }
  /** Back from full screen: the popover opens again with its camera, and the modal closes. */
  function leaveFull() {
    handCamera();
    void OBR.action.open();
    void OBR.modal.close(FULL_MODAL_ID);
  }
  $("fullToggle").onclick = () => (FULL ? leaveFull() : enterFull());
  $("fullToggle").dataset.title = FULL ? "vistazo.exitFull" : "vistazo.full";
  $("fullIcon").setAttribute("d", FULL ? "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" : "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5");

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
    return { name: token.name, height: distance(total), detail: token.hidden ? `${detail} · ${t("vistazo.hidden")}` : detail };
  };

  // ---------- View ----------
  const stage = $("stage");
  let options = readOptions();
  const view = new VistazoView(stage, tokenText, options);
  if (!view.ready) {
    message(t("vistazo.noWebgl"));
    return;
  }
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
  let mode: "orbit" | "pan" | "pinch" | "token" | null = null;
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
   * A token being moved here (the GM's left drag on it): it follows the
   * terrain under the cursor, snapped to the grid, through Owlbear's own
   * drag (others see it move, its marker rides along); Z/X (the scene's
   * keys) change its own height meanwhile. Written on release; Esc undoes it.
   */
  let moving: {
    id: string;
    item: Image;
    /** From the terrain under the cursor to the token's position, scene px. */
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
  const endMove = () => {
    moving = null;
    cancelMove = null;
    // The rings follow it again (once the scene has it where it landed).
    if (draggingId) {
      const id = draggingId;
      draggingId = null;
      setTimeout(() => {
        live.delete(id);
        showDistances();
        // Now the relief can follow the fog (see refresh).
        later();
      }, 300);
    }
  };
  let lastClick = { token: "", at: 0, x: 0, y: 0 };
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
    // A left press on an unlocked token, without Shift: ready to move it (from the first few px of drag).
    const pressed = press?.token && !event.shiftKey ? scene?.tokens.find((t) => t.id === press!.token) : undefined;
    if (pressed && !pressed.item.locked) {
      const at = stagePoint(event);
      const ground = view.pickTerrain(at.x, at.y);
      if (ground) {
        moving = {
          id: pressed.id,
          item: pressed.item,
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
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    stage.classList.add("dragging");
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: camera.zoom, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      mode = "pinch";
    } else {
      mode = moving ? "token" : event.button === 1 || event.shiftKey ? "pan" : "orbit";
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
        const ground = view.pickTerrain(at.x, at.y);
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
      endMove();
      press = null;
      void finishMove(move);
    } else if (move) {
      // Cancelled (or never really moved): Owlbear's drag, if it began, ends where it started.
      if (move.started) {
        void move.interaction?.then(([, stop]) => stop());
        live.delete(move.id);
        refresh();
      }
      endMove();
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
    if ("playerView" in change) {
      refresh();
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
    check("xray").checked = options.xray;
    check("edges").checked = options.edges;
    check("levels").checked = options.levels;
    check("grid").checked = options.grid;
    check("distances").checked = options.distances;
    check("rings").checked = options.rings;
    check("playerView").checked = options.playerView;
    check("ringFill").checked = options.ringFill;
    $<HTMLSelectElement>("tokenLabels").value = options.tokenLabels;
    $<HTMLSelectElement>("props").value = options.props;
    $<HTMLSelectElement>("wallStyle").value = options.wallStyle;
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
  check("levels").onchange = () => set({ levels: check("levels").checked });
  check("grid").onchange = () => set({ grid: check("grid").checked });
  check("distances").onchange = () => set({ distances: check("distances").checked });
  check("rings").onchange = () => set({ rings: check("rings").checked });
  check("playerView").onchange = () => set({ playerView: check("playerView").checked });
  check("ringFill").onchange = () => set({ ringFill: check("ringFill").checked });
  const wallStyle = $<HTMLSelectElement>("wallStyle");
  wallStyle.onchange = () => set({ wallStyle: wallStyle.value as Options["wallStyle"] });
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
  // On a hex grid, one cell's center: where its cells are drawn from (see useTexture).
  const findHexCenter = async () =>
    gridType === "HEX_HORIZONTAL" || gridType === "HEX_VERTICAL" ? await OBR.scene.grid.snapPosition({ x: 0, y: 0 }, 1, false, true) : null;
  let hexCenter = await findHexCenter().catch(() => null);
  let selection: string[] = (await OBR.player.getSelection()) ?? [];
  /** The token being dragged (here, or with the Medición tool): its rings stay where the drag began, as on the map. */
  let draggingId: string | null = null;
  /**
   * With one token selected, lines to every other token within a Banda —
   * the same readings as the Distancias panel (heights with the terrain).
   */
  const showDistances = () => {
    const origin = selection.length === 1 ? scene?.tokens.find((token) => token.id === selection[0]) : undefined;
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
      metric: bandSet.metric,
      hex: isHexShape(bandSet.shape) ? bandSet.shape : null,
      bands: bandSet.bands.map((band, index) => ({ reach: band.radius + tolerance, color: getColorString(theme.colors[index % theme.colors.length]) })),
    });
    showLines();
  };
  /** The distance lines from the selected token, where it is now. */
  const showLines = () => {
    const origin = selection.length === 1 ? scene?.tokens.find((token) => token.id === selection[0]) : undefined;
    if (!scene || !origin) {
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
      return from;
    }
    const x = token.x + position.x - token.item.position.x;
    const y = token.y + position.y - token.item.position.y;
    const moved = { ...token, x, y, own: own ?? token.own, terrain: from.measuredAt(x, y), item: { ...token.item, position } };
    return { ...from, tokens: from.tokens.map((t) => (t.id === tokenId ? moved : t)), heights: new Map(from.heights).set(tokenId, moved.terrain + moved.own) };
  }
  /** A token shown here at `position` (and `own` height, if given) before the scene says so. */
  function showTokenAt(tokenId: string, position: Vector2, own?: number) {
    if (!scene?.tokens.some((t) => t.id === tokenId)) {
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
  async function finishMove(move: NonNullable<typeof moving>) {
    try {
      if (move.started && move.interaction) {
        const [update, stop] = await move.interaction;
        // Snapped to the grid where it's let go, as Owlbear's own move does.
        const snapped = await OBR.scene.grid.snapPosition(move.position);
        move.position = snapped;
        const final = update((token) => {
          token.position = snapped;
        });
        try {
          // Along the way it was dragged, so the fog's walls don't stop it where it went around them (see dragPath.ts).
          for (const step of move.path.steps(final.position, dpi * 0.3)) {
            await OBR.scene.items.updateItems([final.id], (items) => {
              for (const item of items) {
                item.position = step;
              }
            });
          }
        } finally {
          stop();
        }
      }
      if (move.own !== move.startOwn) {
        await setTokenHeightMarker([{ ...move.item, position: move.position }], move.own);
      }
    } catch (error) {
      console.error("Rising Ranges: Vistazo couldn't save the moved token", error);
      refresh();
    }
  }

  // The fog, for the player view: Owlbear's setting, and this client's local items (Smoke & Spectre's lights and walls).
  let fogFilled = await OBR.scene.fog.getFilled().catch(() => false);
  let fogColor = await OBR.scene.fog.getColor().catch(() => "#222222");
  let localItems = await OBR.scene.local.getItems().catch(() => []);
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
  OBR.scene.local.onChange((next) => {
    localItems = next;
    const key = sightKey(next);
    if (key !== localSight) {
      localSight = key;
      if (options.playerView) {
        later();
      }
    }
  });

  const refresh = () => {
    try {
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
      scene = buildScene(
        sceneMetadata,
        items,
        dpi,
        scale,
        gridType,
        scene ?? undefined,
        hexCenter,
        options.playerView,
        fogNow ? { key: sightFogKey, clear: (world) => clearOf(fogNow, world) } : null
      );
      for (const [id, at] of live) {
        scene = placed(scene, id, at.position, at.own);
      }
      if (options.playerView) {
        // As a player sees it: what's under the fog, and what the GM hides, left out.
        const fog = lastFog!.at;
        scene = { ...scene, tokens: scene.tokens.filter((t) => live.has(t.id) || (!t.hidden && !fog(t.x, t.y))), props: scene.props.filter((p) => !fog(p.x, p.y)) };
      } else if (lastFog) {
        lastFog = null;
        fogKey = "";
        view.setFog(null);
      }
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
    hexCenter = await findHexCenter().catch(() => null);
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
      void (FULL ? OBR.modal.close(FULL_MODAL_ID) : OBR.action.close());
    }
  });

  refresh();
  // It opens from straight above and tilts up into 3D.
  // Coming from the other view (full screen or back): its camera, as it was. Otherwise it opens from
  // straight above and tilts up into 3D.
  const handed = takeCamera();
  if (handed) {
    Object.assign(camera, handed);
    view.apply();
  } else {
    setTimeout(() => animateTo(POSE, 1200), 250);
  }
}

OBR.onReady(() => {
  start().catch((error) => console.error("Rising Ranges: failed to open the Vistazo 3D", error));
});
