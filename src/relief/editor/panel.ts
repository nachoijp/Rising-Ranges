import type { TranslationKey } from "../../i18n/translate";
import type { Shape, StandEdge, WallLook } from "../types";
import { corners } from "../stand";
import { BRUSHES, type BrushKind } from "./brush";
import type { ReliefEditor, ToolId } from "./editor";
import { combine, defaultRamp, moveLayer, setKind, setRel, setType, swap, togglePick, type Combine, type ShapeType } from "./shapes";

// The editor's side panel: the tools (icons in groups, a key each), what the
// tool in hand does (and its shortcuts, folded away), the properties of
// what's picked (or of the brush), and the layers, top first, the ground
// under them. Plain DOM: rebuilt whenever what's picked or the tool changes.

export type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

type ToolDef = { id: ToolId; group: "shapes" | "edit" | "terrain"; key: string; keys: [TranslationKey, TranslationKey][] };

const DRAWN: [TranslationKey, TranslationKey][] = [
  ["relief.key.handles", "relief.key.handlesDo"],
  ["relief.key.turnHandle", "relief.key.turnHandleDo"],
  ["relief.key.duplicate", "relief.key.duplicateDo"],
  ["relief.key.arrows", "relief.key.arrowsDo"],
  ["relief.key.escape", "relief.key.escapeDo"],
];
const boxed = (what: TranslationKey): [TranslationKey, TranslationKey][] => [["relief.key.shiftDrag", what], ["relief.key.altDrag", "relief.key.altDragDo"], ...DRAWN];

export const TOOLS: ToolDef[] = [
  { id: "rect", group: "shapes", key: "r", keys: boxed("relief.key.square") },
  { id: "ellipse", group: "shapes", key: "e", keys: boxed("relief.key.circle") },
  { id: "lasso", group: "shapes", key: "l", keys: DRAWN },
  {
    id: "paintShape",
    group: "shapes",
    key: "f",
    keys: [
      ["relief.key.touching", "relief.key.touchingDo"],
      ["relief.key.alt", "relief.key.altCutsDo"],
      ["relief.key.ring", "relief.key.ringDo"],
      ["relief.key.escape", "relief.key.escapeNewDo"],
    ],
  },
  {
    id: "polygon",
    group: "shapes",
    key: "p",
    keys: [
      ["relief.key.shift", "relief.key.freeDo"],
      ["relief.key.backspace", "relief.key.backspaceDo"],
      ["relief.key.escape", "relief.key.cancelDo"],
    ],
  },
  {
    id: "edit",
    group: "edit",
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
    group: "edit",
    key: "k",
    keys: [
      ["relief.key.onePicked", "relief.key.onePickedDo"],
      ["relief.key.shift", "relief.key.by15Do"],
    ],
  },
  {
    id: "brush",
    group: "terrain",
    key: "b",
    keys: [
      ["relief.key.digits", "relief.key.digitsDo"],
      ["relief.key.ctrlPaint", "relief.key.ctrlPaintDo"],
      ["relief.key.altFlatten", "relief.key.altFlattenDo"],
    ],
  },
];

const toolLabel = (id: ToolId) => `relief.tool.${id}` as TranslationKey;
const toolHint = (id: ToolId) => `relief.tool.${id}Hint` as TranslationKey;

/** Text put in HTML as text. */
export const esc = (text: string) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmt = (h: number) => (Math.round(h * 100) / 100).toString();

/** A shape's name: its own, or its place. */
export const nameOf = (t: T, s: Shape, i: number) => s.name || t("relief.shape.name", { n: i + 1 });

// ---------- Tools ----------

/** The tools, a row of icons a group; each its name and key on the pointer. */
export function renderTools(el: HTMLElement, ed: ReliefEditor, t: T, onTool: (id: ToolId) => void) {
  const groups = ["shapes", "edit", "terrain"] as const;
  el.innerHTML = groups
    .map(
      (g) => `<div class="tgroup" role="group" aria-label="${esc(t(`relief.group.${g}` as TranslationKey))}"><p class="group">${esc(t(`relief.group.${g}` as TranslationKey))}</p><div class="tbtns">${TOOLS.filter((tool) => tool.group === g)
        .map((tool) => {
          const name = `${t(toolLabel(tool.id))} (${tool.key.toUpperCase()})`;
          return `<button type="button" data-tool="${tool.id}" title="${esc(name)}" aria-label="${esc(name)}" aria-pressed="${ed.tool === tool.id}" class="${ed.tool === tool.id ? "on" : ""}">${ICONS[tool.id]}</button>`;
        })
        .join("")}</div></div>`
    )
    .join("");
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
    button.onclick = () => onTool(button.dataset.tool as ToolId);
  }
}

