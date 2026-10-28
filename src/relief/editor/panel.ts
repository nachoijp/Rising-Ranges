import type { TranslationKey } from "../../i18n/translate";
import type { Group, ReliefData, Shape, StandEdge, UnderLook, WallLook } from "../types";
import { corners } from "../stand";
import { HEIGHT_LIMIT, quarter } from "../relief";
import { BRUSHES, type BrushKind } from "./brush";
import type { PickMode, ReliefEditor, RollerMode, ToolId } from "./editor";
import { icon, type IconName } from "./icons";
import { ancestors, groupsOf, membersOf, moveItem, pickGroup, toggleGroup, type ListDrop, type ListItem } from "./groups";
import { PREFABS, type PrefabId } from "./prefabs";
import { combine, defaultRamp, setKind, setRel, setType, togglePick, type Combine, type ShapeType } from "./shapes";

// The editor's pieces over the map, as Owlbear's own: the tools in a column,
// the tool's options in the bar at the top, what's picked in a panel at the
// right (only while something is), the shapes' list at the bottom left, and
// right-click menus. What things do is told on the pointer (tooltips), not
// written out. Plain DOM: rebuilt whenever what's picked or the tool changes.

export type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

type ToolDef = { id: ToolId; icon: IconName; key: string; keys: [TranslationKey, TranslationKey][] };

const DRAWN: [TranslationKey, TranslationKey][] = [
  ["relief.key.handles", "relief.key.handlesDo"],
  ["relief.key.turnHandle", "relief.key.turnHandleDo"],
  ["relief.key.duplicate", "relief.key.duplicateDo"],
  ["relief.key.arrows", "relief.key.arrowsDo"],
  ["relief.key.escape", "relief.key.escapeDo"],
];
const boxed = (what: TranslationKey): [TranslationKey, TranslationKey][] => [["relief.key.shiftDrag", what], ["relief.key.altDrag", "relief.key.altDragDo"], ...DRAWN];

/** The tools, in the column's order; null between groups. */
export const TOOLS: (ToolDef | null)[] = [
  {
    id: "edit",
    icon: "select",
    key: "v",
    keys: [
      ["relief.key.ctrlClick", "relief.key.ctrlClickDo"],
      ["relief.key.ctrlG", "relief.key.ctrlGDo"],
      ["relief.key.ctrlShiftG", "relief.key.ctrlShiftGDo"],
      ["relief.key.clickSide", "relief.key.clickSideDo"],
      ["relief.key.dblInclined", "relief.key.dblInclinedDo"],
      ["relief.key.altClick", "relief.key.altClickDo"],
      ["relief.key.arrowEnds", "relief.key.arrowEndsDo"],
      ["relief.key.dragEmpty", "relief.key.dragEmptyDo"],
      ["relief.key.zx", "relief.key.zxDo"],
      ...DRAWN.slice(0, 4),
      ["relief.key.delete", "relief.key.deleteDo"],
      ["relief.key.escape", "relief.key.escapeDo"],
    ],
  },
  {
    id: "cut",
    icon: "cut",
    key: "k",
    keys: [
      ["relief.key.onePicked", "relief.key.onePickedDo"],
      ["relief.key.shift", "relief.key.by15Do"],
    ],
  },
  null,
  { id: "rect", icon: "rect", key: "r", keys: boxed("relief.key.square") },
  { id: "ellipse", icon: "ellipse", key: "e", keys: boxed("relief.key.circle") },
  { id: "lasso", icon: "lasso", key: "l", keys: DRAWN },
  {
    id: "polygon",
    icon: "pen",
    key: "p",
    keys: [
      ["relief.key.shift", "relief.key.freeDo"],
      ["relief.key.backspace", "relief.key.backspaceDo"],
      ["relief.key.escape", "relief.key.cancelDo"],
    ],
  },
  {
    id: "paintShape",
    icon: "roller",
    key: "f",
    keys: [
      ["relief.key.touching", "relief.key.touchingDo"],
      ["relief.key.alt", "relief.key.altCutsDo"],
      ["relief.key.ring", "relief.key.ringDo"],
      ["relief.key.escape", "relief.key.escapeNewDo"],
    ],
  },
  {
    id: "stamp",
    icon: "stamp",
    key: "t",
    keys: [["relief.key.clickPlace", "relief.key.clickPlaceDo"]],
  },
  null,
  {
    id: "brush",
    icon: "brush",
    key: "b",
    keys: [
      ["relief.key.digits", "relief.key.digitsDo"],
      ["relief.key.ctrlPaint", "relief.key.ctrlPaintDo"],
      ["relief.key.altFlatten", "relief.key.altFlattenDo"],
    ],
  },
];
export const TOOL_LIST = TOOLS.filter((tool): tool is ToolDef => tool !== null);

/** The tools that make a shape: one button in the column ("Dibujar"), showing the last of them used. */
const DRAW_TOOLS: ToolId[] = ["rect", "ellipse", "lasso", "polygon", "paintShape", "stamp"];
let lastDraw: ToolId = "rect";
/** How long (ms) the "Dibujar" button is held for its menu to open. */
const HOLD_MS = 400;

/** Keys for everything, whatever the tool. */
export const GENERAL_KEYS: [TranslationKey, TranslationKey][] = [
  ["relief.key.undo", "relief.key.undoDo"],
  ["relief.key.redo", "relief.key.redoDo"],
  ["relief.key.delete", "relief.key.deleteDo"],
  ["relief.key.duplicate", "relief.key.duplicateDo"],
  ["relief.key.rename", "relief.key.renameDo"],
  ["relief.key.layers", "relief.key.layersDo"],
  ["relief.key.zx", "relief.key.zxDo"],
];

const toolLabel = (id: ToolId) => `relief.tool.${id}` as TranslationKey;
const toolHint = (id: ToolId) => `relief.tool.${id}Hint` as TranslationKey;

/** Text put in HTML as text. */
export const esc = (text: string) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmt = (h: number) => (Math.round(h * 100) / 100).toString();
const signed = (h: number) => (h > 0 ? `+${fmt(h)}` : fmt(h));

/** A shape's name: its own, or its place. */
export const nameOf = (t: T, s: Shape, i: number) => s.name || t("relief.shape.name", { n: i + 1 });

// ---------- Tooltips ----------

/** What something is, on the pointer and read out: its name, its key, a line of what it does. */
export const tip = (title: string, sub = "", key = "", side: "below" | "right" = "below") =>
  `data-tip="${esc(title)}"${sub ? ` data-tip-sub="${esc(sub)}"` : ""}${key ? ` data-tip-key="${esc(key)}"` : ""}${side === "right" ? ' data-tip-side="right"' : ""} aria-label="${esc(sub ? `${title}. ${sub}` : title)}"`;

/** The one tooltip of the editor, shown by whatever has `data-tip` under the pointer (or focused from the keyboard). */
export function installTips(root: HTMLElement): () => void {
  const box = document.createElement("div");
  box.className = "re-tip";
  box.hidden = true;
  root.append(box);
  let shown: HTMLElement | null = null;
  const show = (el: HTMLElement | null) => {
    if (el === shown) {
      return;
    }
    shown = el;
    if (!el) {
      box.hidden = true;
      return;
    }
    const key = el.dataset.tipKey ? `<span class="key">${esc(el.dataset.tipKey)}</span>` : "";
    const sub = el.dataset.tipSub ? `<span class="sub">${esc(el.dataset.tipSub)}</span>` : "";
    box.innerHTML = `<b>${esc(el.dataset.tip ?? "")}</b>${key}${sub}`;
    box.hidden = false;
    const r = el.getBoundingClientRect();
    const area = root.getBoundingClientRect();
    const [w, h] = [box.offsetWidth, box.offsetHeight];
    let [x, y] = el.dataset.tipSide === "right" ? [r.right + 8, r.top + (r.height - h) / 2] : [r.left + (r.width - w) / 2, r.bottom + 6];
    // Kept within the editor; above, if there's no room below.
    if (y + h > area.bottom - 4) {
      y = r.top - h - 6;
    }
    x = Math.max(area.left + 4, Math.min(area.right - w - 4, x));
    box.style.left = `${x - area.left}px`;
    box.style.top = `${y - area.top}px`;
  };
  const over = (event: Event) => show((event.target as HTMLElement).closest<HTMLElement>("[data-tip]"));
  const hide = () => show(null);
  root.addEventListener("pointerover", over);
  root.addEventListener("focusin", over);
  root.addEventListener("pointerdown", hide);
  root.addEventListener("pointerleave", hide);
  root.addEventListener("focusout", hide);
  return () => {
    box.remove();
    root.removeEventListener("pointerover", over);
    root.removeEventListener("focusin", over);
    root.removeEventListener("pointerdown", hide);
    root.removeEventListener("pointerleave", hide);
    root.removeEventListener("focusout", hide);
  };
}

// ---------- Menus ----------

export type MenuItem =
  | "-"
  | {
      icon?: IconName;
      label: string;
      key?: string;
      run?: () => void;
      /** A menu of its own, opened beside it. */
      items?: MenuItem[];
      disabled?: boolean;
      /** Kept open after it runs (a second click to be sure). */
      keep?: boolean;
    };

let openMenus: HTMLElement[] = [];

export function closeMenus() {
  for (const menu of openMenus) {
    menu.remove();
  }
  openMenus = [];
}

