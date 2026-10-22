import { bbox, centroid, inBox, inShape, type Box } from "../geom";
import { compose, inverse, quarter, Relief, type Layer } from "../relief";
import { fromStored, toStored } from "../codec";
import type { Affine, Pt, ReliefData, Shape } from "../types";
import { BRUSHES, paintBrush, type BrushKind } from "./brush";
import {
  addShape,
  cut,
  duplicate,
  finishPolygon,
  keepPick,
  layerOf,
  loopsOf,
  paintShape,
  prune,
  quadOf,
  removeVertex,
  simplify,
  skinFrom,
  snap,
  togglePick,
  vertexAt,
  vertsOf,
  type Snap,
} from "./shapes";

// The relief editor without its page: the tool in hand, what's picked, and
// what the pointer and the keys do to the relief (in cells). The page (see
// page.ts) draws it and holds the panel; it hears of each change through the
// host. Ported from the mockup's editor F (dev-tests/tmp/mockup).

export type ToolId = "rect" | "ellipse" | "lasso" | "paintShape" | "polygon" | "edit" | "cut" | "brush";

export type Selection =
  | { kind: "shape"; i: number; more?: number[] }
  | { kind: "vertex"; i: number }
  | { kind: "verts"; list: number[] }
  | { kind: "point"; i: number };

/** A pointer event's keys, and how many clicks it is (2: a double click). */
export type Mods = { shift?: boolean; alt?: boolean; ctrl?: boolean; clicks?: number };

/** A key pressed: as the browser names it (`key`, `code`), with its modifiers. */
export type KeyPress = { key: string; code?: string; ctrl?: boolean; shift?: boolean; alt?: boolean };

/** What the editor needs of its page. */
export interface EditorHost {
  /** The relief changed (worked out again): draw it again and keep it. */
  changed(): void;
  /** What's picked (or the tool) changed: the panel again. */
  showProps(): void;
  /** Only the map view's marks moved (the cursor, a drag): drawn again. */
  redraw(): void;
  setCursor(cursor: string): void;
  /** How near (cells) the pointer snaps to a vertex or a side: some pixels on screen. */
  snapReach(): number;
  /** A cell point on the screen (px), for the handles. */
  toScreen(x: number, y: number): [number, number];
  /** The editor's own settings changed (the brush's, the last soft edge): kept. */
  saveSettings(): void;
}

export type Settings = {
  radius: number;
  strength: number;
  level: number;
  /** The soft edge new shapes get: the last one set (0: a wall). */
  lastSoft: number;
  groundOnly: boolean;
  shapeRadius: number;
  brushMode: BrushKind;
};

export const DEFAULT_SETTINGS: Settings = { radius: 1.5, strength: 0.5, level: 1, lastSoft: 0, groundOnly: false, shapeRadius: 1, brushMode: "raise" };

/** An ellipse's points. */
const SHAPE_POINTS = 24;
/** The most undo steps kept. */
const UNDO_STEPS = 80;

type Handle = { id: string; sx: number; sy: number; ax?: number; ay?: number; cursor: string };
type Handles = { box: Box; list: Handle[]; rot: { sx: number; sy: number }; rect: [number, number, number, number] };
type Grab = { kind: "rotate" | "scale" | "move"; h: Handles; handle?: Handle };
type Transform = Grab & {
  from: { x: number; y: number };
  start: Pt[];
  idx: number[];
  ramps: { s: Shape; a: Pt; b: Pt }[];
  center: Pt;
  detail?: { s: Shape; m: Affine };
};

export class ReliefEditor {
  relief: Relief;
  host: EditorHost;
  tool: ToolId = "rect";
  sel: Selection | null = null;
  settings: Settings;

  // What's under way (each only while it lasts).
  drawing: number[] | null = null;
  shape: { start: { x: number; y: number }; end: { x: number; y: number }; path: Pt[]; origin?: { x: number; y: number } } | null = null;
  box: { start: { x: number; y: number }; end: { x: number; y: number }; add: boolean } | null = null;
  drag: { kind: "vertex" | "point"; i: number } | { group: number[]; from: { x: number; y: number }; start: Pt[] } | null = null;
  xf: Transform | null = null;
  knife: { a: Pt; b: Pt; only: number | null } | null = null;
  stroke: { pts: Pt[]; erase: boolean } | null = null;
  /** Taking a wall picture for this shape: the next drag (a rectangle) or click (another shape). */
  skinPick: number | null = null;
  skinBox: { start: { x: number; y: number }; end: { x: number; y: number } } | null = null;
  arrowEnd: { s: Shape; end: "a" | "b" } | null = null;
  brushing = false;
  /** Ctrl held while brushing: raise and lower swapped. */
  flip = false;
  cursor: { x: number; y: number; snap?: Snap | null } | null = null;
  /** The shape the pointer's over (-1: none). */
  hover = -1;
  /** Why the last combining changed nothing. */
  notice: "nothingShared" | "nothingLeft" | null = null;

