import type { TranslationKey } from "../../i18n/translate";
import type { Shape, StandEdge, WallLook } from "../types";
import { corners } from "../stand";
import { BRUSHES, type BrushKind } from "./brush";
import type { PickMode, ReliefEditor, ToolId } from "./editor";
import { icon, type IconName } from "./icons";
import { combine, defaultRamp, moveLayer, setKind, setRel, setType, togglePick, type Combine, type ShapeType } from "./shapes";

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
      ["relief.key.dblSide", "relief.key.dblSideDo"],
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

/** A slider, set as it's moved; `done` after each move. */
function bindRange(el: HTMLElement, key: string, get: () => number, set: (v: number) => void, done: () => void) {
  const input = el.querySelector<HTMLInputElement>(`[data-k="${key}"]`);
  if (!input) {
    return;
  }
  const show = el.querySelector<HTMLElement>(`[data-v="${key}"]`);
  input.value = String(get());
  if (show) {
    show.textContent = fmt(get());
  }
  input.oninput = () => {
    set(Number(input.value));
    if (show) {
      show.textContent = fmt(Number(input.value));
    }
    done();
  };
}

/** A number field: undo kept from when it's entered, the relief changed as it's typed. */
function bindNumber(el: HTMLElement, ed: ReliefEditor, key: string, get: () => number, set: (v: number) => void) {
  const input = el.querySelector<HTMLInputElement>(`[data-k="${key}"]`);
  if (!input) {
    return;
  }
  input.value = String(get());
  input.onfocus = () => ed.pushUndo();
  input.oninput = () => {
    if (input.value !== "" && Number.isFinite(Number(input.value))) {
      set(Number(input.value));
      ed.changed();
    }
  };
}

/** A slider from a wall (0) to a soft edge, an icon at each end. */
const edgeSlider = (t: T, key: string) =>
  `<span class="slider"><span class="sl">${esc(t("relief.shape.edge"))}</span><span class="end" ${tip(t("relief.edge.wall"), t("relief.edge.wallHint"))}>${icon("edge-wall")}</span><input type="range" min="0" max="8" step="0.5" data-k="${key}" aria-label="${esc(t("relief.shape.edge"))}" /><span class="end" ${tip(t("relief.edge.soft"), t("relief.edge.softHint"))}>${icon("edge-soft")}</span></span>`;

// ---------- Tools ----------

/** The tools' column: an icon each, its name, key and what it does on the pointer. */
export function renderTools(el: HTMLElement, ed: ReliefEditor, t: T, onTool: (id: ToolId) => void) {
  el.innerHTML = TOOLS.map((tool) =>
    tool === null
      ? '<div class="hsep" role="separator"></div>'
      : `<button type="button" class="ib${ed.tool === tool.id ? " on" : ""}" data-tool="${tool.id}" aria-pressed="${ed.tool === tool.id}" ${tip(t(toolLabel(tool.id)), t(toolHint(tool.id)), tool.key.toUpperCase(), "right")}>${icon(tool.icon)}</button>`
  ).join("");
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
    button.onclick = () => onTool(button.dataset.tool as ToolId);
  }
}

/** Every key of the tool in hand, and those for everything. */
export function shortcutsHtml(ed: ReliefEditor, t: T): string {
  const tool = TOOL_LIST.find((x) => x.id === ed.tool)!;
  const list = (keys: [TranslationKey, TranslationKey][]) => keys.map(([k, v]) => `<dt>${esc(t(k))}</dt><dd>${esc(t(v))}</dd>`).join("");
  return `<p class="ptitle">${esc(t(toolLabel(tool.id)))} <span class="key">${tool.key.toUpperCase()}</span></p><dl>${list(tool.keys)}</dl>
    <p class="ptitle">${esc(t("relief.shortcutsAll"))}</p><dl>${list(GENERAL_KEYS)}</dl>`;
}

// ---------- The tool's options (the top bar's middle) ----------