/** A menu at (x, y) within `root` (px from its corner), as Owlbear's; gone on a click elsewhere or Esc. */
export function openMenu(root: HTMLElement, x: number, y: number, items: MenuItem[], level = 0): HTMLElement {
  if (level === 0) {
    closeMenus();
  } else {
    openMenus.splice(level).forEach((menu) => menu.remove());
  }
  const menu = document.createElement("div");
  menu.className = "re-menu glass";
  menu.setAttribute("role", "menu");
  const draw = () => {
    menu.innerHTML = items
      .map((item, i) =>
        item === "-"
          ? '<div class="sep" role="separator"></div>'
          : `<button type="button" role="menuitem" class="mi${item.items ? " more" : ""}" data-i="${i}" ${item.disabled ? "disabled" : ""}>${item.icon ? icon(item.icon) : '<span class="ri"></span>'}<span class="ml">${esc(item.label)}</span>${item.key ? `<span class="mk">${esc(item.key)}</span>` : ""}</button>`
      )
      .join("");
  };
  draw();
  root.append(menu);
  openMenus.push(menu);
  const area = root.getBoundingClientRect();
  const [w, h] = [menu.offsetWidth, menu.offsetHeight];
  menu.style.left = `${Math.max(4, Math.min(area.width - w - 4, x))}px`;
  menu.style.top = `${Math.max(4, Math.min(area.height - h - 4, y))}px`;
  menu.onclick = (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button.mi");
    const item = button ? items[Number(button.dataset.i)] : null;
    if (!item || item === "-" || item.disabled) {
      return;
    }
    if (item.items) {
      const r = button!.getBoundingClientRect();
      openMenu(root, r.right - area.left + 2, r.top - area.top - 4, item.items, level + 1);
      return;
    }
    item.run?.();
    if (item.keep) {
      draw();
    } else {
      closeMenus();
    }
  };
  menu.onpointerover = (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button.mi");
    const item = button ? items[Number(button.dataset.i)] : null;
    if (item && item !== "-" && item.items && !item.disabled) {
      const r = button!.getBoundingClientRect();
      openMenu(root, r.right - area.left + 2, r.top - area.top - 4, item.items, level + 1);
    }
  };
  (menu.querySelector("button.mi:not([disabled])") as HTMLButtonElement | null)?.focus({ preventScroll: true });
  return menu;
}

// ---------- The pieces ----------

/** Icon buttons side by side, one of them on: [value, icon, name, what it does?]. */
const seg = (name: string, options: [string, IconName, string, string?][], value: string) =>
  `<span class="seg" role="group" data-seg="${name}">${options
    .map(([v, ic, label, sub]) => `<button type="button" class="ib sm${v === value ? " on" : ""}" data-v="${v}" aria-pressed="${v === value}" ${tip(label, sub)}>${icon(ic)}</button>`)
    .join("")}</span>`;

/** What a row of buttons does when one is pressed. */
function onSeg(el: HTMLElement, name: string, f: (v: string) => void) {
  for (const button of el.querySelectorAll<HTMLButtonElement>(`[data-seg="${name}"] button`)) {
    button.onclick = () => {
      if (!button.classList.contains("on")) {
        f(button.dataset.v!);
      }
    };
  }
}

/**
 * How a slider shows its value: always as many decimals as its step has (1.00, 1.25, 1.50), so they
 * don't come and go as it's moved; and room for its longest (in ch, with tabular digits), so the width
 * of what shows it doesn't change either and move what's beside.
 */
type SliderValue = { format: (v: number) => string; width: string };
function sliderValue(input: HTMLInputElement): SliderValue {
  const steps = stepsOf(input);
  if (steps) {
    return { format: fmt, width: `${Math.max(...steps.map((v) => fmt(v).length))}ch` };
  }
  const min = Number(input.min);
  const max = Number(input.max);
  const step = Number(input.step) || 1;
  const decimals = (String(step).split(".")[1] ?? "").length;
  const format = (v: number) => v.toFixed(decimals);
  let longest = 1;
  for (let i = 0, v = min; v <= max + 1e-9 && i < 1000; i++, v = min + i * step) {
    longest = Math.max(longest, format(v).length);
  }
  return { format, width: `${longest}ch` };
}

/** The same, from a slider's HTML (see rangeHtml), for its button in the bar and the box under it. */
const sliderValues = new Map<string, SliderValue>();
function sliderValueOf(html: string): SliderValue {
  let value = sliderValues.get(html);
  if (!value) {
    const box = document.createElement("template");
    box.innerHTML = html;
    const input = box.content.querySelector<HTMLInputElement>('input[type="range"]');
    value = input ? sliderValue(input) : { format: fmt, width: "auto" };
    sliderValues.set(html, value);
  }
  return value;
}

/** A slider's own stops (`data-steps`: values not evenly apart, its positions their indexes), if it has them. */
const stepsOf = (input: HTMLInputElement) => (input.dataset.steps ? input.dataset.steps.split(",").map(Number) : null);

/** Where a slider stands for a value (with stops, the nearest one's; the value read out, not its place). */
function toSlider(input: HTMLInputElement, v: number): string {
  const steps = stepsOf(input);
  if (!steps) {
    return String(v);
  }
  input.setAttribute("aria-valuetext", fmt(v));
  const k = steps.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(steps[best] - v) ? i : best), 0);
  return String(k);
}

/** The value where a slider stands (with stops, read out as it). */
function fromSlider(input: HTMLInputElement): number {
  const steps = stepsOf(input);
  if (!steps) {
    return Number(input.value);
  }
  const v = steps[Math.round(Number(input.value))];
  input.setAttribute("aria-valuetext", fmt(v));
  return v;
}

/** A slider, set as it's moved; `done` after each move. */
function bindRange(el: HTMLElement, key: string, get: () => number, set: (v: number) => void, done: () => void) {
  const input = el.querySelector<HTMLInputElement>(`[data-k="${key}"]`);
  if (!input) {
    return;
  }
  const show = el.querySelector<HTMLElement>(`[data-v="${key}"]`);
  input.value = toSlider(input, get());
  const shown = sliderValue(input);
  if (show) {
    show.style.minWidth = shown.width;
    show.textContent = shown.format(get());
  }
  input.oninput = () => {
    set(fromSlider(input));
    if (show) {
      show.textContent = shown.format(fromSlider(input));
    }
    done();
  };
}

/**
 * A step to undo taken once, at the first change after it's armed (entering
 * a field, pressing a slider): only entering it, nothing to undo.
 */
function undoOnce(ed: ReliefEditor) {
  let armed = true;
  return {
    arm: () => (armed = true),
    take: () => {
      if (armed) {
        ed.pushUndo();
        armed = false;
      }
    },
  };
}

/** A shape's name: as long as it can be. */
export const NAME_MAX = 40;

/**
 * A number field: text (not the browser's number field: its arrows, and what
 * it lets be typed, differ from one to another) that takes only a number's
 * characters, kept between its limits.
 */
const numField = (key: string, label: string, min: number, max: number, int = false) =>
  `<input type="text" class="num" inputmode="${int ? "numeric" : "decimal"}" maxlength="8" autocomplete="off" spellcheck="false" data-k="${key}" data-min="${min}" data-max="${max}"${int ? " data-int" : ""} aria-label="${esc(label)}" />`;

/** A height's field: ±HEIGHT_LIMIT. */
const heightField = (key: string, label: string) => numField(key, label, -HEIGHT_LIMIT, HEIGHT_LIMIT);

/** A value kept within a field's limits. */
function within(input: HTMLInputElement, v: number): number {
  const [min, max] = [Number(input.dataset.min ?? -Infinity), Number(input.dataset.max ?? Infinity)];
  const n = input.dataset.int !== undefined ? Math.round(v) : v;
  return Math.max(min, Math.min(max, n));
}

/** What's typed in a number field, cleaned (only a number's characters; a comma a point): its number, or null while it isn't one yet. */
function readNumber(input: HTMLInputElement): number | null {
  const int = input.dataset.int !== undefined;
  const min = Number(input.dataset.min ?? -Infinity);
  let text = input.value.replace(/,/g, ".").replace(int ? /[^\d-]/g : /[^\d.-]/g, "");
  // A minus only first (and only where it can be), a point only once.
  text = (text.startsWith("-") && min < 0 ? "-" : "") + text.replace(/-/g, "");
  const dot = text.indexOf(".");
  if (dot >= 0) {
    text = text.slice(0, dot + 1) + text.slice(dot + 1).replace(/\./g, "");
  }
  if (text !== input.value) {
    const at = Math.max(0, (input.selectionStart ?? text.length) - (input.value.length - text.length));
    input.value = text;
    input.setSelectionRange(at, at);
  }
  const v = Number(text);
  return text === "" || text === "-" || text === "." || text === "-." || !Number.isFinite(v) ? null : within(input, v);
}

/** A number field: the relief changed as it's typed, a step to undo from its first change. */
function bindNumber(el: HTMLElement, ed: ReliefEditor, key: string, get: () => number, set: (v: number) => void) {
  const input = el.querySelector<HTMLInputElement>(`[data-k="${key}"]`);
  if (!input) {
    return;
  }
  input.value = String(get());
  const step = undoOnce(ed);
  input.onfocus = step.arm;
  input.oninput = () => {
    const v = readNumber(input);
    if (v !== null) {
      step.take();
      set(v);
      ed.changed();
    }
  };
  // Left: what it is (within its limits, or as it was if it was left empty).
  input.onchange = () => (input.value = String(get()));
}

/** A number in its box with − and + (no browser arrows), each a step of `by`; `extra`: what else sets it, in the box past a line. */
const stepper = (field: string, key: string, by: number, t: T, extra = "") =>
  `<span class="numbox">${field}<button type="button" class="ib sm" data-by="${-by}" data-for="${key}" ${tip(t("relief.less"))}>${icon("minus")}</button><button type="button" class="ib sm" data-by="${by}" data-for="${key}" ${tip(t("relief.plus"))}>${icon("plus")}</button>${extra ? `<span class="nsep"></span>${extra}` : ""}</span>`;