  private undoStack: string[] = [];

  constructor(data: ReliefData, host: EditorHost, settings: Partial<Settings> = {}) {
    this.relief = new Relief(data);
    this.host = host;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
  }

  get data(): ReliefData {
    return this.relief.data;
  }

  /** The relief worked out again, and the page told. */
  changed() {
    this.relief.derive();
    this.host.changed();
  }

  heightAt(x: number, y: number): number | undefined {
    return this.relief.heightAt(x, y);
  }

  /** The shape on top at a point (-1: none). */
  shapeAt(x: number, y: number): number {
    const pieces = this.relief.pieces;
    for (let i = pieces.length - 1; i >= 0; i--) {
      const piece = pieces[i];
      if (inBox(piece.box, x, y) && inShape(x, y, piece.ring, piece.holes)) {
        return piece.si;
      }
    }
    return -1;
  }

  // ---------- Undo ----------

  pushUndo() {
    this.undoStack.push(JSON.stringify(toStored(this.data)));
    if (this.undoStack.length > UNDO_STEPS) {
      this.undoStack.shift();
    }
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  undo() {
    const last = this.undoStack.pop();
    const data = last ? fromStored(JSON.parse(last)) : null;
    if (!data) {
      return;
    }
    this.relief = new Relief(data);
    this.sel = null;
    this.drawing = null;
    this.changed();
    this.host.showProps();
  }

  // ---------- Tools ----------

  /** Another tool in hand: what's picked stays picked (to cut only it, or paint onto it); an outline half drawn is dropped. */
  setTool(tool: ToolId) {
    this.tool = tool;
    this.skinPick = null;
    this.cursor = null;
    if (this.drawing) {
      this.drawing = null;
      keepPick(this, () => prune(this));
      this.changed();
    }
    this.host.showProps();
    this.host.redraw();
  }

  isBrush(tool = this.tool) {
    return tool === "brush";
  }

  isShapeTool(tool = this.tool) {
    return tool === "rect" || tool === "ellipse" || tool === "lasso";
  }

  /** What the brush does now: as chosen, or (Ctrl held) raise and lower swapped. */
  get brushKind(): BrushKind {
    const kind = this.settings.brushMode;
    return this.flip && (kind === "raise" || kind === "lower") ? (kind === "raise" ? "lower" : "raise") : kind;
  }

  // ---------- The pointer ----------

  down(p: { x: number; y: number }, mods: Mods = {}) {
    // Taking a shape's wall picture: a rectangle dragged over the map, or a click on another shape.
    if (this.skinPick !== null) {
      this.skinBox = { start: p, end: p };
      return;
    }
    if (this.isBrush()) {
      this.pushUndo();
      this.flip = !!mods.ctrl;
      if (this.brushKind === "flatten" && mods.alt) {
        this.settings.level = quarter(this.heightAt(p.x, p.y) ?? 0);
        this.host.saveSettings();
        this.host.showProps();
        return;
      }
      this.brushing = true;
      this.paint(p);
      return;
    }
    if (this.tool === "paintShape") {
      this.stroke = { pts: [[p.x, p.y]], erase: !!mods.alt };
      this.cursor = p;
      this.host.redraw();
      return;
    }
    if (this.tool === "cut") {
      this.knife = { a: [p.x, p.y], b: [p.x, p.y], only: this.sel?.kind === "shape" ? this.sel.i : null };
      return;
    }
    if (this.tool === "edit" && !this.drawing && mods.ctrl) {
      const si = this.shapeAt(p.x, p.y);
      if (si >= 0) {
        togglePick(this, si);
        this.notice = null;
        this.host.showProps();
        this.host.redraw();
        return;
      }
    }
    if (this.tool === "edit" && !this.drawing && this.editDown(p, mods)) {
      return;
    }
    // On what's picked: its handles (size, turn), or inside it (move). Not while drawing an outline.
    if (!this.drawing && this.tool !== "polygon" && this.startTransform(p)) {
      return;
    }
    if (this.tool === "polygon") {
      if (!this.drawing) {
        this.pushUndo();
        this.drawing = [];
      }
      const at = snap(this, p, !!mods.shift);
      if (this.drawing.length >= 3 && at && "vertex" in at && at.vertex === this.drawing[0]) {
        finishPolygon(this);
        this.changed();
        this.host.showProps();
        return;
      }
      if (at && "vertex" in at && this.drawing.includes(at.vertex)) {
        return;
      }
      this.drawing.push(vertexAt(this, p, at));
      this.changed();
      return;
    }
    if (this.isShapeTool()) {
      this.pushUndo();
      // Where it started, for Shift (square) and Alt (from the middle).
      this.shape = { start: p, end: p, path: [[p.x, p.y]], origin: this.tool === "lasso" ? undefined : { x: p.x, y: p.y } };
      return;
    }
    // Edit: a vertex, a point, the shape under it; or, on nothing, a box to pick vertices with.
    const reach = this.host.snapReach();
    const used = new Set(this.data.shapes.flatMap(vertsOf));
    const vi = this.data.verts.findIndex((v, i) => used.has(i) && Math.hypot(v.x - p.x, v.y - p.y) < reach);
    const pi = this.data.points.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < reach);
    const sel = this.sel;
    if (vi >= 0 || pi >= 0) {
      this.pushUndo();
      // A vertex in the group picked drags the group.
      if (vi >= 0 && sel?.kind === "verts" && sel.list.includes(vi)) {
        this.drag = { group: sel.list, from: p, start: sel.list.map((i): Pt => [this.data.verts[i].x, this.data.verts[i].y]) };
      } else {
        const picked = vi >= 0 ? ({ kind: "vertex", i: vi } as const) : ({ kind: "point", i: pi } as const);
        this.sel = picked;
        this.drag = picked;
      }
    } else if (mods.alt || mods.shift || this.shapeAt(p.x, p.y) < 0) {
      this.box = { start: p, end: p, add: !!mods.shift };
    } else {
      this.sel = { kind: "shape", i: this.shapeAt(p.x, p.y) };
    }
    this.host.showProps();
    this.host.redraw();
  }

