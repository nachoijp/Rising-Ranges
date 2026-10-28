import { bbox, centroid, inBox, inShape, type Box } from "../geom";
import { clampHeight, compose, inverse, quarter, Relief, type Layer } from "../relief";
import { fromStored, toStored } from "../codec";
import type { Affine, Pt, ReliefData, Shape } from "../types";
import { BRUSHES, paintBrush, type BrushKind } from "./brush";
import { time } from "../../timing";
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
  unshare,
  vertexAt,
  vertsOf,
  type Snap,
} from "./shapes";
import { placePrefab, type PrefabId } from "./prefabs";
import { groupPicked, tidyGroups, ungroup } from "./groups";

// The relief editor without its page: the tool in hand, what's picked, and
// what the pointer and the keys do to the relief (in cells). The page (see
// page.ts) draws it and holds the panel; it hears of each change through the
// host. Ported from the mockup's editor F (dev-tests/tmp/mockup).

export type ToolId = "rect" | "ellipse" | "lasso" | "paintShape" | "polygon" | "stamp" | "edit" | "cut" | "brush";

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

/**
 * What Elegir picks: whole shapes (moved, sized, turned), or their vertices
 * and height points; "both" as it was before the modes (the tests' own).
 */
export type PickMode = "shapes" | "points" | "both";

/** What the roller does: a new shape each stroke, the picked one grown (where the stroke touches it), or cut. */
export type RollerMode = "new" | "grow" | "cut";

export type Settings = {
  pickMode: PickMode;
  rollerMode: RollerMode;
  /** How smooth a lasso's outline is made: passes of rounding (0: as drawn). */
  lassoSmooth: number;
  radius: number;
  strength: number;
  level: number;
  /** The soft edge new shapes get: the last one set (0: a wall). */
  lastSoft: number;
  groundOnly: boolean;
  shapeRadius: number;
  brushMode: BrushKind;
  /** Points drawn and moved to the half-cell grid (the magnet in the bar). */
  grid: boolean;
  /** The ready-made shape the Formas listas tool puts down. */
  stamp: PrefabId;
};