/** A stepper's field, and its −/+ (each a step to undo, when it changes anything). */
function bindStepper(el: HTMLElement, ed: ReliefEditor, key: string, get: () => number, set: (v: number) => void) {
  bindNumber(el, ed, key, get, set);
  const input = el.querySelector<HTMLInputElement>(`[data-k="${key}"]`);
  if (!input) {
    return;
  }
  for (const button of el.querySelectorAll<HTMLButtonElement>(`[data-for="${key}"]`)) {
    button.onclick = () => {
      // Tried first: nothing changed (at its least, or its most), no step to undo.
      const before = get();
      const next = within(input, before + Number(button.dataset.by));
      set(next);
      const after = get();
      if (after === before) {
        return;
      }
      set(before);
      ed.pushUndo();
      set(next);
      input.value = String(after);
      ed.changed();
    };
  }
}

/** A soft edge's widths (cells), finer where it's narrow: its slider's stops. */
export const SOFT_STEPS = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

/** A slider from a wall (0) to a soft edge, an icon at each end. */
const edgeSlider = (t: T, key: string) =>
  `<span class="slider"><span class="end" ${tip(t("relief.edge.wall"), t("relief.edge.wallHint"))}>${icon("edge-wall")}</span><input type="range" min="0" max="${SOFT_STEPS.length - 1}" step="1" data-steps="${SOFT_STEPS}" data-k="${key}" aria-label="${esc(t("relief.shape.edge"))}" /><span class="end" ${tip(t("relief.edge.soft"), t("relief.edge.softHint"))}>${icon("edge-soft")}</span></span>`;

// ---------- Tools ----------

/**
 * The tools' column: an icon each, its name, key and what it does on the pointer. The shape tools
 * share one button, the last of them used: a click takes it, and held (or clicked with it in hand,
 * or right-clicked) it opens the menu of all of them, `menu` opening it beside it.
 */
export function renderTools(el: HTMLElement, ed: ReliefEditor, t: T, onTool: (id: ToolId) => void, menu: (button: HTMLElement, items: MenuItem[]) => void) {
  if (DRAW_TOOLS.includes(ed.tool)) {
    lastDraw = ed.tool;
  }
  const button = (tool: ToolDef, group: boolean) =>
    `<button type="button" class="ib${ed.tool === tool.id ? " on" : ""}${group ? " group" : ""}" data-tool="${tool.id}" aria-pressed="${ed.tool === tool.id}"${group ? ' aria-haspopup="menu"' : ""} ${tip(t(toolLabel(tool.id)), group ? `${t(toolHint(tool.id))} ${t("relief.drawMore")}` : t(toolHint(tool.id)), tool.key.toUpperCase(), "right")}>${icon(tool.icon)}</button>`;
  el.innerHTML = TOOLS.map((tool) =>
    tool === null
      ? '<div class="hsep" role="separator"></div>'
      : DRAW_TOOLS.includes(tool.id)
        ? tool.id === DRAW_TOOLS[0]
          ? button(TOOL_LIST.find((x) => x.id === lastDraw)!, true)
          : ""
        : button(tool, false)
  ).join("");
  const drawMenu = (): MenuItem[] =>
    TOOL_LIST.filter((tool) => DRAW_TOOLS.includes(tool.id)).map((tool) => ({
      icon: tool.icon,
      label: ed.tool === tool.id ? `${t(toolLabel(tool.id))} ✓` : t(toolLabel(tool.id)),
      key: tool.key.toUpperCase(),
      run: () => onTool(tool.id),
    }));
  for (const b of el.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
    if (!b.classList.contains("group")) {
      b.onclick = () => onTool(b.dataset.tool as ToolId);
      continue;
    }
    // Held: the menu, and the click that ends the press does nothing more.
    let timer = 0;
    let held = false;
    // Its menu open at the press (closed by it, see session's outside): the click only closes it.
    let wasOpen = false;
    b.onpointerdown = () => {
      held = false;
      wasOpen = !!document.querySelector(".re-menu");
      timer = window.setTimeout(() => {
        held = true;
        menu(b, drawMenu());
      }, HOLD_MS);
    };
    b.onpointerup = b.onpointerleave = () => clearTimeout(timer);
    b.onclick = () => {
      // Once: a keyboard click has no press before it.
      const skip = held || wasOpen;
      held = wasOpen = false;
      if (skip) {
        return;
      }
      if (ed.tool === lastDraw) {
        menu(b, drawMenu());
      } else {
        onTool(lastDraw);
      }
    };
    b.oncontextmenu = (event) => {
      event.preventDefault();
      clearTimeout(timer);
      menu(b, drawMenu());
    };
  }
}

/** The tools as a menu (the column's stand-in on a narrow map). */
export function toolsMenu(ed: ReliefEditor, t: T, onTool: (id: ToolId) => void): MenuItem[] {
  return TOOLS.map((tool): MenuItem =>
    tool === null
      ? "-"
      : { icon: tool.icon, label: ed.tool === tool.id ? `${t(toolLabel(tool.id))} ✓` : t(toolLabel(tool.id)), key: tool.key.toUpperCase(), run: () => onTool(tool.id) }
  );
}

/** The tool in hand, as the button that opens that menu shows it. */
export function toolButton(ed: ReliefEditor, t: T): string {
  const tool = TOOL_LIST.find((x) => x.id === ed.tool)!;
  return `${icon(tool.icon)}<span class="sr">${esc(t(toolLabel(tool.id)))}</span>`;
}

/** Every key of the tool in hand, and those for everything. */
export function shortcutsHtml(ed: ReliefEditor, t: T): string {
  const tool = TOOL_LIST.find((x) => x.id === ed.tool)!;
  const list = (keys: [TranslationKey, TranslationKey][]) => keys.map(([k, v]) => `<dt>${esc(t(k))}</dt><dd>${esc(t(v))}</dd>`).join("");
  return `<p class="ptitle">${esc(t(toolLabel(tool.id)))} <span class="key">${tool.key.toUpperCase()}</span></p><dl>${list(tool.keys)}</dl>
    <p class="ptitle">${esc(t("relief.shortcutsAll"))}</p><dl>${list(GENERAL_KEYS)}</dl>`;
}

// ---------- What the keys do now (the chip over the map) ----------

/**
 * What's being done right now measured (a rectangle's size, how far what's dragged went, a side of an
 * outline being clicked), cells and the scene's measure (`unit`): empty when nothing is.
 */
function measureOf(ed: ReliefEditor, t: T, unit: (cells: number) => string): string {
  const length = (d: number) => `${fmt(d)} (${unit(d)})`;
  if (ed.shape?.origin && (ed.tool === "rect" || ed.tool === "ellipse")) {
    const [w, h] = [Math.abs(ed.shape.end.x - ed.shape.start.x), Math.abs(ed.shape.end.y - ed.shape.start.y)];
    return t("relief.measure.size", { w: fmt(w), h: fmt(h), uw: unit(w), uh: unit(h) });
  }
  if (ed.drawing?.length && ed.cursor) {
    const last = ed.data.verts[ed.drawing[ed.drawing.length - 1]];
    return last ? t("relief.measure.side", { d: length(Math.hypot(ed.cursor.x - last.x, ed.cursor.y - last.y)) }) : "";
  }
  if (ed.stroke) {
    return t("relief.measure.width", { d: length(ed.settings.shapeRadius * 2) });
  }
  const m = ed.xf ? ed.xfMap : null;
  if (ed.xf && m) {
    if (ed.xf.kind === "move") {
      return t("relief.measure.moved", { d: length(Math.hypot(m[4], m[5])) });
    }
    if (ed.xf.kind === "rotate") {
      return t("relief.measure.turned", { a: String(Math.round((Math.atan2(m[1], m[0]) * 180) / Math.PI)) });
    }
    return t("relief.measure.scaled", { k: fmt(Math.round(Math.hypot(m[0], m[1]) * 100) / 100) });
  }
  const moved = ed.dragMoved();
  return moved !== null ? t("relief.measure.moved", { d: length(moved) }) : "";
}

/**
 * What the keys do in what's being done right now (a rectangle being drawn,
 * an outline being clicked, the brush painting...), with its measure first,
 * as a line: empty when nothing is.
 */
export function liveHint(ed: ReliefEditor, t: T, unit: (cells: number) => string = fmt): string {
  const measure = measureOf(ed, t, unit);
  const keys = keysHint(ed, t);
  return measure && keys ? `${measure}  ·  ${keys}` : measure || keys;
}

/** What the keys do in what's being done right now (see liveHint). */
function keysHint(ed: ReliefEditor, t: T): string {
  const pairs = (list: [TranslationKey, TranslationKey][]) => list.map(([k, v]) => `${t(k)}: ${t(v)}`).join(" · ");
  if (ed.skinPick !== null) {
    return `${t("relief.shape.picking")} · ${t("relief.key.escape")}: ${t("relief.key.cancelDo")}`;
  }
  if (ed.shape) {
    if (ed.tool === "rect") {
      return pairs([["relief.key.shiftDrag", "relief.key.square"], ["relief.key.altDrag", "relief.key.altDragDo"]]);
    }
    if (ed.tool === "ellipse") {
      return pairs([["relief.key.shiftDrag", "relief.key.circle"], ["relief.key.altDrag", "relief.key.altDragDo"]]);
    }
    return "";
  }
  if (ed.drawing) {
    return pairs([
      ["relief.key.close", "relief.key.closeDo"],
      ["relief.key.backspace", "relief.key.backspaceDo"],
      ["relief.key.shift", "relief.key.freeDo"],
      ["relief.key.escape", "relief.key.cancelDo"],
    ]);
  }
  if (ed.stroke) {
    return ed.settings.rollerMode === "cut" ? "" : pairs([["relief.key.alt", "relief.key.altCutsDo"]]);
  }
  if (ed.knife) {
    return pairs([["relief.key.shift", "relief.key.by15Do"]]);
  }
  if (ed.xf && ed.xf.kind !== "move") {
    return pairs([["relief.key.shift", ed.xf.kind === "rotate" ? "relief.key.by15Do" : "relief.key.proportionDo"]]);
  }
  if (ed.levelPick) {
    return t("relief.brush.levelPickHint");
  }
  if (ed.brushing) {
    return pairs(ed.settings.brushMode === "flatten" ? [["relief.key.altFlatten", "relief.key.altFlattenDo"]] : [["relief.key.ctrlPaint", "relief.key.ctrlPaintDo"]]);
  }
  // Picking vertices, the pointer still: what a click adds there (a vertex on a side, a height point inside an inclined shape).
  if (ed.tool === "edit" && ed.settings.pickMode !== "shapes" && !ed.drag && !ed.box) {
    if (ed.ghost) {
      return pairs([["relief.key.clickSide", "relief.key.clickSideDo"]]);
    }
    const s = ed.data.shapes[ed.hover];
    const focus = ed.focusShapes();
    if (s && (!focus || focus.has(ed.hover))) {
      return s.kind === "slope" ? pairs([["relief.key.dblInclined", "relief.key.dblInclinedDo"], ["relief.key.altClick", "relief.key.altClickDo"]]) : focus ? t("relief.key.pointsNeedInclined") : "";
    }
  }
  return "";
}