  /** Choosing (Elegir) on what's under the pointer, before the rest: a ramp's arrow end, Alt (remove), a double click (add). */
  private editDown(p: { x: number; y: number }, mods: Mods): boolean {
    // A picked ramp's arrow: its ends, dragged.
    const end = this.arrowEndAt(p);
    if (end) {
      this.pushUndo();
      this.arrowEnd = end;
      return true;
    }
    const reach = this.host.snapReach();
    const data = this.data;
    const used = new Set(data.shapes.flatMap(vertsOf));
    const vi = data.verts.findIndex((v, i) => used.has(i) && Math.hypot(v.x - p.x, v.y - p.y) < reach);
    const pi = data.points.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < reach);
    if (mods.alt && vi < 0 && pi >= 0) {
      this.pushUndo();
      data.points.splice(pi, 1);
      this.sel = null;
      this.changed();
      this.host.showProps();
      return true;
    }
    if (mods.alt && vi >= 0) {
      this.pushUndo();
      removeVertex(this, vi);
      this.changed();
      return true;
    }
    if (mods.clicks === 2 && vi < 0 && pi < 0) {
      const at = snap(this, p, false);
      if (at && "edge" in at) {
        this.pushUndo();
        vertexAt(this, p, at);
        this.changed();
        return true;
      }
      // Inside an inclined shape: a point with its own height, where its surface is now.
      const si = this.shapeAt(p.x, p.y);
      if (si >= 0 && data.shapes[si].kind === "slope") {
        this.xf = null;
        this.pushUndo();
        data.points.push({ x: p.x, y: p.y, h: quarter(this.heightAt(p.x, p.y) ?? 0) });
        this.sel = { kind: "point", i: data.points.length - 1 };
        this.changed();
        this.host.showProps();
        return true;
      }
    }
    return false;
  }

  move(p: { x: number; y: number }, mods: Mods = {}, held = false) {
    if (this.isBrush()) {
      this.cursor = p;
      this.flip = !!mods.ctrl;
      if (held && this.brushing && !(this.brushKind === "flatten" && mods.alt)) {
        this.paint(p);
      } else {
        this.host.redraw();
      }
      return;
    }
    if (this.skinPick !== null) {
      this.host.setCursor("crosshair");
      if (held && this.skinBox) {
        this.skinBox.end = p;
        this.host.redraw();
      }
      return;
    }
    if (held && this.arrowEnd) {
      this.arrowEnd.s.ramp![this.arrowEnd.end] = [p.x, p.y];
      this.changed();
      return;
    }
    if (held && this.shape?.origin) {
      const o = this.shape.origin;
      let [dx, dy] = [p.x - o.x, p.y - o.y];
      if (mods.shift) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        [dx, dy] = [(dx < 0 ? -1 : 1) * d, (dy < 0 ? -1 : 1) * d];
      }
      this.shape.start = mods.alt ? { x: o.x - dx, y: o.y - dy } : o;
      this.shape.end = { x: o.x + dx, y: o.y + dy };
      this.host.redraw();
      return;
    }
    if (!held && this.tool === "edit" && this.arrowEndAt(p)) {
      this.cursor = p;
      this.host.setCursor("grab");
      return;
    }
    if (this.tool === "paintShape") {
      this.cursor = p;
      this.host.setCursor("crosshair");
      if (held && this.stroke) {
        const last = this.stroke.pts[this.stroke.pts.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) > this.settings.shapeRadius * 0.3) {
          this.stroke.pts.push([p.x, p.y]);
        }
      }
      this.host.redraw();
      return;
    }
    if (this.tool === "cut") {
      this.cursor = p;
      this.host.setCursor("crosshair");
      if (held && this.knife) {
        const [ax, ay] = this.knife.a;
        let [dx, dy] = [p.x - ax, p.y - ay];
        // Shift: in steps of 15 degrees.
        if (mods.shift) {
          const step = Math.PI / 12;
          const angle = Math.round(Math.atan2(dy, dx) / step) * step;
          const len = Math.hypot(dx, dy);
          [dx, dy] = [Math.cos(angle) * len, Math.sin(angle) * len];
        }
        this.knife.b = [ax + dx, ay + dy];
      } else {
        this.hover = this.shapeAt(p.x, p.y);
      }
      this.host.redraw();
      return;
    }
    this.cursor = { ...p, snap: this.tool === "polygon" ? snap(this, p, !!mods.shift) : null };
    if (held && this.xf) {
      this.transform(p, mods);
      return;
    }
    if (!held) {
      this.hover = this.tool === "edit" || this.isShapeTool() ? this.shapeAt(p.x, p.y) : -1;
      this.host.setCursor(this.cursorFor(p));
    }
    if (held && this.shape) {
      this.shape.end = p;
      const last = this.shape.path[this.shape.path.length - 1];
      if (Math.hypot(last[0] - p.x, last[1] - p.y) > 0.1) {
        this.shape.path.push([p.x, p.y]);
      }
    } else if (held && this.box) {
      this.box.end = p;
    } else if (held && this.drag) {
      const verts = this.data.verts;
      if ("group" in this.drag) {
        const drag = this.drag;
        drag.group.forEach((i, k) => {
          verts[i].x = drag.start[k][0] + p.x - drag.from.x;
          verts[i].y = drag.start[k][1] + p.y - drag.from.y;
        });
      } else {
        const target = this.drag.kind === "vertex" ? verts[this.drag.i] : this.data.points[this.drag.i];
        target.x = p.x;
        target.y = p.y;
      }
      this.changed();
      return;
    }
    this.host.redraw();
  }

  up() {
    this.brushing = false;
    if (this.skinBox) {
      this.takeSkin();
      return;
    }
    if (this.arrowEnd) {
      this.arrowEnd = null;
      this.host.showProps();
    }
    if (this.stroke) {
      const { pts, erase } = this.stroke;
      this.stroke = null;
      paintShape(this, pts, erase);
      this.changed();
      this.host.showProps();
    }
    if (this.knife) {
      const { a, b, only } = this.knife;
      this.knife = null;
      if (cut(this, a, b, only)) {
        this.changed();
        this.host.showProps();
      }
      this.host.redraw();
    }
    if (this.xf) {
      this.xf = null;
      this.host.showProps();
    }
    if (this.shape) {
      const { start: a, end: b, path } = this.shape;
      this.shape = null;
      const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
      if (this.tool === "rect") {
        addShape(this, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
      } else if (this.tool === "ellipse") {
        const [cx, cy, rx, ry] = [(x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2];
        addShape(this, Array.from({ length: SHAPE_POINTS }, (_, k): Pt => [cx + Math.cos((k / SHAPE_POINTS) * Math.PI * 2) * rx, cy + Math.sin((k / SHAPE_POINTS) * Math.PI * 2) * ry]));
      } else {
        addShape(this, simplify(path, 0.15));
      }
      this.changed();
      this.host.showProps();
    }
    if (this.box) {
      const { start: a, end: b, add } = this.box;
      this.box = null;
      const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
      const verts = this.data.verts;
      const used = new Set(this.data.shapes.flatMap(vertsOf));
      const inside = verts.map((_, i) => i).filter((i) => used.has(i) && verts[i].x >= x0 && verts[i].x <= x1 && verts[i].y >= y0 && verts[i].y <= y1);
      const before = add && this.sel?.kind === "verts" ? this.sel.list : [];
      const list = [...new Set([...before, ...inside])];
      this.sel = list.length > 0 ? { kind: "verts", list } : null;
      this.host.showProps();
      this.host.redraw();
    }
    this.drag = null;
  }

  /** The wall picture's rectangle (or the shape clicked on) given to the shape it was asked for. */
  private takeSkin() {
    const { start: a, end: b } = this.skinBox!;
    const si = this.skinPick!;
    this.skinBox = null;
    this.skinPick = null;
    const [x0, y0, x1, y1] = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
    // A click on another shape: its outline; a drag: the rectangle.
    const other = Math.hypot(b.x - a.x, b.y - a.y) < 0.2 ? this.shapeAt(a.x, a.y) : -1;
    const quad: Pt[] | null =
      other >= 0 && other !== si ? quadOf(this, other) : x1 - x0 > 0.2 && y1 - y0 > 0.2 ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] : null;
    if (quad && this.data.shapes[si]) {
      this.pushUndo();
      this.data.shapes[si].skin = skinFrom(this, quad, si);
      this.sel = { kind: "shape", i: si };
      this.changed();
    }
    this.host.showProps();
    this.host.redraw();
  }

  /** The end of the picked ramp's arrow under the pointer, or null. */
  arrowEndAt(p: { x: number; y: number }): { s: Shape; end: "a" | "b" } | null {
    const s = this.sel?.kind === "shape" && !this.sel.more?.length ? this.data.shapes[this.sel.i] : null;
    if (s?.kind !== "ramp" || !s.ramp) {
      return null;
    }
    const reach = this.host.snapReach() * 1.2;
    for (const end of ["b", "a"] as const) {
      if (Math.hypot(s.ramp[end][0] - p.x, s.ramp[end][1] - p.y) < reach) {
        return { s, end };
      }
    }
    return null;
  }

  /** A dab of the brush at `p` (see brush.ts), as the settings have it. */
  paint(p: { x: number; y: number }) {
    const { radius, strength, level, groundOnly } = this.settings;
    paintBrush(this.relief, p, { kind: this.brushKind, radius, strength, level, groundOnly });
    this.changed();
  }

  // ---------- Keys ----------

  /** A key pressed: whether the editor took it. */
  key(e: KeyPress): boolean {
    if (this.skinPick !== null && e.key === "Escape") {
      this.skinPick = null;
      this.skinBox = null;
      this.host.showProps();
      this.host.redraw();
      return true;
    }
    const digit = this.isBrush() && !e.ctrl && !e.alt ? Number(e.key) : 0;
    if (digit >= 1 && digit <= BRUSHES.length) {
      this.settings.brushMode = BRUSHES[digit - 1];
      this.host.saveSettings();
      this.host.showProps();
      return true;
    }
    if (this.drawing) {
      if (e.key === "Enter") {
        finishPolygon(this);
        this.changed();
        this.host.showProps();
        return true;
      }
      if (e.key === "Escape") {
        this.drawing = null;
        prune(this);
        this.changed();
        return true;
      }
      if (e.key === "Backspace") {
        this.drawing.pop();
        if (this.drawing.length === 0) {
          this.drawing = null;
        }
        prune(this);
        this.changed();
        return true;
      }
    }
    const sel = this.sel;
    if (!sel) {
      return false;
    }
    if (e.key === "Escape") {
      this.sel = null;
      this.host.showProps();
      this.host.redraw();
      return true;
    }
    if (e.ctrl && e.code === "KeyD") {
      duplicate(this);
      this.changed();
      this.host.showProps();
      return true;
    }
    const nudge = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, Pt>)[e.key];
    if (nudge && this.selectedVerts().length > 0) {
      this.pushUndo();
      const step = e.shift ? 1 : 0.25;
      this.moveSelection((x, y) => [x + nudge[0] * step, y + nudge[1] * step]);
      this.changed();
      return true;
    }
    if (e.key === "Delete") {
      this.remove();
      return true;
    }
    const step = e.code === "KeyZ" && !e.ctrl ? 0.5 : e.code === "KeyX" ? -0.5 : 0;
    if (step) {
      this.raise(step);
      return true;
    }
    return false;
  }

  /** What's picked a step higher (or lower): a ramp's two ends, an inclined shape's corners, a vertex, a point. */
  raise(step: number) {
    const sel = this.sel;
    if (!sel) {
      return;
    }
    this.pushUndo();
    const ramp = sel.kind === "shape" ? this.data.shapes[sel.i].ramp : undefined;
    if (sel.kind === "shape" && this.data.shapes[sel.i].kind === "ramp" && ramp) {
      ramp.from += step;
      ramp.to += step;
    } else {
      for (const target of this.targets()) {
        target.h += step;
      }
    }
    this.changed();
    this.host.showProps();
  }

  /** What's picked, gone: a shape, a point, or vertices (out of every outline; one left with fewer than three, gone too). */
  remove() {
    const sel = this.sel;
    if (!sel) {
      return;
    }
    this.pushUndo();
    if (sel.kind === "shape") {
      this.data.shapes.splice(sel.i, 1);
    } else if (sel.kind === "point") {
      this.data.points.splice(sel.i, 1);
    } else {
      const gone = new Set(sel.kind === "verts" ? sel.list : [sel.i]);
      for (const s of this.data.shapes) {
        s.ring = s.ring.filter((i) => !gone.has(i));
        if (s.holes) {
          s.holes = s.holes.map((hole) => hole.filter((i) => !gone.has(i))).filter((hole) => hole.length >= 3);
          if (s.holes.length === 0) {
            s.holes = undefined;
          }
        }
      }
      this.data.shapes = this.data.shapes.filter((s) => s.ring.length >= 3);
    }
    prune(this);
    this.changed();
    this.host.showProps();
  }

  /** What the selection's heights are: the things Z/X and the panel change. */
  targets(): { h: number }[] {
    const sel = this.sel;
    if (!sel) {
      return [];
    }
    const data = this.data;
    if (sel.kind === "verts") {
      return sel.list.map((i) => data.verts[i]);
    }
    if (sel.kind === "shape") {
      const s = data.shapes[sel.i];
      return s.kind === "slope" ? vertsOf(s).map((i) => data.verts[i]) : [s];
    }
    return [sel.kind === "point" ? data.points[sel.i] : data.verts[sel.i]];
  }

  // ---------- Transforms ----------

  /** The vertices a transform moves: the picked shape's, or the picked vertices. */
  selectedVerts(): number[] {
    const sel = this.sel;
    if (sel?.kind === "shape") {
      return [...new Set(vertsOf(this.data.shapes[sel.i]))];
    }
    return sel?.kind === "verts" ? sel.list : [];
  }

  /** The picked thing's box and handles, on screen: eight to size it, one above to turn it. */
  handles(): Handles | null {
    const idx = this.selectedVerts();
    if (idx.length < 2) {
      return null;
    }
    const box = bbox(idx.map((i): Pt => [this.data.verts[i].x, this.data.verts[i].y]));
    const [x0, y0] = this.host.toScreen(box.x0, box.y0);
    const [x1, y1] = this.host.toScreen(box.x1, box.y1);
    const [mx, my] = [(x0 + x1) / 2, (y0 + y1) / 2];
    const list: Handle[] = [
      { id: "nw", sx: x0, sy: y0, ax: box.x1, ay: box.y1, cursor: "nwse-resize" },
      { id: "n", sx: mx, sy: y0, ay: box.y1, cursor: "ns-resize" },
      { id: "ne", sx: x1, sy: y0, ax: box.x0, ay: box.y1, cursor: "nesw-resize" },
      { id: "e", sx: x1, sy: my, ax: box.x0, cursor: "ew-resize" },
      { id: "se", sx: x1, sy: y1, ax: box.x0, ay: box.y0, cursor: "nwse-resize" },
      { id: "s", sx: mx, sy: y1, ay: box.y0, cursor: "ns-resize" },
      { id: "sw", sx: x0, sy: y1, ax: box.x1, ay: box.y0, cursor: "nesw-resize" },
      { id: "w", sx: x0, sy: my, ax: box.x1, cursor: "ew-resize" },
    ];
    return { box, list, rot: { sx: mx, sy: y0 - 26 }, rect: [x0, y0, x1, y1] };
  }

  /** What's under the pointer of the picked thing: a handle, its turning handle, or its inside. */
  grabAt(p: { x: number; y: number }): Grab | null {
    const h = this.handles();
    if (!h) {
      return null;
    }
    const [sx, sy] = this.host.toScreen(p.x, p.y);
    if (Math.hypot(sx - h.rot.sx, sy - h.rot.sy) < 9) {
      return { kind: "rotate", h };
    }
    const handle = h.list.find((q) => Math.abs(sx - q.sx) < 7 && Math.abs(sy - q.sy) < 7);
    if (handle) {
      return { kind: "scale", h, handle };
    }
    const inside = this.sel?.kind === "shape" ? inShape(p.x, p.y, ...this.relief.coordsOf(this.data.shapes[this.sel.i])) : inBox(h.box, p.x, p.y);
    return inside ? { kind: "move", h } : null;
  }

  cursorFor(p: { x: number; y: number }): string {
    const grab = this.grabAt(p);
    if (grab?.kind === "rotate") {
      return "grab";
    }
    if (grab?.kind === "scale") {
      return grab.handle!.cursor;
    }
    if (this.tool === "edit") {
      const reach = this.host.snapReach();
      const used = new Set(this.data.shapes.flatMap(vertsOf));
      if (this.data.verts.some((v, i) => used.has(i) && Math.hypot(v.x - p.x, v.y - p.y) < reach)) {
        return "pointer";
      }
    }
    if (grab?.kind === "move") {
      return "move";
    }
    return this.tool === "edit" ? (this.hover >= 0 ? "pointer" : "default") : "crosshair";
  }

  /** A drag on the picked thing's handles or inside it: a transform begun (false: none here). */
  startTransform(p: { x: number; y: number }): boolean {
    const grab = this.grabAt(p);
    if (!grab) {
      return false;
    }
    // Editing: a vertex under the pointer is picked rather than the whole moved.
    if (grab.kind === "move" && this.tool === "edit") {
      const reach = this.host.snapReach();
      if (this.selectedVerts().some((i) => Math.hypot(this.data.verts[i].x - p.x, this.data.verts[i].y - p.y) < reach)) {
        return false;
      }
    }
    this.pushUndo();
    const idx = this.selectedVerts();
    const s = this.sel?.kind === "shape" ? this.data.shapes[this.sel.i] : null;
    this.xf = {
      ...grab,
      from: p,
      start: idx.map((i): Pt => [this.data.verts[i].x, this.data.verts[i].y]),
      idx,
      ramps: s?.ramp ? [{ s, a: [...s.ramp.a] as Pt, b: [...s.ramp.b] as Pt }] : [],
      center: [(grab.h.box.x0 + grab.h.box.x1) / 2, (grab.h.box.y0 + grab.h.box.y1) / 2],
      // A shape's painted relief goes with it.
      detail: s?.detail ? { s, m: s.detail.m } : undefined,
    };
    return true;
  }

  /** The drag in hand applied to the picked vertices (and a ramp's arrow, and a painted relief), from where they started. */
  transform(p: { x: number; y: number }, mods: Mods = {}) {
    const xf = this.xf!;
    let f: (x: number, y: number) => Pt;
    if (xf.kind === "move") {
      const [dx, dy] = [p.x - xf.from.x, p.y - xf.from.y];
      f = (x, y) => [x + dx, y + dy];
    } else if (xf.kind === "rotate") {
      const [cx, cy] = xf.center;
      let angle = Math.atan2(p.y - cy, p.x - cx) - Math.atan2(xf.from.y - cy, xf.from.x - cx);
      // Shift: in steps of 15 degrees.
      if (mods.shift) {
        angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
      }
      const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
      f = (x, y) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos];
    } else {
      const { h } = xf;
      const handle = xf.handle!;
      const ax = handle.ax ?? h.box.x0;
      const ay = handle.ay ?? h.box.y0;
      const ox = handle.ax === undefined ? null : handle.ax === h.box.x1 ? h.box.x0 : h.box.x1;
      const oy = handle.ay === undefined ? null : handle.ay === h.box.y1 ? h.box.y0 : h.box.y1;
      let sx = ox === null ? 1 : (p.x - ax) / (ox - ax || 1);
      let sy = oy === null ? 1 : (p.y - ay) / (oy - ay || 1);
      // Shift: the same both ways (its proportions kept).
      if (mods.shift && ox !== null && oy !== null) {
        sx = sy = Math.max(Math.abs(sx), Math.abs(sy)) * Math.sign(sx || 1);
      }
      f = (x, y) => [ax + (x - ax) * sx, ay + (y - ay) * sy];
    }
    xf.idx.forEach((i, k) => {
      [this.data.verts[i].x, this.data.verts[i].y] = f(...xf.start[k]);
    });
    for (const r of xf.ramps) {
      r.s.ramp!.a = f(...r.a);
      r.s.ramp!.b = f(...r.b);
    }
    if (xf.detail?.s.detail) {
      const map = affineFrom(xf.start, xf.idx.map((i): Pt => [this.data.verts[i].x, this.data.verts[i].y]));
      if (map) {
        xf.detail.s.detail.m = compose(map, xf.detail.m);
      }
    }
    this.changed();
  }

  /** The picked vertices (and a picked shape's ramp arrow and painted relief) moved by `f`. */
  moveSelection(f: (x: number, y: number) => Pt) {
    for (const i of this.selectedVerts()) {
      [this.data.verts[i].x, this.data.verts[i].y] = f(this.data.verts[i].x, this.data.verts[i].y);
    }
    const s = this.sel?.kind === "shape" ? this.data.shapes[this.sel.i] : null;
    if (s?.ramp) {
      s.ramp.a = f(...s.ramp.a);
      s.ramp.b = f(...s.ramp.b);
    }
    if (s?.detail) {
      const [o, ex, ey] = [f(0, 0), f(1, 0), f(0, 1)];
      s.detail.m = compose([ex[0] - o[0], ex[1] - o[1], ey[0] - o[0], ey[1] - o[1], o[0], o[1]], s.detail.m);
    }
  }

  // ---------- For the page ----------

  /** The layer (terrain or slab) of a shape, if worked out. */
  layerOf(si: number) {
    return layerOf(this, si);
  }

  /** A shape's middle (of its outline's points). */
  middleOf(s: Shape): Pt {
    return centroid(this.relief.coordsOf(s)[0]);
  }

  /** The terrain layers, top first, with what of them shows (for the panel's list). */
  get layers(): Layer[] {
    return this.relief.layers;
  }

  /** Every outline of a shape, as vertex indices. */
  loopsOf(s: Shape) {
    return loopsOf(s);
  }

  /** `f` without losing the shape picked. */
  keepPick(f: () => void) {
    keepPick(this, f);
  }
}