/** The tool in hand: its name and key, a line of what it does, its shortcuts folded away (kept open if they were). */
export function renderHint(el: HTMLElement, ed: ReliefEditor, t: T, open: { value: boolean }) {
  const tool = TOOLS.find((x) => x.id === ed.tool)!;
  el.innerHTML = `<b>${esc(t(toolLabel(tool.id)))}</b> <kbd>${tool.key.toUpperCase()}</kbd> · ${esc(t(toolHint(tool.id)))}${
    tool.keys.length > 0
      ? `<details ${open.value ? "open" : ""}><summary>${esc(t("relief.shortcuts"))}</summary><dl>${tool.keys.map(([k, v]) => `<dt>${esc(t(k))}</dt><dd>${esc(t(v))}</dd>`).join("")}</dl></details>`
      : ""
  }`;
  el.querySelector("details")?.addEventListener("toggle", (event) => (open.value = (event.target as HTMLDetailsElement).open));
}

// ---------- The panel's pieces ----------

/** Buttons side by side, one of them on: [value, text, title?]. */
const seg = (name: string, options: [string, string, string?][], value: string) =>
  `<span class="seg" role="group" data-seg="${name}">${options
    .map(([v, text, title]) => `<button type="button" data-v="${v}" class="${v === value ? "on" : ""}" aria-pressed="${v === value}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</button>`)
    .join("")}</span>`;
/** What something means: on the pointer, and read out. */
const info = (text: string) => `<span class="info" tabindex="0" role="img" title="${esc(text)}" aria-label="${esc(text)}">ⓘ</span>`;
/** A labelled line of the panel. */
const field = (label: string, body: string, help = "") => `<div class="field"><span class="flabel">${esc(label)}${help ? ` ${info(help)}` : ""}</span><div class="fbody">${body}</div></div>`;

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

/** A slider showing its value, set as it's moved; `done` after each move. */
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

const STEPS = (t: T) =>
  `<button type="button" data-step="0.5" title="${esc(t("relief.up"))}" aria-label="${esc(t("relief.up"))}">+½</button><button type="button" data-step="-0.5" title="${esc(t("relief.down"))}" aria-label="${esc(t("relief.down"))}">−½</button>`;

function bindSteps(el: HTMLElement, ed: ReliefEditor) {
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-step]")) {
    button.onclick = () => ed.raise(Number(button.dataset.step));
  }
}

const deleteButton = (t: T) => `<button type="button" data-k="del" class="del" title="${esc(t("relief.delete"))}" aria-label="${esc(t("relief.delete"))}">${DEL_ICON}</button>`;

// ---------- Properties ----------

/** What's picked (or the brush): its properties. */
export function renderProps(el: HTMLElement, ed: ReliefEditor, t: T) {
  if (ed.isBrush()) {
    brushProps(el, ed, t);
  } else if (ed.sel?.kind === "shape") {
    if (ed.sel.more?.length) {
      comboProps(el, ed, t);
    } else {
      shapeProps(el, ed, t);
    }
  } else if (ed.sel) {
    pointProps(el, ed, t);
  } else {
    el.innerHTML = `<p class="muted">${esc(t("relief.nothing"))}</p>`;
  }
  if (ed.tool === "paintShape") {
    // The shape brush's size, over what's picked.
    const box = document.createElement("div");
    box.className = "pgroup";
    box.innerHTML = `<p class="ptitle">${esc(t("relief.tool.paintShape"))}</p>
      ${field(t("relief.size"), `<input type="range" min="0.25" max="5" step="0.25" data-k="shapeRadius" aria-label="${esc(t("relief.size"))}" /><span class="val" data-v="shapeRadius"></span>`)}
      <p class="muted">${esc(t(ed.sel?.kind === "shape" ? "relief.paintShape.picked" : "relief.paintShape.new"))}</p>`;
    el.prepend(box);
    bindRange(box, "shapeRadius", () => ed.settings.shapeRadius, (v) => (ed.settings.shapeRadius = v), () => ed.host.saveSettings());
  }
}

function brushProps(el: HTMLElement, ed: ReliefEditor, t: T) {
  const s = ed.settings;
  const kind = s.brushMode;
  const modes = BRUSHES.map((b, i): [string, string, string] => [b, t(`relief.brush.${b}` as TranslationKey), String(i + 1)]);
  el.innerHTML = `
    <p class="ptitle">${esc(t("relief.tool.brush"))}</p>
    ${field(t("relief.brush.does"), seg("mode", modes, kind), t("relief.brush.doesHint"))}
    <p class="muted">${esc(t(`relief.brush.${kind}Text` as TranslationKey))}</p>
    ${field(t("relief.size"), `<input type="range" min="0.25" max="6" step="0.25" data-k="radius" aria-label="${esc(t("relief.size"))}" /><span class="val" data-v="radius"></span>`)}
    ${
      kind === "flatten"
        ? field(t("relief.height"), `<input type="number" step="0.25" data-k="level" aria-label="${esc(t("relief.height"))}" />`)
        : field(t("relief.brush.strength"), `<input type="range" min="0.1" max="2" step="0.1" data-k="strength" aria-label="${esc(t("relief.brush.strength"))}" /><span class="val" data-v="strength"></span>`)
    }
    ${field(t("relief.brush.paints"), seg("target", [["top", t("relief.brush.top")], ["ground", t("relief.brush.ground")]], s.groundOnly ? "ground" : "top"), t("relief.brush.paintsHint"))}`;
  const saved = () => ed.host.saveSettings();
  onSeg(el, "mode", (v) => {
    s.brushMode = v as BrushKind;
    saved();
    ed.host.showProps();
  });
  onSeg(el, "target", (v) => {
    s.groundOnly = v === "ground";
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
}

/** A vertex, some vertices, or a height point picked: their height. */
function pointProps(el: HTMLElement, ed: ReliefEditor, t: T) {
  const sel = ed.sel!;
  const title = sel.kind === "verts" ? t("relief.vertices", { n: sel.list.length }) : sel.kind === "vertex" ? t("relief.vertex") : t("relief.point");
  el.innerHTML = `
    <div class="ptitle"><span class="grow">${esc(title)}</span>${deleteButton(t)}</div>
    ${field(t("relief.height"), `<input type="number" step="0.25" data-k="h" aria-label="${esc(t("relief.height"))}" />${STEPS(t)}`)}
    <p class="muted">${esc(t(sel.kind === "point" ? "relief.pointText" : "relief.vertexText"))}</p>`;
  const targets = ed.targets();
  const input = el.querySelector<HTMLInputElement>('[data-k="h"]')!;
  const same = targets.every((x) => x.h === targets[0].h);
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
  const op = (id: Combine, label: TranslationKey, hint: TranslationKey) =>
    `<button type="button" data-op="${id}" title="${esc(t(hint, { first }))}">${OP_ICONS[id]}${esc(t(label))}</button>`;
  el.innerHTML = `
    <p class="ptitle">${esc(t("relief.combo.title", { n: more.length + 1 }))}</p>
    <div class="ops">
      ${op("union", "relief.combo.union", "relief.combo.unionHint")}
      ${op("difference", "relief.combo.difference", "relief.combo.differenceHint")}
      ${op("intersection", "relief.combo.intersection", "relief.combo.intersectionHint")}
      ${op("xor", "relief.combo.xor", "relief.combo.xorHint")}
    </div>
    ${ed.notice ? `<p class="warn" role="status">${esc(t(ed.notice === "nothingShared" ? "relief.combo.nothingShared" : "relief.combo.nothingLeft"))}</p>` : ""}
    <p class="muted">${esc(t("relief.combo.result", { first }))}</p>
    <p class="muted">${esc(t("relief.combo.ctrl"))}</p>
    <button type="button" data-k="single">${esc(t("relief.combo.single", { first }))}</button>`;
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-op]")) {
    button.onclick = () => {
      const id = button.dataset.op as Combine;
      if (combine(ed, id)) {
        ed.notice = null;
        ed.changed();
      } else {
        ed.notice = id === "intersection" ? "nothingShared" : "nothingLeft";
      }
      ed.host.showProps();
    };
  }
  el.querySelector<HTMLButtonElement>('[data-k="single"]')!.onclick = () => {
    ed.sel = { kind: "shape", i };
    ed.host.showProps();
    ed.host.redraw();
  };
}

const STAND_EDGES: StandEdge[] = ["auto", "bottom", "top", "left", "right"];
const WALL_LOOKS: ("" | WallLook)[] = ["", "flat", "stretch", "fold", "stone", "rubble", "earth", "wood"];

function shapeProps(el: HTMLElement, ed: ReliefEditor, t: T) {
  const si = (ed.sel as { i: number }).i;
  const s = ed.data.shapes[si];
  const slope = s.kind === "slope";
  const type: ShapeType = s.slab && s.slab > 0 ? "slab" : s.stand ? "stand" : "terrain";
  const number = (key: string, label: string, min = "") => `<input type="number" step="0.25" ${min !== "" ? `min="${min}"` : ""} data-k="${key}" aria-label="${esc(label)}" />`;
  const quad = corners(ed.relief.coordsOf(s)[0]).length === 4;
  let height = "";
  if (s.kind === "flat") {
    height = field(t("relief.height"), `${number("h", t("relief.height"))}${STEPS(t)}`);
  } else if (s.kind === "ramp" && s.ramp) {
    height =
      field(t("relief.height"), `${number("from", t("relief.height"))}<span class="muted">→</span>${number("to", t("relief.height"))}${STEPS(t)}`, t("relief.shape.rampHint")) +
      field(t("relief.shape.steps"), number("steps", t("relief.shape.steps"), "0"), t("relief.shape.stepsHint")) +
      field(
        t("relief.shape.arrow"),
        `<button type="button" data-k="flip" title="${esc(t("relief.shape.flipHint"))}">${esc(t("relief.shape.flip"))}</button><button type="button" data-k="rearrow" title="${esc(t("relief.shape.rearrowHint"))}">${esc(t("relief.shape.rearrow"))}</button>`
      );
  } else if (s.kind === "ramp") {
    height = `<p class="warn">${esc(t("relief.shape.noArrow"))}</p><button type="button" data-k="rearrow">${esc(t("relief.shape.addArrow"))}</button>`;
  } else {
    height = field(t("relief.height"), STEPS(t), t("relief.shape.slopeAllHint")) + `<p class="muted">${esc(t("relief.shape.slopeText"))}</p>`;
  }
  const picture =
    ed.skinPick === si
      ? `<span class="warn">${esc(t("relief.shape.picking"))}</span>`
      : s.skin
        ? `<button type="button" data-k="skin">${esc(t("relief.shape.retake"))}</button><button type="button" data-k="noskin">${esc(t("relief.shape.removePicture"))}</button>`
        : `<button type="button" data-k="skin">${esc(t("relief.shape.take"))}</button>`;
  el.innerHTML = `
    <div class="ptitle"><input class="name" data-k="name" value="${esc(s.name ?? "")}" placeholder="${esc(t("relief.shape.name", { n: si + 1 }))}" title="${esc(t("relief.shape.nameHint"))}" aria-label="${esc(t("relief.shape.nameHint"))}" />${deleteButton(t)}</div>
    ${field(t("relief.shape.type"), seg("type", [["terrain", t("relief.shape.terrain")], ["slab", t("relief.shape.slab"), t("relief.shape.slabHint")], ["stand", t("relief.shape.stand"), t("relief.shape.standHint")]], type), t("relief.shape.typeHint"))}
    ${s.slab && s.slab > 0 ? field(t("relief.shape.thickness"), number("slab", t("relief.shape.thickness"), "0.25")) : ""}
    ${s.stand ? field(t("relief.shape.standsOn"), `<select data-k="stand" aria-label="${esc(t("relief.shape.standsOn"))}">${STAND_EDGES.map((v) => `<option value="${v}" ${s.stand === v ? "selected" : ""}>${esc(t(`relief.stand.${v}` as TranslationKey))}</option>`).join("")}</select>`, t("relief.shape.standsOnHint")) : ""}
    ${s.stand ? field("", `<label class="check"><input type="checkbox" data-k="wrap" ${s.wrap ? "checked" : ""} /> ${esc(t("relief.shape.wrap"))}</label>`, t(quad ? "relief.shape.wrapHint4" : "relief.shape.wrapHint")) : ""}
    ${s.stand ? "" : field(t("relief.shape.surface"), seg("kind", [["flat", t("relief.shape.flat")], ["ramp", t("relief.shape.ramp")], ["slope", t("relief.shape.slope"), t("relief.shape.slopeHint")]], s.kind))}
    ${height}
    ${slope ? "" : field(t("relief.shape.measured"), seg("rel", [["rel", t("relief.shape.rel")], ["abs", t("relief.shape.abs")]], s.rel ? "rel" : "abs"), t("relief.shape.measuredHint"))}
    ${s.slab || s.stand ? "" : field(t("relief.shape.edge"), `<input type="range" min="0" max="8" step="0.5" data-k="soft" aria-label="${esc(t("relief.shape.edge"))}" /><span class="val" data-v="softText"></span>`, t("relief.shape.edgeHint"))}
    ${s.stand ? "" : field(t("relief.shape.walls"), `<select data-k="wall" ${s.skin ? "disabled" : ""} aria-label="${esc(t("relief.shape.walls"))}">${WALL_LOOKS.map((v) => `<option value="${v}" ${(s.wall ?? "") === v ? "selected" : ""}>${esc(t(`relief.wall.${v || "default"}` as TranslationKey))}</option>`).join("")}</select>`, t("relief.shape.wallsHint"))}
    ${s.stand ? "" : field(t("relief.shape.picture"), picture, t("relief.shape.pictureHint"))}
    ${s.slab || s.stand ? "" : field(t("relief.shape.water"), number("water", t("relief.shape.water"), "0"), t("relief.shape.waterHint"))}
    ${s.holes?.length ? `<p class="muted">${esc(s.holes.length === 1 ? t("relief.shape.hole") : t("relief.shape.holes", { n: s.holes.length }))}</p>` : ""}`;
  const redo = () => {
    ed.changed();
    ed.host.showProps();
  };
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
    const show = el.querySelector<HTMLElement>('[data-v="softText"]')!;
    const text = () => (s.soft && s.soft > 0 ? fmt(s.soft) : t("relief.shape.wall"));
    soft.value = String(s.soft ?? 0);
    show.textContent = text();
    soft.onpointerdown = () => ed.pushUndo();
    soft.onkeydown = () => ed.pushUndo();
    soft.oninput = () => {
      const v = Number(soft.value);
      s.soft = v > 0 ? v : undefined;
      ed.settings.lastSoft = s.soft ?? 0;
      show.textContent = text();
      ed.host.saveSettings();
      ed.changed();
    };
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

// ---------- Layers ----------

/**
 * Every layer, the top one first, the ground under them: a click picks one
 * (Ctrl+click: one more), a double click names it, dragging moves it (↑ and ↓
 * too, from the keyboard).
 */
export function renderLayers(el: HTMLElement, ed: ReliefEditor, t: T, focusName: () => void) {
  const shapes = ed.data.shapes;
  const picked = ed.sel?.kind === "shape" ? ed.sel.i : -1;
  const more = ed.sel?.kind === "shape" ? (ed.sel.more ?? []) : [];
  const describe = (s: Shape) => {
    const height = s.kind === "flat" ? (s.rel ? `+${fmt(s.h)}` : fmt(s.h)) : s.kind === "ramp" && s.ramp ? `${fmt(s.ramp.from)}→${fmt(s.ramp.to)}` : s.kind === "ramp" ? t("relief.label.rampNoArrow") : t("relief.label.inclined");
    return `${height}${s.soft && s.soft > 0 && !s.slab && !s.stand ? " ≈" : ""}${s.holes?.length ? " ◌" : ""}`;
  };
  const rows = shapes
    .map((s, i) => ({ s, i }))
    .reverse()
    .map(({ s, i }) => {
      const kind = s.slab && s.slab > 0 ? "slab" : s.stand ? "stand" : "terrain";
      const state = i === picked ? "on" : more.includes(i) ? "more" : "";
      return `<div class="layer ${state}" draggable="true" data-i="${i}" tabindex="0" role="button" aria-pressed="${i === picked || more.includes(i)}" title="${esc(t("relief.layerRow"))}">
        <span class="licon">${KIND_ICONS[kind]}</span><span class="lname">${esc(nameOf(t, s, i))}</span><span class="lh">${esc(describe(s))}</span>
        <button type="button" data-up="${i}" title="${esc(t("relief.layerUp"))}" aria-label="${esc(t("relief.layerUp"))}" ${i === shapes.length - 1 ? "disabled" : ""}>↑</button><button type="button" data-down="${i}" title="${esc(t("relief.layerDown"))}" aria-label="${esc(t("relief.layerDown"))}" ${i === 0 ? "disabled" : ""}>↓</button>
      </div>`;
    })
    .join("");
  el.innerHTML = `<p class="lhead">${esc(t("relief.layers"))} <span class="muted">· ${esc(t("relief.layersHint"))}</span></p>
    <div class="lrows">${rows}<div class="layer ground" data-ground tabindex="0" role="button" title="${esc(t("relief.groundHint"))}"><span class="licon">${GROUND_ICON}</span><span class="lname">${esc(t("relief.ground"))}</span><span class="lh">${esc(t("relief.groundBrush"))}</span></div></div>`;
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
  for (const row of el.querySelectorAll<HTMLElement>(".layer[data-i]")) {
    const i = Number(row.dataset.i);
    row.onclick = (event) => {
      if ((event.target as HTMLElement).closest("button")) {
        return;
      }
      pick(i, event.ctrlKey || event.metaKey);
    };
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
  const ground = el.querySelector<HTMLElement>("[data-ground]")!;
  ground.onclick = () => ed.setTool("brush");
  ground.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      ed.setTool("brush");
    }
  };
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-up]")) {
    button.onclick = () => {
      swap(ed, Number(button.dataset.up), Number(button.dataset.up) + 1);
      ed.changed();
      ed.host.showProps();
    };
  }
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-down]")) {
    button.onclick = () => {
      swap(ed, Number(button.dataset.down), Number(button.dataset.down) - 1);
      ed.changed();
      ed.host.showProps();
    };
  }
}

// ---------- Icons ----------

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS: Record<ToolId, string> = {
  rect: svg('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
  ellipse: svg('<ellipse cx="12" cy="12" rx="9" ry="6"/>'),
  lasso: svg('<path d="M6 15c-2-2-2-6 1-8s8-3 11 0 2 7-3 8-7 0-8 2 1 3 2 3"/>'),
  paintShape: svg('<path d="M5 15c2-5 5-5 7-2s5 3 7-2" stroke-width="5" opacity=".45"/><path d="M5 15c2-5 5-5 7-2s5 3 7-2"/>'),
  polygon: svg(
    '<path d="M5 18 4 9l7-5 8 4-2 10z"/><circle cx="5" cy="18" r="1.3" fill="currentColor"/><circle cx="4" cy="9" r="1.3" fill="currentColor"/><circle cx="11" cy="4" r="1.3" fill="currentColor"/><circle cx="19" cy="8" r="1.3" fill="currentColor"/><circle cx="17" cy="18" r="1.3" fill="currentColor"/>'
  ),
  edit: svg('<path d="M6 3l12 9-5.5 1L10 19z"/>'),
  cut: svg('<circle cx="6" cy="17" r="3"/><circle cx="6" cy="7" r="3"/><path d="M8.5 15.5 20 5M8.5 8.5 20 19"/>'),
  brush: svg('<path d="M19 3l2 2-9 9-2-2z"/><path d="M9 13c-3 0-5 2-5 6 3 0 6-1 6-4z"/>'),
};

/** A layer's mark in the list: terrain, slab or standing. */
const KIND_ICONS = {
  terrain: svg('<path d="M3 18l6-8 4 5 3-3 5 6z"/>'),
  slab: svg('<path d="M3 9h18v3H3z"/><path d="M6 12v7M18 12v7"/>'),
  stand: svg('<rect x="8" y="4" width="8" height="16" rx="1"/><path d="M4 20h16"/>'),
};
const GROUND_ICON = svg('<path d="M3 17c4-3 6 1 9-1s5-3 9 0"/>');

/** Two circles, and what each operation keeps of them (filled). */
const op = (kept: string) => svg(`<defs><clipPath id="opA"><circle cx="9" cy="12" r="6"/></clipPath></defs>${kept}<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>`);
const fill = (cx: number, extra = "") => `<circle cx="${cx}" cy="12" r="6" fill="currentColor" opacity=".45" stroke="none"${extra}/>`;
const OP_ICONS: Record<Combine, string> = {
  union: op(fill(9) + fill(15)),
  difference: op(fill(9) + '<circle cx="15" cy="12" r="6" fill="var(--panel)" stroke="none" clip-path="url(#opA)"/>'),
  intersection: op(fill(15, ' clip-path="url(#opA)"')),
  xor: op(fill(9) + fill(15) + '<circle cx="15" cy="12" r="6" fill="var(--panel)" stroke="none" clip-path="url(#opA)"/>'),
};
const DEL_ICON = svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>');