// ---------- The tool's options (the top bar's middle) ----------

/** A slider kept under the bar: its button in the bar shows its name and value, a click opens it. */
type Under = { html: string; get: () => number; set: (v: number) => void };

/** The slider open under the bar (its key), kept through the bar's redraws. */
let underOpen: string | null = null;

/** A slider's button in the bar: its icon, its name (dropped when the bar is narrow) and its value. */
const underButton = (key: string, ic: IconName, label: string, hint = "", keys = "") =>
  `<button type="button" class="field under" data-under="${key}" aria-expanded="false" ${tip(label, hint, keys)}>${icon(ic)}<span class="pl">${esc(label)}</span><span class="pv" data-v="${key}"></span>${icon("expand")}</button>`;

const rangeHtml = (key: string, label: string, min: number, max: number, step: number) =>
  `<span class="slider"><input type="range" min="${min}" max="${max}" step="${step}" data-k="${key}" aria-label="${esc(label)}" /><span class="sv" data-v="${key}"></span></span>`;

/** The box under the bar, made the first time. */
function underBox(ui: HTMLElement): HTMLElement {
  let box = ui.querySelector<HTMLElement>(":scope > .re-under");
  if (!box) {
    box = document.createElement("div");
    box.className = "re-under glass";
    box.hidden = true;
    ui.append(box);
    // A press anywhere else, or Esc, closes it.
    document.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target as Element | null;
        if (!box!.hidden && !box!.contains(target) && !target?.closest?.("[data-under]")) {
          closeUnder(ui);
        }
      },
      true
    );
    box.addEventListener("keydown", (event) => {
      if (event.key === "Escape" || event.key === "Enter") {
        event.stopPropagation();
        event.preventDefault();
        const key = underOpen;
        closeUnder(ui);
        ui.querySelector<HTMLElement>(`[data-under="${key}"]`)?.focus();
      }
    });
  }
  return box;
}

function closeUnder(ui: HTMLElement) {
  underOpen = null;
  const box = ui.querySelector<HTMLElement>(":scope > .re-under");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
  for (const button of ui.querySelectorAll<HTMLElement>("[data-under]")) {
    button.classList.remove("on");
    button.setAttribute("aria-expanded", "false");
  }
}

/** The bar's slider buttons: their values, a click opening (or closing) each; the one open kept open. */
function bindUnders(el: HTMLElement, unders: Record<string, Under>, saved: () => void) {
  const ui = el.closest<HTMLElement>(".re-ui");
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-under]")) {
    const key = button.dataset.under!;
    const u = unders[key];
    const value = button.querySelector<HTMLElement>(".pv")!;
    const shown = sliderValueOf(u.html);
    value.style.minWidth = shown.width;
    value.textContent = shown.format(u.get());
    button.onclick = () => {
      if (!ui) {
        return;
      }
      if (underOpen === key) {
        closeUnder(ui);
      } else {
        openUnder(ui, button, key, u, saved);
      }
    };
  }
  if (!ui) {
    return;
  }
  const open = underOpen;
  const button = open ? el.querySelector<HTMLButtonElement>(`[data-under="${open}"]`) : null;
  if (!open || !button) {
    closeUnder(ui);
    return;
  }
  const box = underBox(ui);
  if (box.dataset.key === open && !box.hidden) {
    // Already open: only its value (the slider may be in hand).
    const input = box.querySelector<HTMLInputElement>("input")!;
    const u = unders[open];
    if (document.activeElement !== input) {
      input.value = toSlider(input, u.get());
      box.querySelector<HTMLElement>(".sv")!.textContent = sliderValueOf(u.html).format(u.get());
    }
    button.classList.add("on");
    button.setAttribute("aria-expanded", "true");
    place(ui, box, button);
  } else {
    openUnder(ui, button, open, unders[open], saved);
  }
}

function openUnder(ui: HTMLElement, button: HTMLElement, key: string, u: Under, saved: () => void) {
  closeUnder(ui);
  underOpen = key;
  const box = underBox(ui);
  box.dataset.key = key;
  box.innerHTML = u.html;
  box.hidden = false;
  button.classList.add("on");
  button.setAttribute("aria-expanded", "true");
  bindRange(box, key, u.get, u.set, () => {
    saved();
    const value = ui.querySelector<HTMLElement>(`[data-under="${key}"] .pv`);
    if (value) {
      value.textContent = sliderValueOf(u.html).format(u.get());
    }
  });
  place(ui, box, button);
  box.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
}

/** The slider open under the bar, put back under its button (the bar laid out again). */
export function placeUnder(ui: HTMLElement) {
  const box = ui.querySelector<HTMLElement>(":scope > .re-under");
  const button = underOpen ? ui.querySelector<HTMLElement>(`[data-under="${underOpen}"]`) : null;
  if (box && !box.hidden && button) {
    place(ui, box, button);
  }
}

/** Under the bar, centred on its button, inside the map. */
function place(ui: HTMLElement, box: HTMLElement, button: HTMLElement) {
  const area = ui.getBoundingClientRect();
  const b = button.getBoundingClientRect();
  const bar = button.closest(".re-top, .re-optbar")?.getBoundingClientRect() ?? b;
  const left = b.left + b.width / 2 - box.offsetWidth / 2 - area.left;
  box.style.left = `${Math.max(8, Math.min(area.width - box.offsetWidth - 8, left))}px`;
  box.style.top = `${bar.bottom - area.top + 6}px`;
}