/** The affine map taking points `from` to `to` (worked out from the three farthest apart), or null. */
export function affineFrom(from: Pt[], to: Pt[]): Affine | null {
  if (from.length < 3) {
    return null;
  }
  const far = (list: number[], of: (k: number) => number) => list.reduce((best, k) => (of(k) > of(best) ? k : best), list[0]);
  const all = from.map((_, k) => k);
  const p = 0;
  const q = far(all, (k) => Math.hypot(from[k][0] - from[p][0], from[k][1] - from[p][1]));
  const cross = (k: number) => Math.abs((from[q][0] - from[p][0]) * (from[k][1] - from[p][1]) - (from[q][1] - from[p][1]) * (from[k][0] - from[p][0]));
  const r = far(all, cross);
  if (cross(r) < 1e-9) {
    return null;
  }
  // The map's columns: what (1, 0) and (0, 1) of the triangle p, q, r's own frame become.
  const S: Affine = [from[q][0] - from[p][0], from[q][1] - from[p][1], from[r][0] - from[p][0], from[r][1] - from[p][1], from[p][0], from[p][1]];
  const D: Affine = [to[q][0] - to[p][0], to[q][1] - to[p][1], to[r][0] - to[p][0], to[r][1] - to[p][1], to[p][0], to[p][1]];
  return compose(D, inverse(S));
}