export const DEFAULT_SETTINGS: Settings = { pickMode: "shapes", rollerMode: "new", lassoSmooth: 0, radius: 1.5, strength: 0.5, level: 1, lastSoft: 0, groundOnly: false, shapeRadius: 1, brushMode: "raise", grid: false, stamp: "column" };

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
  /** Where what's dragged (a vertex, a height point, the first of a group) started, for how far it's gone (see dragMoved). */
  private dragStart: Pt | null = null;
  xf: Transform | null = null;
  /** The drag in hand as a map of the relief's cells (from where it started), while it lasts. */
  xfMap: Affine | null = null;
  knife: { a: Pt; b: Pt; only: number | null } | null = null;
  stroke: { pts: Pt[]; erase: boolean } | null = null;
  /** Taking a wall picture for this shape: the next drag (a rectangle) or click (another shape). */
  skinPick: number | null = null;
  skinBox: { start: { x: number; y: number }; end: { x: number; y: number } } | null = null;
  arrowEnd: { s: Shape; end: "a" | "b" } | null = null;
  brushing = false;
  /** The next click takes the flattening brush's level from the map (the eyedropper; Alt+click too). */
  levelPick = false;
  /** While telling of a change: only heights changed (a brush's dab), not where anything is. */
  heightsOnly = false;
  /** Where the brush's dabs changed the heights since it was last asked (see takeDirty), cells. */
  private dirty: Box | null = null;
  /** Ctrl held while brushing: raise and lower swapped. */
  flip = false;
  cursor: { x: number; y: number; snap?: Snap | null } | null = null;
  /** The shape the pointer's over (-1: none). */
  hover = -1;
  /** Picking vertices, the pointer on a side (not on a vertex nor a point): where a click adds one. */
  ghost: { x: number; y: number } | null = null;
  /** Why the last combining changed nothing. */
  notice: "nothingShared" | "nothingLeft" | null = null;

  private undoStack: string[] = [];
  private redoStack: string[] = [];

  constructor(data: ReliefData, host: EditorHost, settings: Partial<Settings> = {}) {
    unshare(data);
    this.relief = new Relief(data);
    this.host = host;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
  }

  get data(): ReliefData {
    return this.relief.data;
  }

  /** The relief worked out again, and the page told. */
  changed() {
    // Each group's shapes together (a shape made in one, a copy, one gone...).
    tidyGroups(this);
    time("editor.derive", () => this.relief.derive());
    this.host.changed();
  }

  /**
   * Where the heights changed since it was last asked (cells), and none
   * from then: the brush's dabs, and every shape over what's under it whose
   * height is read there (a flat one's at its middle, a ramp's at its
   * arrow's ends: then all of it moves), and so on up. A shape that follows
   * what's under it point by point changes only where that did.
   */
  takeDirty(): Box | null {
    const box = this.dirty;
    this.dirty = null;
    if (!box) {
      return null;
    }
    const data = this.relief.data;
    const samples = this.relief.layers.map((layer) => {
      const s = data.shapes[layer.si];
      if (!s?.rel) {
        return [];
      }
      return s.kind === "flat" ? [centroid(layer.ring)] : s.kind === "ramp" && s.ramp ? [s.ramp.a, s.ramp.b] : [];
    });
    const taken = new Set<number>();
    for (let grew = true; grew; ) {
      grew = false;
      this.relief.layers.forEach((layer, i) => {
        if (taken.has(i) || !samples[i].some(([x, y]) => inBox(box, x, y))) {
          return;
        }
        taken.add(i);
        const o = layer.outer;
        box.x0 = Math.min(box.x0, o.x0);
        box.y0 = Math.min(box.y0, o.y0);
        box.x1 = Math.max(box.x1, o.x1);
        box.y1 = Math.max(box.y1, o.y1);
        grew = true;
      });
    }
    return box;
  }

  heightAt(x: number, y: number): number | undefined {
    return this.relief.heightAt(x, y);
  }

  /**
   * The shapes whose vertices (and height points) are shown and taken: those
   * picked, or whose vertices or height point are; none hidden or locked.
   * Null with none of them picked: any shape's.
   */
  focusShapes(): Set<number> | null {
    const sel = this.sel;
    const data = this.data;
    const focus = new Set<number>();
    if (sel?.kind === "shape") {
      [sel.i, ...(sel.more ?? [])].forEach((si) => focus.add(si));
    } else if (sel?.kind === "verts" || sel?.kind === "vertex") {
      const picked = new Set(sel.kind === "verts" ? sel.list : [sel.i]);
      data.shapes.forEach((s, si) => vertsOf(s).some((v) => picked.has(v)) && focus.add(si));
    } else if (sel?.kind === "point" && data.points[sel.i]) {
      const q = data.points[sel.i];
      data.shapes.forEach((s, si) => s.kind === "slope" && inShape(q.x, q.y, ...this.relief.coordsOf(s)) && focus.add(si));
    }
    for (const si of focus) {
      if (!data.shapes[si] || !free(data.shapes[si])) {
        focus.delete(si);
      }
    }
    return focus.size > 0 ? focus : null;
  }

  /**
   * Picking vertices, a plain click on a side of a shape that can be taken
   * (not on one of its vertices, nor on a height point): the side snapped to.
   */
  private sideAt(p: { x: number; y: number }, mods: Mods): (Snap & { edge: [number, number] }) | null {
    if (this.tool !== "edit" || this.settings.pickMode === "shapes" || this.drawing || mods.alt || mods.shift || mods.ctrl) {
      return null;
    }
    const reach = this.host.snapReach();
    const used = this.takeable();
    if (this.data.verts.some((v, i) => used.has(i) && Math.hypot(v.x - p.x, v.y - p.y) < reach) || this.pointNear(p, reach) >= 0) {
      return null;
    }
    const at = snap(this, p, false, used);
    return at && "edge" in at ? at : null;
  }

  /** The vertices that can be taken: the shapes' in focus (see focusShapes), or every shape's that isn't hidden or locked. */
  private takeable(): Set<number> {
    const focus = this.focusShapes();
    return new Set(this.data.shapes.filter((s, si) => (focus ? focus.has(si) : free(s))).flatMap(vertsOf));
  }

  /** The height point near a point that can be taken (inside an inclined shape in focus, if any is); -1: none. */
  private pointNear(p: { x: number; y: number }, reach: number): number {
    const focus = this.focusShapes();
    const slopes = focus ? [...focus].map((si) => this.data.shapes[si]).filter((s) => s.kind === "slope").map((s) => this.relief.coordsOf(s)) : null;
    return this.data.points.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < reach && (!slopes || slopes.some(([ring, holes]) => inShape(q.x, q.y, ring, holes))));
  }

  /** The topmost shape at a point that can be picked there (not hidden, nor locked, in the editor); -1: none. */
  shapeAt(x: number, y: number): number {
    const pieces = this.relief.pieces;
    for (let i = pieces.length - 1; i >= 0; i--) {
      const piece = pieces[i];
      const s = this.data.shapes[piece.si];
      if (s?.hidden || s?.locked) {
        continue;
      }
      if (inBox(piece.box, x, y) && inShape(x, y, piece.ring, piece.holes)) {
        return piece.si;
      }
    }
    return -1;
  }

  // ---------- Undo ----------

  /** The relief as it is now, a step to undo (and nothing to redo any more: a new change). */
  pushUndo() {
    this.undoStack.push(JSON.stringify(toStored(this.data)));
    if (this.undoStack.length > UNDO_STEPS) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo() {
    this.step(this.undoStack, this.redoStack);
  }

  redo() {
    this.step(this.redoStack, this.undoStack);
  }

  /** Back (or forward again) a step: the one taken from `from`, the relief as it was kept on `to`. */
  private step(from: string[], to: string[]) {
    const last = from.pop();
    const data = last ? fromStored(JSON.parse(last)) : null;
    if (!data) {
      return;
    }
    to.push(JSON.stringify(toStored(this.data)));
    this.relief = new Relief(data);
    this.sel = null;
    this.drawing = null;
    this.changed();
    this.host.showProps();
  }

  /** Another relief in place of this one (imported, or cleared): a step to undo. */
  replace(data: ReliefData) {
    this.pushUndo();
    unshare(data);
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
    this.ghost = null;
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
      if (this.levelPick || (this.brushKind === "flatten" && mods.alt)) {
        this.levelPick = false;
        this.settings.level = quarter(this.heightAt(p.x, p.y) ?? 0);
        this.host.saveSettings();
        this.host.showProps();
        return;
      }
      this.pushUndo();
      this.flip = !!mods.ctrl;
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
    // A ready-made shape put down here, picked, to be changed with Elegir.
    if (this.tool === "stamp") {
      this.pushUndo();
      placePrefab(this, this.settings.stamp, this.gridded(p));
      this.setTool("edit");
      this.changed();
      this.host.showProps();
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
    // Picking shapes, a double click on one: its vertices (as in most drawing programs).
    if (this.tool === "edit" && this.settings.pickMode === "shapes" && mods.clicks === 2 && !mods.ctrl) {
      const si = this.shapeAt(p.x, p.y);
      if (si >= 0) {
        this.xf = null;
        this.xfMap = null;
        this.settings.pickMode = "points";
        this.sel = { kind: "shape", i: si };
        this.host.saveSettings();
        this.host.showProps();
        this.host.redraw();
        return;
      }
    }
    if (this.tool === "edit" && !this.drawing && this.editDown(p, mods)) {
      return;
    }
    // On what's picked: its handles (size, turn), or inside it (move). Not while drawing an outline, nor picking vertices.
    if (!this.drawing && this.tool !== "polygon" && !(this.tool === "edit" && this.settings.pickMode === "points") && this.startTransform(p)) {
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
      this.drawing.push(vertexAt(this, at ? p : this.gridded(p), at, true));
      this.changed();
      return;
    }
    if (this.isShapeTool()) {
      this.pushUndo();
      // Where it started, for Shift (square) and Alt (from the middle); on the grid if it's on (not a lasso: drawn free).
      const q = this.tool === "lasso" ? p : this.gridded(p);
      this.shape = { start: q, end: q, path: [[q.x, q.y]], origin: this.tool === "lasso" ? undefined : { x: q.x, y: q.y } };
      return;
    }
    // Edit: a vertex, a point, the shape under it; or, on nothing, a box to pick vertices with.
    // Picking shapes only: no vertex nor point, and on nothing, nothing picked.
    const shapesOnly = this.settings.pickMode === "shapes";
    const reach = this.host.snapReach();
    const used = this.takeable();
    const vi = shapesOnly ? -1 : this.data.verts.findIndex((v, i) => used.has(i) && Math.hypot(v.x - p.x, v.y - p.y) < reach);
    const pi = shapesOnly ? -1 : this.pointNear(p, reach);
    const sel = this.sel;
    if (vi >= 0 || pi >= 0) {
      this.pushUndo();
      // A vertex in the group picked drags the group.
      if (vi >= 0 && sel?.kind === "verts" && sel.list.includes(vi)) {
        this.drag = { group: sel.list, from: p, start: sel.list.map((i): Pt => [this.data.verts[i].x, this.data.verts[i].y]) };
        this.dragStart = this.drag.start[0];
      } else {
        const picked = vi >= 0 ? ({ kind: "vertex", i: vi } as const) : ({ kind: "point", i: pi } as const);
        this.sel = picked;
        this.drag = picked;
        const at = vi >= 0 ? this.data.verts[vi] : this.data.points[pi];
        this.dragStart = [at.x, at.y];
      }
    } else if (shapesOnly && this.shapeAt(p.x, p.y) < 0) {
      // On nothing: a box to pick the shapes wholly inside it with (Shift: more of them).
      if (!mods.shift) {
        this.sel = null;
      }
      this.box = { start: p, end: p, add: !!mods.shift };
    } else if (!shapesOnly && (mods.alt || mods.shift || this.shapeAt(p.x, p.y) < 0)) {
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
    // Vertices and points: not while picking shapes only.
    if (this.settings.pickMode === "shapes") {
      return false;
    }
    const reach = this.host.snapReach();
    const data = this.data;
    const used = this.takeable();
    const vi = data.verts.findIndex((v, i) => used.has(i) && Math.hypot(v.x - p.x, v.y - p.y) < reach);
    const pi = this.pointNear(p, reach);
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
    // On a side: a vertex there, picked and dragged.
    const side = this.sideAt(p, mods);
    if (side) {
      this.pushUndo();
      this.xf = null;
      const picked = { kind: "vertex", i: vertexAt(this, p, side) } as const;
      this.sel = picked;
      this.drag = picked;
      this.dragStart = [side.x, side.y];
      this.ghost = null;
      this.changed();
      this.host.showProps();
      return true;
    }
    if (mods.clicks === 2 && vi < 0 && pi < 0) {
      // Inside an inclined shape (the one in focus, if any is): a point with its own height, where its surface is now.
      const si = this.shapeAt(p.x, p.y);
      const focus = this.focusShapes();
      if (si >= 0 && data.shapes[si].kind === "slope" && (!focus || focus.has(si))) {
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
      const q = this.gridded(p);
      let [dx, dy] = [q.x - o.x, q.y - o.y];
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
    if (this.tool === "stamp") {
      this.cursor = this.gridded(p);
      this.host.setCursor("crosshair");
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
    const at = this.tool === "polygon" ? snap(this, p, !!mods.shift) : null;
    this.cursor = { ...(this.tool === "polygon" && !at ? this.gridded(p) : p), snap: at };
    if (held && this.xf) {
      this.transform(p, mods);
      return;
    }
    if (!held) {
      this.hover = this.tool === "edit" || this.isShapeTool() ? this.shapeAt(p.x, p.y) : -1;
      const side = this.sideAt(p, mods);
      this.ghost = side ? { x: side.x, y: side.y } : null;
      this.host.setCursor(this.ghost ? "copy" : this.cursorFor(p));
    } else {
      this.ghost = null;
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
        const [dx, dy] = [this.onGrid(p.x - drag.from.x), this.onGrid(p.y - drag.from.y)];
        drag.group.forEach((i, k) => {
          verts[i].x = drag.start[k][0] + dx;
          verts[i].y = drag.start[k][1] + dy;
        });
      } else {
        const target = this.drag.kind === "vertex" ? verts[this.drag.i] : this.data.points[this.drag.i];
        const q = this.gridded(p);
        target.x = q.x;
        target.y = q.y;
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
      // As its mode says (Alt: cut, whatever it is).
      const mode = erase ? "cut" : this.settings.rollerMode;
      paintShape(this, pts, mode === "cut", mode === "new");
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
      this.xfMap = null;
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
        addShape(this, simplify(rounded(path, Math.round(this.settings.lassoSmooth)), 0.15));
      }
      this.changed();
      this.host.showProps();
    }
    if (this.box) {
      const { start: a, end: b, add } = this.box;
      this.box = null;
      const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
      if (this.settings.pickMode === "shapes") {
        // The shapes wholly inside it, the topmost first.
        const inside = this.data.shapes
          .map((s, i) => ({ i, b: bbox(this.relief.coordsOf(s)[0]) }))
          .filter(({ i, b: r }) => free(this.data.shapes[i]) && r.x0 >= x0 && r.x1 <= x1 && r.y0 >= y0 && r.y1 <= y1)
          .map(({ i }) => i)
          .reverse();
        const before = add && this.sel?.kind === "shape" ? [this.sel.i, ...(this.sel.more ?? [])] : [];
        const list = [...new Set([...before, ...inside])];
        this.sel = list.length > 0 ? { kind: "shape", i: list[0], ...(list.length > 1 ? { more: list.slice(1) } : {}) } : null;
        this.host.showProps();
        this.host.redraw();
        this.drag = null;
        return;
      }
      const verts = this.data.verts;
      const used = this.takeable();
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

  /**
   * A shape's soft edge changed while it's being slid: only heights, and only
   * within `reach` (the wider of the edges, before and now) of the shape.
   */
  softened(si: number, reach: number) {
    const s = this.data.shapes[si];
    if (!s) {
      return;
    }
    const box = bbox(this.relief.coordsOf(s)[0]);
    const r = reach + 1;
    const d = this.dirty;
    this.dirty = {
      x0: Math.min(d?.x0 ?? Infinity, box.x0 - r),
      y0: Math.min(d?.y0 ?? Infinity, box.y0 - r),
      x1: Math.max(d?.x1 ?? -Infinity, box.x1 + r),
      y1: Math.max(d?.y1 ?? -Infinity, box.y1 + r),
    };
    this.heightsOnly = true;
    this.changed();
    this.heightsOnly = false;
  }

  /** A dab of the brush at `p` (see brush.ts), as the settings have it. */
  paint(p: { x: number; y: number }) {
    const { radius, strength, level, groundOnly } = this.settings;
    time("editor.brush", () => paintBrush(this.relief, p, { kind: this.brushKind, radius, strength, level, groundOnly }));
    // A flattening brush reaches a cell past its edge (see brush.ts); one more for the surfaces between points.
    const reach = radius + 2;
    const d = this.dirty;
    this.dirty = {
      x0: Math.min(d?.x0 ?? Infinity, p.x - reach),
      y0: Math.min(d?.y0 ?? Infinity, p.y - reach),
      x1: Math.max(d?.x1 ?? -Infinity, p.x + reach),
      y1: Math.max(d?.y1 ?? -Infinity, p.y + reach),
    };
    this.heightsOnly = true;
    this.changed();
    this.heightsOnly = false;
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
    // Nothing picked: not the editor's (the Vistazo's free point, say).
    if (e.key === "Escape" && this.sel) {
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
    // Ctrl+G: the shapes picked made a group; with Shift, the picked one's group undone.
    if (e.ctrl && e.code === "KeyG" && this.sel?.kind === "shape") {
      const group = this.data.shapes[this.sel.i]?.group;
      if (e.shift ? group : groupPicked(this)) {
        if (e.shift && group) {
          ungroup(this, group);
        }
        this.changed();
        this.host.showProps();
      }
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
      ramp.from = clampHeight(ramp.from + step);
      ramp.to = clampHeight(ramp.to + step);
    } else {
      for (const target of this.targets()) {
        target.h = clampHeight(target.h + step);
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
    if (this.tool === "edit" && this.settings.pickMode !== "shapes") {
      const reach = this.host.snapReach();
      const used = this.takeable();
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
    // A locked (or hidden) shape picked from the list: not moved.
    const own = this.sel?.kind === "shape" ? [this.sel.i, ...(this.sel.more ?? [])].map((i) => this.data.shapes[i]) : [];
    if (own.some((s) => s && !free(s))) {
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

  /** A distance (cells) in steps of the grid, when it's on (see Settings.grid). */
  onGrid(d: number): number {
    return this.settings.grid ? Math.round(d * 2) / 2 : d;
  }

  /** A point on the half-cell grid, when it's on. */
  gridded(p: { x: number; y: number }): { x: number; y: number } {
    return this.settings.grid ? { x: this.onGrid(p.x), y: this.onGrid(p.y) } : p;
  }

  /** How far (cells) what's dragged (a vertex, a height point, a group of them) has gone; null: nothing is. */
  dragMoved(): number | null {
    const drag = this.drag;
    if (!drag || !this.dragStart) {
      return null;
    }
    const now = "group" in drag ? this.data.verts[drag.group[0]] : drag.kind === "vertex" ? this.data.verts[drag.i] : this.data.points[drag.i];
    return now ? Math.hypot(now.x - this.dragStart[0], now.y - this.dragStart[1]) : null;
  }

  /** The drag in hand applied to the picked vertices (and a ramp's arrow, and a painted relief), from where they started. */
  transform(p: { x: number; y: number }, mods: Mods = {}) {
    const xf = this.xf!;
    let f: (x: number, y: number) => Pt;
    if (xf.kind === "move") {
      const [dx, dy] = [this.onGrid(p.x - xf.from.x), this.onGrid(p.y - xf.from.y)];
      f = (x, y) => [x + dx, y + dy];
      this.xfMap = [1, 0, 0, 1, dx, dy];
    } else if (xf.kind === "rotate") {
      const [cx, cy] = xf.center;
      let angle = Math.atan2(p.y - cy, p.x - cx) - Math.atan2(xf.from.y - cy, xf.from.x - cx);
      // Shift: in steps of 15 degrees.
      if (mods.shift) {
        angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
      }
      const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
      f = (x, y) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos];
      this.xfMap = [cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos];
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
      this.xfMap = [sx, 0, 0, sy, ax - ax * sx, ay - ay * sy];
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

/** A closed outline rounded `passes` times (Chaikin's: each corner cut at a quarter of its sides). */
function rounded(ring: Pt[], passes: number): Pt[] {
  let out = ring;
  for (let k = 0; k < passes && out.length >= 3; k++) {
    out = out.flatMap((p, i): Pt[] => {
      const q = out[(i + 1) % out.length];
      return [
        [p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25],
        [p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75],
      ];
    });
  }
  return out;
}

/** A shape the editor's map lets be picked and changed (not hidden, nor locked there). */
export const free = (s: Shape) => !s.hidden && !s.locked;

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