export function renderOptions(el: HTMLElement, ed: ReliefEditor, t: T) {
  const s = ed.settings;
  const saved = () => ed.host.saveSettings();
  const unders: Record<string, Under> = {};
  // Taking a shape's texture from the map: that, whatever the tool, till it's done or let go.
  if (ed.skinPick !== null) {
    const s = ed.data.shapes[ed.skinPick];
    el.innerHTML = `${icon("texture")}<span class="opt-label">${esc(t("relief.taking", { name: s ? nameOf(t, s, ed.skinPick) : "" }))}</span><button type="button" class="field" data-k="cancelSkin" ${tip(t("relief.key.cancelDo"), "", "Esc")}>${esc(t("relief.cancel"))}</button>`;
    el.querySelector<HTMLButtonElement>('[data-k="cancelSkin"]')!.onclick = () => {
      ed.skinPick = null;
      ed.skinBox = null;
      ed.host.showProps();
      ed.host.redraw();
    };
    bindUnders(el, unders, saved);
    return;
  }
  if (ed.tool === "edit") {
    el.innerHTML = seg(
      "pick",
      [
        ["shapes", "pick-shapes", t("relief.pick.shapes"), t("relief.pick.shapesHint")],
        ["points", "pick-points", t("relief.pick.points"), t("relief.pick.pointsHint")],
      ],
      s.pickMode === "points" ? "points" : "shapes"
    );
    onSeg(el, "pick", (v) => {
      s.pickMode = v as PickMode;
      saved();
      ed.host.showProps();
      ed.host.redraw();
    });
    bindUnders(el, unders, saved);
    return;
  }
  if (ed.tool === "brush") {
    const modes = BRUSHES.map((b, i): [string, IconName, string, string] => [b, b as IconName, `${t(`relief.brush.${b}` as TranslationKey)} (${i + 1})`, t(`relief.brush.${b}Text` as TranslationKey)]);
    unders.radius = { html: rangeHtml("radius", t("relief.size"), 0.25, 6, 0.25), get: () => s.radius, set: (v) => (s.radius = v) };
    unders.strength = { html: rangeHtml("strength", t("relief.brush.strength"), 0.1, 2, 0.1), get: () => s.strength, set: (v) => (s.strength = v) };
    el.innerHTML = `${seg("mode", modes, s.brushMode)}
      ${underButton("radius", "size", t("relief.size"), "", "[ ]")}
      ${
        s.brushMode === "flatten"
          ? // The level: −/+ round the number, the eyedropper inside its box (it takes the number from the map).
            `<span class="sl" ${tip(t("relief.height"), t("relief.brush.levelHint"))}>${esc(t("relief.height"))}</span>${stepper(heightField("level", t("relief.height")), "level", 0.5, t, `<button type="button" class="ib sm pick${ed.levelPick ? " on" : ""}" data-k="levelPick" aria-pressed="${ed.levelPick}" ${tip(t("relief.brush.levelPick"), t("relief.brush.levelPickHint"), "Alt+clic")}>${icon("eyedropper")}</button>`)}`
          : underButton("strength", "strength", t("relief.brush.strength"))
      }
      <button type="button" class="field toggle${s.groundOnly ? " on" : ""}" data-k="ground" aria-pressed="${s.groundOnly}" ${tip(t("relief.brush.ground"), t("relief.brush.paintsHint"))}>${icon("terrain")}<span class="ct">${esc(t("relief.brush.ground"))}</span></button>`;
    onSeg(el, "mode", (v) => {
      s.brushMode = v as BrushKind;
      saved();
      ed.host.showProps();
    });
    const level = el.querySelector<HTMLInputElement>('[data-k="level"]');
    if (level) {
      level.value = String(s.level);
      level.oninput = () => {
        const v = readNumber(level);
        if (v !== null) {
          s.level = v;
          saved();
        }
      };
      level.onchange = () => (level.value = String(s.level));
      for (const button of el.querySelectorAll<HTMLButtonElement>('[data-for="level"]')) {
        button.onclick = () => {
          s.level = within(level, quarter(s.level + Number(button.dataset.by)));
          level.value = String(s.level);
          saved();
        };
      }
    }
    const picker = el.querySelector<HTMLButtonElement>('[data-k="levelPick"]');
    if (picker) {
      picker.onclick = () => {
        ed.levelPick = !ed.levelPick;
        ed.host.showProps();
        ed.host.redraw();
      };
    }
    el.querySelector<HTMLButtonElement>('[data-k="ground"]')!.onclick = () => {
      s.groundOnly = !s.groundOnly;
      saved();
      ed.host.showProps();
    };
    bindUnders(el, unders, saved);
    return;
  }
  if (ed.tool === "cut") {
    el.innerHTML = "";
    bindUnders(el, unders, saved);
    return;
  }
  if (ed.tool === "stamp") {
    el.innerHTML = seg("stamp", PREFABS.map(({ id, icon: ic, label, hint }): [string, IconName, string, string] => [id, ic, t(label), t(hint)]), s.stamp);
    onSeg(el, "stamp", (v) => {
      s.stamp = v as PrefabId;
      saved();
      ed.host.showProps();
      ed.host.redraw();
    });
    bindUnders(el, unders, saved);
    return;
  }
  // The shape tools: the edge new shapes get; the roller what it does and its width too.
  const edge = t("relief.shape.edge");
  unders.lastSoft = {
    html: `<span class="slider"><span class="end" ${tip(t("relief.edge.wall"), t("relief.edge.wallHint"))}>${icon("edge-wall")}</span><input type="range" min="0" max="${SOFT_STEPS.length - 1}" step="1" data-steps="${SOFT_STEPS}" data-k="lastSoft" aria-label="${esc(edge)}" /><span class="end" ${tip(t("relief.edge.soft"), t("relief.edge.softHint"))}>${icon("edge-soft")}</span><span class="sv" data-v="lastSoft"></span></span>`,
    get: () => s.lastSoft,
    set: (v) => (s.lastSoft = v),
  };
  unders.shapeRadius = { html: rangeHtml("shapeRadius", t("relief.size"), 0.25, 5, 0.25), get: () => s.shapeRadius, set: (v) => (s.shapeRadius = v) };
  unders.lassoSmooth = { html: rangeHtml("lassoSmooth", t("relief.lasso.smooth"), 0, 3, 1), get: () => s.lassoSmooth, set: (v) => (s.lassoSmooth = v) };
  el.innerHTML =
    (ed.tool === "paintShape"
      ? seg(
          "roller",
          [
            ["new", "roller", t("relief.roller.new"), t("relief.roller.newHint")],
            ["grow", "plus", t("relief.roller.grow"), t("relief.roller.growHint")],
            ["cut", "minus", t("relief.roller.cut"), t("relief.roller.cutHint")],
          ],
          s.rollerMode
        ) + underButton("shapeRadius", "size", t("relief.size"))
      : "") +
    (ed.tool === "lasso" ? underButton("lassoSmooth", "smooth", t("relief.lasso.smooth"), t("relief.lasso.smoothHint")) : "") +
    underButton("lastSoft", "edge-soft", edge, t("relief.shape.edgeHint"));
  onSeg(el, "roller", (v) => {
    s.rollerMode = v as RollerMode;
    saved();
    ed.host.showProps();
  });
  bindUnders(el, unders, saved);
}

// ---------- What's picked (the panel at the right) ----------

/** What's picked: its properties. Hidden while nothing is. `unit`: a height in the scene's own measure. */
export function renderProps(el: HTMLElement, ed: ReliefEditor, t: T, unit: (h: number) => string, folded: { body: boolean; look: boolean }) {
  el.hidden = !ed.sel;
  if (!ed.sel) {
    el.innerHTML = "";
  } else if (ed.sel.kind === "shape") {
    if (ed.sel.more?.length) {
      comboProps(el, ed, t);
    } else {
      shapeProps(el, ed, t, unit, folded);
    }
  } else {
    pointProps(el, ed, t, unit);
  }
}

/** The height row: −½, the number (its measure under it), +½. */
const heightRow = (t: T, value: string, measure: string) =>
  `<div class="height"><button type="button" class="ib sm" data-step="-0.5" ${tip(t("relief.down"), "", "X")}>${icon("minus")}</button><span class="num">${value}<span class="unit">${esc(measure)}</span></span><button type="button" class="ib sm" data-step="0.5" ${tip(t("relief.up"), "", "Z")}>${icon("plus")}</button></div>`;

function bindSteps(el: HTMLElement, ed: ReliefEditor) {
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-step]")) {
    button.onclick = () => ed.raise(Number(button.dataset.step));
  }
}

const deleteButton = (t: T) => `<button type="button" class="ib sm" data-k="del" ${tip(t("relief.delete"), "", "Supr")}>${icon("delete")}</button>`;

/** A vertex, some vertices, or a height point picked: their height. */
function pointProps(el: HTMLElement, ed: ReliefEditor, t: T, unit: (h: number) => string) {
  const sel = ed.sel!;
  const [nv, np] = sel.kind === "verts" ? [sel.list.length, sel.points?.length ?? 0] : [0, 0];
  const title =
    sel.kind !== "verts" ? t(sel.kind === "vertex" ? "relief.vertex" : "relief.point") : np === 0 ? t("relief.vertices", { n: nv }) : nv === 0 ? t("relief.points", { n: np }) : t("relief.pickedMany", { n: nv + np });
  const targets = ed.targets();
  const same = targets.every((x) => x.h === targets[0].h);
  el.innerHTML = `
    <div class="head"><span class="ptitle grow" ${tip(title, t(sel.kind === "point" ? "relief.pointText" : "relief.vertexText"))}>${esc(title)}</span>${deleteButton(t)}</div>
    <div class="rows"><span class="l">${esc(t("relief.height"))}</span>${heightRow(t, heightField("h", t("relief.height")), same ? unit(targets[0].h) : "")}</div>`;
  const input = el.querySelector<HTMLInputElement>('[data-k="h"]')!;
  input.value = same ? String(targets[0].h) : "";
  input.placeholder = same ? "" : t("relief.varied");
  const step = undoOnce(ed);
  input.onfocus = step.arm;
  input.oninput = () => {
    const v = readNumber(input);
    if (v !== null) {
      step.take();
      for (const target of targets) {
        target.h = v;
      }
      ed.changed();
    }
  };
  input.onchange = () => (input.value = same || targets.every((x) => x.h === targets[0].h) ? String(targets[0].h) : "");
  bindSteps(el, ed);
  el.querySelector<HTMLButtonElement>('[data-k="del"]')!.onclick = () => ed.remove();
}

/** Several shapes picked: what they can make together. */
function comboProps(el: HTMLElement, ed: ReliefEditor, t: T) {
  const { i, more } = ed.sel as { kind: "shape"; i: number; more: number[] };
  const first = nameOf(t, ed.data.shapes[i], i);
  el.innerHTML = `
    <div class="head"><span class="ptitle grow" ${tip(t("relief.combo.title", { n: more.length + 1 }), t("relief.combo.result", { first }))}>${esc(t("relief.combo.title", { n: more.length + 1 }))}</span></div>
    <div class="ops">${COMBINES.map(([id, label, hint]) => `<button type="button" class="opb" data-op="${id}" ${tip(t(label), t(hint, { first }))}>${OP_ICONS[id]}<span>${esc(t(label))}</span></button>`).join("")}</div>
    ${ed.notice ? `<p class="warn" role="status">${esc(t(ed.notice === "nothingShared" ? "relief.combo.nothingShared" : "relief.combo.nothingLeft"))}</p>` : ""}
    <button type="button" class="field wide" data-k="single" ${tip(t("relief.combo.single", { first }), t("relief.combo.ctrl"))}>${esc(t("relief.combo.single", { first }))}</button>`;
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-op]")) {
    button.onclick = () => runCombine(ed, button.dataset.op as Combine);
  }
  el.querySelector<HTMLButtonElement>('[data-k="single"]')!.onclick = () => {
    ed.sel = { kind: "shape", i };
    ed.host.showProps();
    ed.host.redraw();
  };
}

export const COMBINES: [Combine, TranslationKey, TranslationKey][] = [
  ["union", "relief.combo.union", "relief.combo.unionHint"],
  ["difference", "relief.combo.difference", "relief.combo.differenceHint"],
  ["intersection", "relief.combo.intersection", "relief.combo.intersectionHint"],
  ["xor", "relief.combo.xor", "relief.combo.xorHint"],
];

/** The shapes picked combined as asked; if nothing would change, why. */
export function runCombine(ed: ReliefEditor, id: Combine) {
  if (combine(ed, id)) {
    ed.notice = null;
    ed.changed();
  } else {
    ed.notice = id === "intersection" ? "nothingShared" : "nothingLeft";
  }
  ed.host.showProps();
}

const STAND_EDGES: StandEdge[] = ["auto", "bottom", "top", "left", "right"];
const WALL_LOOKS: WallLook[] = ["blend", "flat", "stretch", "fold", "stone", "rubble", "earth", "wood"];
const UNDER_LOOKS: ("" | UnderLook)[] = ["", "mirror", "keep"];