export function renderOptions(el: HTMLElement, ed: ReliefEditor, t: T) {
  const s = ed.settings;
  const saved = () => ed.host.saveSettings();
  const label = `<span class="opt-label">${esc(t(toolLabel(ed.tool)))}</span>`;
  if (ed.tool === "edit") {
    el.innerHTML =
      label +
      seg(
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
    return;
  }
  if (ed.tool === "brush") {
    const modes = BRUSHES.map((b, i): [string, IconName, string, string] => [b, b as IconName, `${t(`relief.brush.${b}` as TranslationKey)} (${i + 1})`, t(`relief.brush.${b}Text` as TranslationKey)]);
    el.innerHTML = `${seg("mode", modes, s.brushMode)}
      <span class="slider"><span class="sl">${esc(t("relief.size"))}</span><input type="range" min="0.25" max="6" step="0.25" data-k="radius" aria-label="${esc(t("relief.size"))}" /></span>
      ${
        s.brushMode === "flatten"
          ? `<span class="slider" ${tip(t("relief.height"), t("relief.brush.levelHint"))}><span class="sl">${esc(t("relief.height"))}</span><input class="field num" type="number" step="0.25" data-k="level" aria-label="${esc(t("relief.height"))}" /></span>`
          : `<span class="slider"><span class="sl">${esc(t("relief.brush.strength"))}</span><input type="range" min="0.1" max="2" step="0.1" data-k="strength" aria-label="${esc(t("relief.brush.strength"))}" /></span>`
      }
      <label class="check" ${tip(t("relief.brush.ground"), t("relief.brush.paintsHint"))}><input type="checkbox" data-k="ground" ${s.groundOnly ? "checked" : ""} /> ${esc(t("relief.brush.ground"))}</label>`;
    onSeg(el, "mode", (v) => {
      s.brushMode = v as BrushKind;
      saved();
      ed.host.showProps();
    });
    bindRange(el, "radius", () => s.radius, (v) => (s.radius = v), saved);
    bindRange(el, "strength", () => s.strength, (v) => (s.strength = v), saved);
    const level = el.querySelector<HTMLInputElement>('[data-k="level"]');
    if (level) {
      level.value = String(s.level);
      level.oninput = () => {
        if (level.value !== "" && Number.isFinite(Number(level.value))) {
          s.level = Number(level.value);
          saved();
        }
      };
    }
    el.querySelector<HTMLInputElement>('[data-k="ground"]')!.onchange = (event) => {
      s.groundOnly = (event.target as HTMLInputElement).checked;
      saved();
    };
    return;
  }
  if (ed.tool === "cut") {
    el.innerHTML = label;
    return;
  }
  // The shape tools: the edge new shapes get; the roller its width too.
  el.innerHTML =
    label +
    (ed.tool === "paintShape"
      ? `<span class="slider" ${tip(t("relief.size"), t(ed.sel?.kind === "shape" ? "relief.paintShape.picked" : "relief.paintShape.new"))}><span class="sl">${esc(t("relief.size"))}</span><input type="range" min="0.25" max="5" step="0.25" data-k="shapeRadius" aria-label="${esc(t("relief.size"))}" /></span>`
      : "") +
    edgeSlider(t, "lastSoft");
  bindRange(el, "shapeRadius", () => s.shapeRadius, (v) => (s.shapeRadius = v), saved);
  bindRange(el, "lastSoft", () => s.lastSoft, (v) => (s.lastSoft = v), saved);
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
  const title = sel.kind === "verts" ? t("relief.vertices", { n: sel.list.length }) : sel.kind === "vertex" ? t("relief.vertex") : t("relief.point");
  const targets = ed.targets();
  const same = targets.every((x) => x.h === targets[0].h);
  el.innerHTML = `
    <div class="head"><span class="ptitle grow" ${tip(title, t(sel.kind === "point" ? "relief.pointText" : "relief.vertexText"))}>${esc(title)}</span>${deleteButton(t)}</div>
    <div class="rows"><span class="l">${esc(t("relief.height"))}</span>${heightRow(t, `<input type="number" step="0.25" data-k="h" aria-label="${esc(t("relief.height"))}" />`, same ? unit(targets[0].h) : "")}</div>`;
  const input = el.querySelector<HTMLInputElement>('[data-k="h"]')!;
  input.value = same ? String(targets[0].h) : "";
  input.placeholder = same ? "" : t("relief.varied");
  input.onfocus = () => ed.pushUndo();
  input.oninput = () => {
    if (input.value !== "" && Number.isFinite(Number(input.value))) {
      for (const target of targets) {
        target.h = Number(input.value);
      }
      ed.changed();
    }
  };
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
const WALL_LOOKS: ("" | WallLook)[] = ["", "flat", "stretch", "fold", "stone", "rubble", "earth", "wood"];

/** A shape's type: terrain, slab or standing. */
export const typeOf = (s: Shape): ShapeType => (s.slab && s.slab > 0 ? "slab" : s.stand ? "stand" : "terrain");

function shapeProps(el: HTMLElement, ed: ReliefEditor, t: T, unit: (h: number) => string, folded: { body: boolean; look: boolean }) {
  const si = (ed.sel as { i: number }).i;
  const s = ed.data.shapes[si];
  const slope = s.kind === "slope";
  const type = typeOf(s);
  const number = (key: string, label: string, min = "") => `<input type="number" step="0.25" ${min !== "" ? `min="${min}"` : ""} data-k="${key}" aria-label="${esc(label)}" />`;
  const quad = corners(ed.relief.coordsOf(s)[0]).length === 4;
  let height = "";
  if (s.kind === "flat") {
    height = `<span class="l">${esc(t("relief.height"))}</span>${heightRow(t, number("h", t("relief.height")), unit(s.h))}`;
  } else if (s.kind === "ramp" && s.ramp) {
    height =
      `<span class="l" ${tip(t("relief.height"), t("relief.shape.rampHint"))}>${esc(t("relief.height"))}</span>${heightRow(t, `${number("from", t("relief.height"))}<span class="muted">→</span>${number("to", t("relief.height"))}`, `${unit(s.ramp.from)} → ${unit(s.ramp.to)}`)}` +
      `<span class="l" ${tip(t("relief.shape.steps"), t("relief.shape.stepsHint"))}>${esc(t("relief.shape.steps"))}</span><span class="line">${number("steps", t("relief.shape.steps"), "0")}<button type="button" class="ib sm" data-k="flip" ${tip(t("relief.shape.flip"), t("relief.shape.flipHint"))}>${icon("convert")}</button><button type="button" class="field" data-k="rearrow" ${tip(t("relief.shape.rearrow"), t("relief.shape.rearrowHint"))}>${esc(t("relief.shape.rearrow"))}</button></span>`;
  } else if (s.kind === "ramp") {
    height = `<span class="l">${esc(t("relief.height"))}</span><span class="line"><span class="warn">${esc(t("relief.shape.noArrow"))}</span><button type="button" class="field" data-k="rearrow">${esc(t("relief.shape.addArrow"))}</button></span>`;
  } else {
    height = `<span class="l" ${tip(t("relief.height"), t("relief.shape.slopeText"))}>${esc(t("relief.height"))}</span>${heightRow(t, `<span class="muted">${esc(t("relief.label.inclined"))}</span>`, "")}`;
  }
  const picture =
    ed.skinPick === si
      ? `<span class="warn">${esc(t("relief.shape.picking"))}</span>`
      : s.skin
        ? `<button type="button" class="field" data-k="skin">${esc(t("relief.shape.retake"))}</button><button type="button" class="ib sm" data-k="noskin" ${tip(t("relief.shape.removePicture"))}>${icon("close")}</button>`
        : `<button type="button" class="field" data-k="skin">${esc(t("relief.shape.take"))}</button>`;
  const look = [
    s.stand ? "" : `<span class="l" ${tip(t("relief.shape.walls"), t("relief.shape.wallsHint"))}>${esc(t("relief.shape.walls"))}</span><select class="field" data-k="wall" ${s.skin ? "disabled" : ""} aria-label="${esc(t("relief.shape.walls"))}">${WALL_LOOKS.map((v) => `<option value="${v}" ${(s.wall ?? "") === v ? "selected" : ""}>${esc(t(`relief.wall.${v || "default"}` as TranslationKey))}</option>`).join("")}</select>`,
    s.stand ? "" : `<span class="l" ${tip(t("relief.shape.picture"), t("relief.shape.pictureHint"))}>${esc(t("relief.shape.picture"))}</span><span class="line">${picture}</span>`,
    s.slab || s.stand ? "" : `<span class="l" ${tip(t("relief.shape.water"), t("relief.shape.waterHint"))}>${esc(t("relief.shape.water"))}</span><span class="line">${number("water", t("relief.shape.water"), "0")}</span>`,
    s.slab || s.stand ? "" : `<span class="l" ${tip(t("relief.shape.edge"), t("relief.shape.edgeHint"))}>${esc(t("relief.shape.edge"))}</span>${edgeSlider(t, "soft").replace(/<span class="sl">[^<]*<\/span>/, "")}`,
  ].join("");
  el.innerHTML = `
    <div class="head"><button type="button" class="chev${folded.body ? " closed" : ""}" data-fold="body" ${tip(t(folded.body ? "relief.unfold" : "relief.fold"))}>${icon("expand")}</button><input class="name" data-k="name" value="${esc(s.name ?? "")}" placeholder="${esc(t("relief.shape.name", { n: si + 1 }))}" ${tip(t("relief.shape.nameHint"), "", "F2")} />${deleteButton(t)}</div>
    <div class="body" ${folded.body ? "hidden" : ""}>
      <div class="rows">
        ${height}
        <span class="l" ${tip(t("relief.shape.type"), t("relief.shape.typeHint"))}>${esc(t("relief.shape.type"))}</span>${seg("type", [["terrain", "terrain", t("relief.shape.terrain"), t("relief.shape.terrainHint")], ["slab", "slab", t("relief.shape.slab"), t("relief.shape.slabHint")], ["stand", "stand", t("relief.shape.stand"), t("relief.shape.standHint")]], type)}
        ${s.slab && s.slab > 0 ? `<span class="l">${esc(t("relief.shape.thickness"))}</span><span class="line">${number("slab", t("relief.shape.thickness"), "0.25")}</span>` : ""}
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
  name.onfocus = () => ed.pushUndo();
  name.oninput = () => {
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
  bindNumber(el, ed, "slab", () => s.slab ?? 0.5, (v) => (s.slab = Math.max(0.25, v)));
  bindNumber(el, ed, "water", () => s.water ?? 0, (v) => (s.water = v > 0 ? v : undefined));
  if (s.ramp) {
    const ramp = s.ramp;
    bindNumber(el, ed, "from", () => ramp.from, (v) => (ramp.from = v));
    bindNumber(el, ed, "to", () => ramp.to, (v) => (ramp.to = v));
    bindNumber(el, ed, "steps", () => ramp.steps, (v) => (ramp.steps = Math.max(0, Math.round(v))));
  }
  const soft = el.querySelector<HTMLInputElement>('[data-k="soft"]');
  if (soft) {
    soft.value = String(s.soft ?? 0);
    soft.onpointerdown = () => ed.pushUndo();
    soft.onkeydown = () => ed.pushUndo();
    soft.oninput = () => {
      const before = s.soft ?? 0;
      const v = Number(soft.value);
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
      s.wall = (wallLook.value || undefined) as WallLook | undefined;
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
  el.querySelector<HTMLButtonElement>('[data-k="del"]')!.onclick = () => ed.remove();
}

// ---------- The shapes (the list at the bottom left) ----------

const TYPE_ICONS: Record<ShapeType, IconName> = { terrain: "terrain", slab: "slab", stand: "stand" };

/** A shape's height, as the list has it. */
const describe = (t: T, s: Shape) =>
  s.kind === "flat" ? (s.rel ? signed(s.h) : fmt(s.h)) : s.kind === "ramp" && s.ramp ? `${fmt(s.ramp.from)}→${fmt(s.ramp.to)}` : s.kind === "ramp" ? t("relief.label.rampNoArrow") : t("relief.label.inclined");

/**
 * Every shape, the top one first, the ground under them; its title under
 * the list (it opens upwards). A click picks one (Ctrl+click: one more), a
 * double click names it, a right click its menu; dragging moves it up or down.
 */
export function renderShapes(el: HTMLElement, ed: ReliefEditor, t: T, folded: { value: boolean }, onMenu: (i: number, x: number, y: number) => void, focusName: () => void) {
  const shapes = ed.data.shapes;
  const picked = ed.sel?.kind === "shape" ? ed.sel.i : -1;
  const more = ed.sel?.kind === "shape" ? (ed.sel.more ?? []) : [];
  const rows = shapes
    .map((s, i) => ({ s, i }))
    .reverse()
    .map(({ s, i }) => {
      const state = i === picked ? "on" : more.includes(i) ? "more" : "";
      return `<div class="item ${state}" draggable="true" data-i="${i}" tabindex="0" role="button" aria-pressed="${i === picked || more.includes(i)}" ${tip(nameOf(t, s, i), t("relief.layerRow"))}>
        ${icon(TYPE_ICONS[typeOf(s)])}<span class="n">${esc(nameOf(t, s, i))}</span><span class="h">${esc(describe(t, s))}</span></div>`;
    })
    .join("");
  el.classList.toggle("closed", folded.value);
  el.innerHTML = `<button type="button" class="lhead" aria-expanded="${!folded.value}"><span class="chev">${icon("expand")}</span><span class="lt">${esc(t("relief.shapes"))}</span><span class="count">${shapes.length}</span></button>
    <div class="lrows" ${folded.value ? "hidden" : ""}>${rows}<div class="item ground" data-ground tabindex="0" role="button" ${tip(t("relief.ground"), t("relief.groundHint"))}>${icon("terrain")}<span class="n">${esc(t("relief.ground"))}</span><span class="h">${esc(t("relief.groundBrush"))}</span></div></div>`;
  el.querySelector<HTMLButtonElement>(".lhead")!.onclick = () => {
    folded.value = !folded.value;
    renderShapes(el, ed, t, folded, onMenu, focusName);
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
  let dragged = -1;
  for (const row of el.querySelectorAll<HTMLElement>(".item[data-i]")) {
    const i = Number(row.dataset.i);
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
      focusName();
    };
    row.oncontextmenu = (event) => {
      event.preventDefault();
      if (!(picked === i || more.includes(i))) {
        pick(i, false);
      }
      onMenu(i, event.clientX, event.clientY);
    };
    row.onmouseenter = () => {
      ed.hover = i;
      ed.host.redraw();
    };
    row.onmouseleave = () => {
      ed.hover = -1;
      ed.host.redraw();
    };
    row.ondragstart = (event) => {
      dragged = i;
      event.dataTransfer!.effectAllowed = "move";
      row.classList.add("dragging");
    };
    row.ondragend = () => row.classList.remove("dragging");
    row.ondragover = (event) => {
      if (dragged >= 0) {
        event.preventDefault();
        row.classList.add("drop");
      }
    };
    row.ondragleave = () => row.classList.remove("drop");
    row.ondrop = (event) => {
      event.preventDefault();
      row.classList.remove("drop");
      moveLayer(ed, dragged, i);
      dragged = -1;
      ed.changed();
      ed.host.showProps();
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