/** A shape's type: terrain, slab or standing. */
export const typeOf = (s: Shape): ShapeType => (s.slab && s.slab > 0 ? "slab" : s.stand ? "stand" : "terrain");

function shapeProps(el: HTMLElement, ed: ReliefEditor, t: T, unit: (h: number) => string, folded: { body: boolean; look: boolean }) {
  const si = (ed.sel as { i: number }).i;
  const s = ed.data.shapes[si];
  const slope = s.kind === "slope";
  const type = typeOf(s);

  const quad = corners(ed.relief.coordsOf(s)[0]).length === 4;
  let height = "";
  if (s.kind === "flat") {
    height = `<span class="l">${esc(t("relief.height"))}</span>${heightRow(t, heightField("h", t("relief.height")), unit(s.h))}`;
  } else if (s.kind === "ramp" && s.ramp) {
    height =
      `<span class="l" ${tip(t("relief.height"), t("relief.shape.rampHint"))}>${esc(t("relief.height"))}</span>${heightRow(t, `${heightField("from", t("relief.height"))}<span class="muted">→</span>${heightField("to", t("relief.height"))}`, `${unit(s.ramp.from)} → ${unit(s.ramp.to)}`)}` +
      `<span class="l" ${tip(t("relief.shape.steps"), t("relief.shape.stepsHint"))}>${esc(t("relief.shape.steps"))}</span><span class="line">${stepper(numField("steps", t("relief.shape.steps"), 0, 50, true), "steps", 1, t)}</span>` +
      `<span class="l">${esc(t("relief.shape.arrow"))}</span><span class="line"><button type="button" class="ib sm" data-k="flip" ${tip(t("relief.shape.flip"), t("relief.shape.flipHint"))}>${icon("convert")}</button><button type="button" class="field" data-k="rearrow" ${tip(t("relief.shape.rearrow"), t("relief.shape.rearrowHint"))}>${esc(t("relief.shape.rearrow"))}</button></span>`;
  } else if (s.kind === "ramp") {
    height = `<span class="l">${esc(t("relief.height"))}</span><span class="line"><span class="warn">${esc(t("relief.shape.noArrow"))}</span><button type="button" class="field" data-k="rearrow">${esc(t("relief.shape.addArrow"))}</button></span>`;
  } else {
    height =
      `<span class="l" ${tip(t("relief.height"), t("relief.shape.slopeText"))}>${esc(t("relief.height"))}</span>${heightRow(t, `<span class="muted">${esc(t("relief.label.inclined"))}</span>`, "")}` +
      `<span class="l"></span><button type="button" class="field" data-k="vertexHeights" ${tip(t("relief.shape.vertexHeights"), t("relief.shape.vertexHeightsHint"))}>${icon("pick-points")}<span>${esc(t("relief.shape.vertexHeights"))}</span></button>`;
  }
  const picture =
    ed.skinPick === si
      ? `<span class="warn">${esc(t("relief.shape.picking"))}</span>`
      : s.skin
        ? `<button type="button" class="field" data-k="skin">${esc(t("relief.shape.retake"))}</button><button type="button" class="ib sm" data-k="noskin" ${tip(t("relief.shape.removePicture"))}>${icon("close")}</button>`
        : `<button type="button" class="field" data-k="skin">${esc(t("relief.shape.take"))}</button>`;
  const look = [
    s.stand ? "" : `<span class="l" ${tip(t("relief.shape.walls"), t("relief.shape.wallsHint"))}>${esc(t("relief.shape.walls"))}</span><select class="field" data-k="wall" ${s.skin ? "disabled" : ""} aria-label="${esc(t("relief.shape.walls"))}">${WALL_LOOKS.map((v) => `<option value="${v}" ${(s.wall ?? "blend") === v ? "selected" : ""}>${esc(t(`relief.wall.${v}` as TranslationKey))}</option>`).join("")}</select>`,
    s.stand ? "" : `<span class="l" ${tip(t("relief.shape.picture"), t("relief.shape.pictureHint"))}>${esc(t("relief.shape.picture"))}</span><span class="line">${picture}</span>`,
    s.slab ? `<span class="l" ${tip(t("relief.shape.under"), t("relief.shape.underHint"))}>${esc(t("relief.shape.under"))}</span><select class="field" data-k="under" aria-label="${esc(t("relief.shape.under"))}">${UNDER_LOOKS.map((v) => `<option value="${v}" ${(s.under ?? "") === v ? "selected" : ""}>${esc(t(`relief.under.${v || "cover"}` as TranslationKey))}</option>`).join("")}</select>` : "",
    `<span class="l"></span><label class="check" ${tip(t("relief.shape.keepLook"), t("relief.shape.keepLookHint"))}><input type="checkbox" data-k="keepLook" ${s.keepLook ? "checked" : ""} /> ${esc(t("relief.shape.keepLook"))}</label>`,
    s.slab || s.stand ? "" : `<span class="l" ${tip(t("relief.shape.water"), t("relief.shape.waterHint"))}>${esc(t("relief.shape.water"))}</span><span class="line">${stepper(numField("water", t("relief.shape.water"), 0, 20), "water", 0.25, t)}</span>`,
    s.slab || s.stand ? "" : `<span class="l" ${tip(t("relief.shape.edge"), t("relief.shape.edgeHint"))}>${esc(t("relief.shape.edge"))}</span>${edgeSlider(t, "soft")}`,
  ].join("");
  el.innerHTML = `
    <div class="head"><button type="button" class="chev${folded.body ? " closed" : ""}" data-fold="body" ${tip(t(folded.body ? "relief.unfold" : "relief.fold"))}>${icon("expand")}</button><input class="name" data-k="name" maxlength="${NAME_MAX}" autocomplete="off" value="${esc(s.name ?? "")}" placeholder="${esc(t("relief.shape.name", { n: si + 1 }))}" ${tip(t("relief.shape.nameHint"), "", "F2")} />${deleteButton(t)}</div>
    <div class="body" ${folded.body ? "hidden" : ""}>
      <div class="rows">
        ${height}
        <span class="l" ${tip(t("relief.shape.type"), t("relief.shape.typeHint"))}>${esc(t("relief.shape.type"))}</span>${seg("type", [["terrain", "terrain", t("relief.shape.terrain"), t("relief.shape.terrainHint")], ["slab", "slab", t("relief.shape.slab"), t("relief.shape.slabHint")], ["stand", "stand", t("relief.shape.stand"), t("relief.shape.standHint")]], type)}
        ${s.slab && s.slab > 0 ? `<span class="l">${esc(t("relief.shape.thickness"))}</span><span class="line">${stepper(numField("slab", t("relief.shape.thickness"), 0.25, 20), "slab", 0.25, t)}</span>` : ""}
        ${s.stand ? `<span class="l" ${tip(t("relief.shape.standsOn"), t("relief.shape.standsOnHint"))}>${esc(t("relief.shape.standsOn"))}</span><select class="field" data-k="stand" aria-label="${esc(t("relief.shape.standsOn"))}">${STAND_EDGES.map((v) => `<option value="${v}" ${s.stand === v ? "selected" : ""}>${esc(t(`relief.stand.${v}` as TranslationKey))}</option>`).join("")}</select>` : ""}
        ${s.stand ? `<span class="l"></span><label class="check" ${tip(t("relief.shape.wrap"), t(quad ? "relief.shape.wrapHint4" : "relief.shape.wrapHint"))}><input type="checkbox" data-k="wrap" ${s.wrap ? "checked" : ""} /> ${esc(t("relief.shape.wrap"))}</label>` : ""}
        ${s.stand ? "" : `<span class="l">${esc(t("relief.shape.surface"))}</span>${seg("kind", [["flat", "flat", t("relief.shape.flat")], ["ramp", "ramp", t("relief.shape.ramp"), t("relief.shape.rampKindHint")], ["slope", "inclined", t("relief.shape.slope"), t("relief.shape.slopeHint")]], s.kind)}`}
        ${slope ? "" : `<span class="l" ${tip(t("relief.shape.measured"), t("relief.shape.measuredHint"))}>${esc(t("relief.shape.measured"))}</span>${seg("rel", [["rel", "relative", t("relief.shape.rel"), t("relief.shape.relHint")], ["abs", "fixed", t("relief.shape.abs"), t("relief.shape.absHint")]], s.rel ? "rel" : "abs")}`}
      </div>
      ${look ? `<div class="section">
        <button type="button" class="shead" data-fold="look" aria-expanded="${!folded.look}"><span class="chev${folded.look ? " closed" : ""}">${icon("expand")}</span>${esc(t("relief.look"))}</button>
        <div class="rows" ${folded.look ? "hidden" : ""}>${look}</div>
      </div>` : ""}
      ${s.holes?.length ? `<p class="muted small">${esc(s.holes.length === 1 ? t("relief.shape.hole") : t("relief.shape.holes", { n: s.holes.length }))}</p>` : ""}
    </div>`;
  const redo = () => {
    ed.changed();
    ed.host.showProps();
  };
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-fold]")) {
    button.onclick = () => {
      const which = button.dataset.fold as "body" | "look";
      folded[which] = !folded[which];
      ed.host.showProps();
    };
  }
  const name = el.querySelector<HTMLInputElement>('[data-k="name"]')!;
  const naming = undoOnce(ed);
  name.onfocus = naming.arm;
  name.oninput = () => {
    naming.take();
    s.name = name.value.trim() || undefined;
    ed.changed();
  };
  name.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === "Escape") {
      name.blur();
    }
  };
  onSeg(el, "kind", (v) => {
    ed.pushUndo();
    setKind(ed, si, v as Shape["kind"]);
    redo();
  });
  onSeg(el, "rel", (v) => {
    ed.pushUndo();
    setRel(ed, si, v === "rel");
    redo();
  });
  onSeg(el, "type", (v) => {
    ed.pushUndo();
    setType(ed, si, v as ShapeType);
    redo();
  });
  bindSteps(el, ed);
  bindNumber(el, ed, "h", () => s.h, (v) => (s.h = v));
  bindStepper(el, ed, "slab", () => s.slab ?? 0.5, (v) => (s.slab = Math.max(0.25, v)));
  bindStepper(el, ed, "water", () => s.water ?? 0, (v) => (s.water = v > 0 ? v : undefined));
  if (s.ramp) {
    const ramp = s.ramp;
    bindNumber(el, ed, "from", () => ramp.from, (v) => (ramp.from = v));
    bindNumber(el, ed, "to", () => ramp.to, (v) => (ramp.to = v));
    // How many treads: whole ones; one alone is none (a smooth ramp), so 0 and 2 are next to each other.
    const treads = (v: number) => {
      const n = Math.max(0, Math.round(v));
      ramp.steps = n === 1 ? (ramp.steps >= 2 ? 0 : 2) : n;
    };
    bindStepper(el, ed, "steps", () => ramp.steps, treads);
  }
  const soft = el.querySelector<HTMLInputElement>('[data-k="soft"]');
  if (soft) {
    soft.value = toSlider(soft, s.soft ?? 0);
    const sliding = undoOnce(ed);
    soft.onpointerdown = sliding.arm;
    soft.onkeydown = sliding.arm;
    soft.oninput = () => {
      sliding.take();
      const before = s.soft ?? 0;
      const v = fromSlider(soft);
      s.soft = v > 0 ? v : undefined;
      ed.settings.lastSoft = s.soft ?? 0;
      ed.host.saveSettings();
      ed.softened(si, Math.max(before, v));
    };
    soft.onchange = () => ed.changed();
  }
  const wallLook = el.querySelector<HTMLSelectElement>('[data-k="wall"]');
  if (wallLook) {
    wallLook.onchange = () => {
      ed.pushUndo();
      // Blend: none of its own (the walls' look by default).
      s.wall = wallLook.value === "blend" ? undefined : (wallLook.value as WallLook);
      redo();
    };
  }
  const under = el.querySelector<HTMLSelectElement>('[data-k="under"]');
  if (under) {
    under.onchange = () => {
      ed.pushUndo();
      s.under = (under.value || undefined) as UnderLook | undefined;
      redo();
    };
  }
  const skin = el.querySelector<HTMLButtonElement>('[data-k="skin"]');
  if (skin) {
    skin.onclick = () => {
      ed.skinPick = si;
      ed.host.showProps();
    };
  }
  const noskin = el.querySelector<HTMLButtonElement>('[data-k="noskin"]');
  if (noskin) {
    noskin.onclick = () => {
      ed.pushUndo();
      s.skin = undefined;
      redo();
    };
  }
  const keepLook = el.querySelector<HTMLInputElement>('[data-k="keepLook"]');
  if (keepLook) {
    keepLook.onchange = () => {
      ed.pushUndo();
      s.keepLook = keepLook.checked || undefined;
      redo();
    };
  }
  const wrap = el.querySelector<HTMLInputElement>('[data-k="wrap"]');
  if (wrap) {
    wrap.onchange = () => {
      ed.pushUndo();
      s.wrap = wrap.checked || undefined;
      redo();
    };
  }
  const stand = el.querySelector<HTMLSelectElement>('[data-k="stand"]');
  if (stand) {
    stand.onchange = () => {
      ed.pushUndo();
      s.stand = stand.value as StandEdge;
      redo();
    };
  }
  const flip = el.querySelector<HTMLButtonElement>('[data-k="flip"]');
  if (flip && s.ramp) {
    const ramp = s.ramp;
    flip.onclick = () => {
      ed.pushUndo();
      [ramp.a, ramp.b, ramp.from, ramp.to] = [ramp.b, ramp.a, ramp.to, ramp.from];
      redo();
    };
  }
  const rearrow = el.querySelector<HTMLButtonElement>('[data-k="rearrow"]');
  if (rearrow) {
    rearrow.onclick = () => {
      ed.pushUndo();
      const fresh = defaultRamp(ed, s);
      s.ramp = s.ramp ? { ...s.ramp, a: fresh.a, b: fresh.b } : fresh;
      redo();
    };
  }
  const vertexHeights = el.querySelector<HTMLButtonElement>('[data-k="vertexHeights"]');
  if (vertexHeights) {
    // Its corners' heights: Elegir on vertices, the shape still picked (its vertices shown).
    vertexHeights.onclick = () => {
      ed.setTool("edit");
      ed.settings.pickMode = "points";
      ed.sel = { kind: "shape", i: si };
      ed.host.saveSettings();
      ed.host.showProps();
      ed.host.redraw();
    };
  }
  el.querySelector<HTMLButtonElement>('[data-k="del"]')!.onclick = () => ed.remove();
}

// ---------- The shapes (the list at the bottom left) ----------

const TYPE_ICONS: Record<ShapeType, IconName> = { terrain: "terrain", slab: "slab", stand: "stand" };

/** A shape's height, as the list has it. */
const describe = (t: T, s: Shape) =>
  s.kind === "flat" ? (s.rel ? signed(s.h) : fmt(s.h)) : s.kind === "ramp" && s.ramp ? `${fmt(s.ramp.from)}→${fmt(s.ramp.to)}` : s.kind === "ramp" ? t("relief.label.rampNoArrow") : t("relief.label.inclined");

/** What the shapes' list needs from its page: its own folding, its groups' (ids folded), and the menus. */
export type ShapesList = {
  folded: { value: boolean };
  groupsFolded: Set<string>;
  onMenu: (i: number, x: number, y: number) => void;
  onGroupMenu: (id: string, x: number, y: number) => void;
  focusName: () => void;
};

/** A row of the list: a shape, or a group (its shapes and groups in rows under it, unless folded); how deep it is. */
type Row = { shape: number; depth: number } | { group: Group; depth: number };

/** The list's rows, the top first: each group where its shapes are (they're together: see tidyGroups). */
function rowsOf(data: ReliefData, folded: Set<string>): Row[] {
  const groups = groupsOf(data);
  const top = new Map<string, number>();
  data.shapes.forEach((s, i) => {
    for (const id of ancestors(data, s.group)) {
      top.set(id, Math.max(top.get(id) ?? -1, i));
    }
  });
  const rows: Row[] = [];
  const spell = (container: string | undefined, depth: number) => {
    const items = [
      ...data.shapes.flatMap((s, i) => ((s.group ?? undefined) === container ? [{ at: i, shape: i }] : [])),
      ...groups.filter((g) => g.parent === container && top.has(g.id)).map((g) => ({ at: top.get(g.id)!, group: g })),
    ].sort((a, b) => b.at - a.at);
    for (const item of items) {
      if ("shape" in item) {
        rows.push({ shape: item.shape, depth });
      } else {
        rows.push({ group: item.group, depth });
        if (!folded.has(item.group.id)) {
          spell(item.group.id, depth + 1);
        }
      }
    }
  };
  spell(undefined, 0);
  return rows;
}

/**
 * Every shape, the top one first, in its groups (folders that fold), the
 * ground under them; its title under the list (it opens upwards). A click
 * picks a shape (Ctrl+click: one more), or a group's shapes; a double click
 * names it; a right click its menu; dragging moves it up or down, into a
 * group or out of one. A group's eye and lock: all its shapes'.
 */
export function renderShapes(el: HTMLElement, ed: ReliefEditor, t: T, ui: ShapesList) {
  const data = ed.data;
  const shapes = data.shapes;
  const picked = ed.sel?.kind === "shape" ? ed.sel.i : -1;
  const more = ed.sel?.kind === "shape" ? (ed.sel.more ?? []) : [];
  const chosen = new Set(picked >= 0 ? [picked, ...more] : []);
  const toggles = (key: string, value: string, hidden: boolean, locked: boolean) =>
    `<button type="button" class="tg${hidden ? " set" : ""}" data-${key}hide="${value}" aria-pressed="${hidden}" ${tip(t(hidden ? "relief.row.show" : "relief.row.hide"), t("relief.row.editorOnly"))}>${icon(hidden ? "hidden" : "visible")}</button>` +
    `<button type="button" class="tg${locked ? " set" : ""}" data-${key}lock="${value}" aria-pressed="${locked}" ${tip(t(locked ? "relief.row.unlock" : "relief.row.lock"), t("relief.row.editorOnly"))}>${icon(locked ? "locked" : "unlocked")}</button>`;
  const rows = rowsOf(data, ui.groupsFolded)
    .map((row) => {
      const depth = `style="--depth: ${row.depth}"`;
      if ("group" in row) {
        const g = row.group;
        const members = membersOf(data, g.id).map((i) => shapes[i]);
        const free = membersOf(data, g.id).filter((i) => !shapes[i].hidden && !shapes[i].locked);
        const on = free.length > 0 && free.every((i) => chosen.has(i));
        const hidden = members.every((s) => s.hidden);
        const locked = members.every((s) => s.locked);
        const open = !ui.groupsFolded.has(g.id);
        return `<div class="item grp${on ? " on" : ""}${hidden ? " off" : ""}" draggable="true" data-g="${esc(g.id)}" ${depth} tabindex="0" role="button" aria-expanded="${open}" aria-pressed="${on}" ${tip(g.name, t("relief.groupRow"))}>
          <span class="gchev${open ? "" : " closed"}" data-fold="${esc(g.id)}" ${tip(t(open ? "relief.fold" : "relief.unfold"))}>${icon("expand")}</span>${icon("folder")}<span class="n">${esc(g.name)}</span><span class="h">${members.length}</span>${toggles("g", esc(g.id), hidden, locked)}</div>`;
      }
      const i = row.shape;
      const s = shapes[i];
      const state = i === picked ? "on" : more.includes(i) ? "more" : "";
      return `<div class="item ${state}${s.hidden ? " off" : ""}" draggable="true" data-i="${i}" ${depth} tabindex="0" role="button" aria-pressed="${chosen.has(i)}" ${tip(nameOf(t, s, i), t("relief.layerRow"))}>
        ${icon(TYPE_ICONS[typeOf(s)])}<span class="n">${esc(nameOf(t, s, i))}</span><span class="h">${esc(describe(t, s))}</span>${toggles("", String(i), !!s.hidden, !!s.locked)}</div>`;
    })
    .join("");
  el.classList.toggle("closed", ui.folded.value);
  // Drawn again, it stays scrolled where it was; a shape newly picked (on the map) brought into sight.
  const scrolled = el.querySelector(".lrows")?.scrollTop ?? 0;
  const newlyPicked = String(picked) !== el.dataset.picked;
  el.dataset.picked = String(picked);
  el.innerHTML = `<button type="button" class="lhead" aria-expanded="${!ui.folded.value}"><span class="chev">${icon("expand")}</span><span class="lt">${esc(t("relief.shapes"))}</span><span class="count">${shapes.length}</span></button>
    <div class="lrows" ${ui.folded.value ? "hidden" : ""}>${rows}<div class="item ground" data-ground tabindex="0" role="button" ${tip(t("relief.ground"), t("relief.groundHint"))}>${icon("terrain")}<span class="n">${esc(t("relief.ground"))}</span><span class="h">${esc(t("relief.groundBrush"))}</span></div></div>`;
  const scroller = el.querySelector<HTMLElement>(".lrows")!;
  scroller.scrollTop = scrolled;
  const pickedRow = newlyPicked && picked >= 0 ? scroller.querySelector<HTMLElement>(`.item[data-i="${picked}"]`) : null;
  if (pickedRow) {
    const [row, box] = [pickedRow.getBoundingClientRect(), scroller.getBoundingClientRect()];
    scroller.scrollTop += row.top < box.top ? row.top - box.top : row.bottom > box.bottom ? row.bottom - box.bottom : 0;
  }
  const again = () => renderShapes(el, ed, t, ui);
  el.querySelector<HTMLButtonElement>(".lhead")!.onclick = () => {
    ui.folded.value = !ui.folded.value;
    again();
  };
  const pick = (i: number, add: boolean) => {
    if (add) {
      togglePick(ed, i);
      ed.notice = null;
    } else {
      ed.sel = { kind: "shape", i };
      if (ed.isBrush() || ed.tool === "cut") {
        ed.setTool("edit");
      }
    }
    ed.host.showProps();
    ed.host.redraw();
  };
  const pickAll = (id: string, add: boolean) => {
    pickGroup(ed, id, add);
    ed.notice = null;
    if (ed.isBrush() || ed.tool === "cut") {
      ed.setTool("edit");
    }
    ed.host.showProps();
    ed.host.redraw();
  };
  // Hidden, locked: the editor's own, a step to undo.
  const toggle = (i: number, what: "hidden" | "locked") => {
    const s = shapes[i];
    ed.pushUndo();
    s[what] = s[what] ? undefined : true;
    if (s[what] && chosen.has(i)) {
      ed.sel = null;
    }
    ed.changed();
    ed.host.showProps();
  };
  const bind = (attr: string, f: (value: string) => void) => {
    for (const button of el.querySelectorAll<HTMLElement>(`[data-${attr}]`)) {
      button.onclick = (event) => {
        event.stopPropagation();
        f(button.getAttribute(`data-${attr}`)!);
      };
    }
  };
  bind("hide", (v) => toggle(Number(v), "hidden"));
  bind("lock", (v) => toggle(Number(v), "locked"));
  const groupToggle = (id: string, what: "hidden" | "locked") => {
    toggleGroup(ed, id, what);
    ed.changed();
    ed.host.showProps();
  };
  bind("ghide", (id) => groupToggle(id, "hidden"));
  bind("glock", (id) => groupToggle(id, "locked"));
  bind("fold", (id) => {
    if (!ui.groupsFolded.delete(id)) {
      ui.groupsFolded.add(id);
    }
    again();
  });
  // Dragging: a shape or a group; let go over a row's upper half, above it; its lower half, below it
  // (an open group's: into it, at its top).
  let dragged: ListItem | null = null;
  const above = (row: HTMLElement, event: DragEvent) => {
    const r = row.getBoundingClientRect();
    return event.clientY < r.top + r.height / 2;
  };
  const unmark = (row: HTMLElement) => row.classList.remove("drop-above", "drop-below");
  const dropOn = (row: HTMLElement, event: DragEvent): ListDrop => {
    const up = above(row, event);
    if (row.dataset.g) {
      return { side: up ? "above" : ui.groupsFolded.has(row.dataset.g) ? "below" : "into", group: row.dataset.g };
    }
    return { side: up ? "above" : "below", shape: Number(row.dataset.i) };
  };
  for (const row of el.querySelectorAll<HTMLElement>(".item[data-i], .item[data-g]")) {
    const item: ListItem = row.dataset.g ? { group: row.dataset.g } : { shape: Number(row.dataset.i) };
    const same = (other: ListItem | null) => !!other && ("group" in item ? "group" in other && other.group === item.group : "shape" in other && other.shape === item.shape);
    if ("group" in item) {
      const id = item.group;
      row.onclick = (event) => pickAll(id, event.ctrlKey || event.metaKey);
      row.onkeydown = (event) => {
        if ((event.key === "Enter" || event.key === " ") && event.target === row) {
          event.preventDefault();
          pickAll(id, event.ctrlKey || event.metaKey);
        }
      };
      row.ondblclick = (event) => {
        event.stopPropagation();
        renameGroup(row, ed, id);
      };
      row.oncontextmenu = (event) => {
        event.preventDefault();
        pickAll(id, false);
        ui.onGroupMenu(id, event.clientX, event.clientY);
      };
    } else {
      const i = item.shape;
      row.onclick = (event) => pick(i, event.ctrlKey || event.metaKey);
      row.onkeydown = (event) => {
        if ((event.key === "Enter" || event.key === " ") && event.target === row) {
          event.preventDefault();
          pick(i, event.ctrlKey || event.metaKey);
        }
      };
      row.ondblclick = () => {
        ed.sel = { kind: "shape", i };
        ed.host.showProps();
        ui.focusName();
      };
      row.oncontextmenu = (event) => {
        event.preventDefault();
        if (!chosen.has(i)) {
          pick(i, false);
        }
        ui.onMenu(i, event.clientX, event.clientY);
      };
      row.onmouseenter = () => {
        ed.hover = i;
        ed.host.redraw();
      };
      row.onmouseleave = () => {
        ed.hover = -1;
        ed.host.redraw();
      };
    }
    row.ondragstart = (event) => {
      dragged = item;
      event.dataTransfer!.effectAllowed = "move";
      row.classList.add("dragging");
    };
    row.ondragend = () => row.classList.remove("dragging");
    row.ondragover = (event) => {
      if (dragged && !same(dragged)) {
        event.preventDefault();
        const up = above(row, event);
        row.classList.toggle("drop-above", up);
        row.classList.toggle("drop-below", !up);
      }
    };
    row.ondragleave = () => unmark(row);
    row.ondrop = (event) => {
      event.preventDefault();
      unmark(row);
      if (dragged && moveItem(ed, dragged, dropOn(row, event))) {
        ed.changed();
        ed.host.showProps();
      }
      dragged = null;
    };
  }
  const ground = el.querySelector<HTMLElement>("[data-ground]");
  if (ground) {
    ground.onclick = () => ed.setTool("brush");
    ground.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        ed.setTool("brush");
      }
    };
  }
}

/** A group's name edited in its row: Enter (or leaving it) keeps it, Esc doesn't; empty, it's named again. */
export function renameGroup(row: HTMLElement, ed: ReliefEditor, id: string) {
  const g = groupsOf(ed.data).find((x) => x.id === id);
  const label = row.querySelector<HTMLElement>(".n");
  if (!g || !label) {
    return;
  }
  const input = document.createElement("input");
  input.className = "n rename";
  input.maxLength = NAME_MAX;
  input.value = g.name;
  input.setAttribute("aria-label", g.name);
  label.replaceWith(input);
  row.draggable = false;
  let done = false;
  const finish = (keep: boolean) => {
    if (done) {
      return;
    }
    done = true;
    const name = input.value.trim();
    if (keep && name !== g.name) {
      ed.pushUndo();
      g.name = name;
      ed.changed();
    }
    ed.host.showProps();
  };
  input.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      finish(event.key === "Enter");
    }
  };
  input.onclick = (event) => event.stopPropagation();
  input.onblur = () => finish(true);
  input.focus();
  input.select();
}

// ---------- Combining's own icons ----------

const svg = (body: string) =>
  `<svg class="ri" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** Two circles, and what each operation keeps of them (filled). */
const op = (kept: string) => svg(`<defs><clipPath id="reOpA"><circle cx="9" cy="12" r="6"/></clipPath></defs>${kept}<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>`);
const fill = (cx: number, extra = "") => `<circle cx="${cx}" cy="12" r="6" fill="currentColor" opacity=".45" stroke="none"${extra}/>`;
export const OP_ICONS: Record<Combine, string> = {
  union: op(fill(9) + fill(15)),
  difference: op(fill(9) + '<circle cx="15" cy="12" r="6" fill="var(--re-panel)" stroke="none" clip-path="url(#reOpA)"/>'),
  intersection: op(fill(15, ' clip-path="url(#reOpA)"')),
  xor: op(fill(9) + fill(15) + '<circle cx="15" cy="12" r="6" fill="var(--re-panel)" stroke="none" clip-path="url(#reOpA)"/>'),
};
