import { area, centroid } from "../geom";
import { G, apply, cellOf } from "../relief";
import { standSide } from "../stand";
import type { Pt } from "../types";
import type { Mods, ReliefEditor } from "./editor";
import { vertsOf } from "./shapes";

// The editor's map view: the map image (its own grid over it), and over it
// the relief as the editor has it — heights tinted, the shapes' outlines
// (holes, soft edges, slabs, standing edges), what's picked with its handles,
// vertices and height points, water, wall pictures, and what's being drawn.
// Wheel: zoom on the pointer; right or middle button: move the map.

/** A height's tint: blue low, through green, to red high. */
export const tint = (h: number, alpha: number) => `hsla(${200 - h * 34}, 75%, 50%, ${alpha})`;

const fmt = (h: number) => (Math.round(h * 100) / 100).toString();

/** The view's texts, in the page's language. */
export type ViewTexts = { rampNoArrow: string; inclined: string; relative: string };

/** How long two clicks can be apart to be a double click (ms), and how far (px). */
const DOUBLE_CLICK = { ms: 400, px: 6 };

export class MapView {
  canvas: HTMLCanvasElement;
  editor: ReliefEditor;
  picture: CanvasImageSource | null = null;
  /** Each height's tint over the map. */
  showHeights = true;
  /** The water's cells (x, y pairs, `waterStep` across), from the last mesh. */
  waterCells: number[] = [];
  waterStep = 0.25;
  texts: ViewTexts;
  scale = 10;
  ox = 0;
  oy = 0;
  /** Told when the pointer's let go on the map (after the editor). */
  onUp: () => void = () => {};
  private ctx: CanvasRenderingContext2D;
  private frame = 0;
  private fitted = false;
  private listening = new AbortController();
  private resize: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, editor: ReliefEditor, texts: ViewTexts) {
    this.canvas = canvas;
    this.editor = editor;
    this.texts = texts;
    this.ctx = canvas.getContext("2d")!;
    this.resize = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * devicePixelRatio);
      canvas.height = Math.round(rect.height * devicePixelRatio);
      if (!this.fitted) {
        this.fit();
      }
      this.redraw();
    });
    this.resize.observe(canvas);
    this.listen();
  }

  /** Its listeners off the canvas (another view may take it). */
  dispose() {
    this.listening.abort();
    this.resize.disconnect();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  toScreen = (x: number, y: number): [number, number] => [this.ox + x * this.scale, this.oy + y * this.scale];
  toWorld = (sx: number, sy: number) => ({ x: (sx - this.ox) / this.scale, y: (sy - this.oy) / this.scale });

  /** The whole map in view. */
  fit() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) {
      return;
    }
    this.fitted = true;
    const { w, h } = this.editor.data;
    this.scale = Math.min(rect.width / w, rect.height / h) * 0.96;
    this.ox = (rect.width - w * this.scale) / 2;
    this.oy = (rect.height - h * this.scale) / 2;
    this.redraw();
  }

  /** Drawn again at the next frame (once, however many times it's asked). */
  redraw() {
    if (this.frame) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private listen() {
    const canvas = this.canvas;
    const signal = this.listening.signal;
    const local = (event: PointerEvent | WheelEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    };
    const mods = (event: PointerEvent, clicks = 1): Mods => ({ shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey || event.metaKey, clicks });
    let pan: { sx: number; sy: number; ox: number; oy: number } | null = null;
    let held = false;
    let last = { at: 0, sx: 0, sy: 0 };
    canvas.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
    canvas.addEventListener("mousedown", (event) => event.button === 1 && event.preventDefault(), { signal });
    canvas.addEventListener("pointerdown", (event) => {
      canvas.setPointerCapture(event.pointerId);
      canvas.focus();
      const [sx, sy] = local(event);
      if (event.button !== 0) {
        pan = { sx, sy, ox: this.ox, oy: this.oy };
        return;
      }
      // A double click: our own count (a pointer event's detail isn't one everywhere).
      const now = performance.now();
      const clicks = now - last.at < DOUBLE_CLICK.ms && Math.hypot(sx - last.sx, sy - last.sy) < DOUBLE_CLICK.px ? 2 : 1;
      last = { at: clicks === 2 ? 0 : now, sx, sy };
      held = true;
      this.editor.down(this.toWorld(sx, sy), mods(event, clicks));
    }, { signal });
    canvas.addEventListener("pointermove", (event) => {
      const [sx, sy] = local(event);
      if (pan) {
        this.ox = pan.ox + sx - pan.sx;
        this.oy = pan.oy + sy - pan.sy;
        this.redraw();
        return;
      }
      this.editor.move(this.toWorld(sx, sy), mods(event), held);
    }, { signal });
    const end = () => {
      pan = null;
      if (held) {
        held = false;
        this.editor.up();
        this.onUp();
      }
    };
    canvas.addEventListener("pointerup", end, { signal });
    canvas.addEventListener("pointercancel", end, { signal });
    canvas.addEventListener("pointerleave", () => {
      if (!held) {
        this.editor.cursor = null;
        this.editor.hover = -1;
        this.redraw();
      }
    }, { signal });
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const [sx, sy] = local(event);
        const before = this.toWorld(sx, sy);
        this.scale = Math.min(200, Math.max(4, this.scale * Math.exp(-event.deltaY * 0.0015)));
        this.ox = sx - before.x * this.scale;
        this.oy = sy - before.y * this.scale;
        this.redraw();
      },
      { passive: false, signal }
    );
  }

  private draw() {
    const ctx = this.ctx;
    const canvas = this.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const ed = this.editor;
    const { w: W, h: H } = ed.data;
    const [x0, y0] = this.toScreen(0, 0);
    if (this.picture) {
      ctx.drawImage(this.picture, x0, y0, W * this.scale, H * this.scale);
    }
    // The map's own grid, faint.
    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= W; i++) {
      const [x] = this.toScreen(i, 0);
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + H * this.scale);
    }
    for (let j = 0; j <= H; j++) {
      const [, y] = this.toScreen(0, j);
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + W * this.scale, y);
    }
    ctx.stroke();
    this.drawRelief();
    this.drawShapes();
    this.drawMarks();
  }

  /** An outline and its holes, as one path (filled even-odd, a hole stays empty). */
  private path(loops: Pt[][]) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (const loop of loops) {
      loop.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(...this.toScreen(x, y)) : ctx.lineTo(...this.toScreen(x, y))));
      ctx.closePath();
    }
  }

  /** The painted ground's heights, soft edges' halos, slabs. */
  private drawRelief() {
    const ctx = this.ctx;
    const r = this.editor.relief;
    if (this.showHeights) {
      const g = r.data.ground;
      for (let j = 0; j < r.gh - 1; j++) {
        for (let i = 0; i < r.gw - 1; i++) {
          const k = j * r.gw + i;
          const h = (g[k] + g[k + 1] + g[k + r.gw] + g[k + r.gw + 1]) / 4;
          if (Math.abs(h) < 0.05) {
            continue;
          }
          ctx.fillStyle = tint(h, 0.35);
          const [x, y] = this.toScreen(i * G, j * G);
          ctx.fillRect(x, y, G * this.scale + 0.5, G * this.scale + 0.5);
        }
      }
    }
    // A soft edge: a halo as wide as it fades.
    ctx.lineJoin = "round";
    for (const layer of r.layers) {
      if (layer.soft > 0) {
        this.path(layer.loops);
        ctx.strokeStyle = "rgba(127,211,255,0.22)";
        ctx.lineWidth = layer.soft * 2 * this.scale;
        ctx.stroke();
      }
    }
    ctx.lineJoin = "miter";
    // A slab: blue, so it reads as something over the terrain.
    for (const layer of r.slabLayers) {
      this.path(layer.loops);
      ctx.fillStyle = "rgba(120,180,255,0.25)";
      ctx.fill("evenodd");
      ctx.strokeStyle = "#8cc8ff";
      ctx.lineWidth = 3;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** The shapes: tinted by height, outlined (dashed if not flat), their arrows and labels; hover and pick; handles; vertices and points. */
  private drawShapes() {
    const ctx = this.ctx;
    const ed = this.editor;
    const r = ed.relief;
    const data = ed.data;
    if (this.showHeights) {
      for (const piece of r.pieces) {
        this.path([piece.ring, ...piece.holes]);
        ctx.fillStyle = piece.h === undefined ? tint(0, 0.12) : tint(piece.h, 0.3);
        ctx.fill("evenodd");
      }
    }
    const picked = ed.sel?.kind === "shape" ? ed.sel.i : -1;
    data.shapes.forEach((s, i) => {
      const [ring, holes] = r.coordsOf(s);
      if (ring.length < 3) {
        return;
      }
      this.path([ring, ...holes]);
      const selected = picked === i;
      ctx.setLineDash(s.kind === "flat" ? [] : [6, 4]);
      ctx.strokeStyle = selected ? "#ffd54a" : "rgba(255,255,255,0.85)";
      ctx.lineWidth = selected ? 3 : 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      if (s.kind === "ramp" && s.ramp) {
        arrow(ctx, this.toScreen(...s.ramp.a), this.toScreen(...s.ramp.b), selected ? "#ffd54a" : "#7fd3ff");
      }
      if (Math.abs(area(ring)) * this.scale * this.scale > 500) {
        const [cx, cy] = this.toScreen(...centroid(ring));
        const text =
          s.kind === "flat"
            ? s.rel
              ? `+${fmt(s.h)}`
              : fmt(s.h)
            : s.kind === "ramp" && !s.ramp
              ? this.texts.rampNoArrow
              : s.kind === "ramp" && s.ramp
                ? `${fmt(s.ramp.from)}→${fmt(s.ramp.to)}${s.ramp.steps >= 2 ? ` ·${s.ramp.steps}` : ""}${s.rel ? ` ${this.texts.relative}` : ""}`
                : this.texts.inclined;
        label(ctx, cx, cy, text, selected);
      }
    });
    // What the pointer is over, and what's picked: filled, with its box and handles.
    if (ed.hover >= 0 && ed.hover !== picked && data.shapes[ed.hover]) {
      const [ring, holes] = r.coordsOf(data.shapes[ed.hover]);
      if (ring.length >= 3) {
        this.path([ring, ...holes]);
        ctx.strokeStyle = "rgba(255,213,74,0.7)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    if (picked >= 0 && data.shapes[picked]) {
      const [ring, holes] = r.coordsOf(data.shapes[picked]);
      this.path([ring, ...holes]);
      ctx.fillStyle = "rgba(255,213,74,0.18)";
      ctx.fill("evenodd");
    }
    const h = ed.tool === "edit" || ed.isShapeTool() ? ed.handles() : null;
    if (h) {
      const [hx0, hy0, hx1, hy1] = h.rect;
      ctx.strokeStyle = "#ffd54a";
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(hx0, hy0, hx1 - hx0, hy1 - hy0);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo((hx0 + hx1) / 2, hy0);
      ctx.lineTo(h.rot.sx, h.rot.sy);
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#222";
      for (const q of h.list) {
        ctx.fillRect(q.sx - 5, q.sy - 5, 10, 10);
        ctx.strokeRect(q.sx - 5, q.sy - 5, 10, 10);
      }
      ctx.beginPath();
      ctx.arc(h.rot.sx, h.rot.sy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // Vertices (with their heights where they count: on inclined shapes, or picked).
    const onSlope = new Set(data.shapes.filter((s) => s.kind === "slope").flatMap(vertsOf));
    const sel = ed.sel;
    const pickedVerts = new Set(sel?.kind === "verts" ? sel.list : sel?.kind === "vertex" ? [sel.i] : []);
    const used = new Set([...data.shapes.flatMap(vertsOf), ...(ed.drawing ?? [])]);
    data.verts.forEach((v, i) => {
      if (!used.has(i)) {
        return;
      }
      const [x, y] = this.toScreen(v.x, v.y);
      ctx.fillStyle = pickedVerts.has(i) ? "#ffd54a" : onSlope.has(i) ? "#7fd3ff" : "#fff";
      ctx.fillRect(x - 3, y - 3, 6, 6);
      if (onSlope.has(i) || (pickedVerts.has(i) && pickedVerts.size === 1)) {
        label(ctx, x + 12, y - 10, fmt(v.h), pickedVerts.has(i));
      }
    });
    data.points.forEach((q, i) => {
      const [x, y] = this.toScreen(q.x, q.y);
      const selected = sel?.kind === "point" && sel.i === i;
      ctx.fillStyle = selected ? "#ffd54a" : "#b388ff";
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 6, y);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 6, y);
      ctx.fill();
      label(ctx, x + 12, y - 10, fmt(q.h), selected);
    });
  }

  /** What's under way and what goes with what's picked: an outline drawn, a box, the others picked, a ramp's ends, water, pictures, standing edges, the brushes. */
  private drawMarks() {
    const ctx = this.ctx;
    const ed = this.editor;
    const r = ed.relief;
    const data = ed.data;
    ctx.strokeStyle = "#ffd54a";
    ctx.lineWidth = 2;
    if (ed.drawing) {
      ctx.beginPath();
      ed.drawing.forEach((i, k) => {
        const [x, y] = this.toScreen(data.verts[i].x, data.verts[i].y);
        if (k === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      if (ed.cursor) {
        const c = ed.cursor.snap ?? ed.cursor;
        ctx.lineTo(...this.toScreen(c.x, c.y));
      }
      ctx.stroke();
    }
    if (ed.shape) {
      const { start: a, end: b, path: points } = ed.shape;
      const [ax, ay] = this.toScreen(a.x, a.y);
      const [bx, by] = this.toScreen(b.x, b.y);
      ctx.beginPath();
      if (ed.tool === "rect") {
        ctx.rect(ax, ay, bx - ax, by - ay);
      } else if (ed.tool === "ellipse") {
        ctx.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2);
      } else {
        points.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(...this.toScreen(x, y)) : ctx.lineTo(...this.toScreen(x, y))));
      }
      ctx.stroke();
    }
    if (ed.box) {
      const [ax, ay] = this.toScreen(ed.box.start.x, ed.box.start.y);
      const [bx, by] = this.toScreen(ed.box.end.x, ed.box.end.y);
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(ax, ay, bx - ax, by - ay);
      ctx.setLineDash([]);
    }
    // A shape's painted relief: its terrain's tint, within its outline.
    if (this.showHeights) {
      for (const layer of r.layers) {
        if (!layer.detail || layer.detail.v.size === 0) {
          continue;
        }
        ctx.save();
        this.path(layer.loops);
        ctx.clip("evenodd");
        const { m } = layer.detail;
        for (const key of layer.detail.v.keys()) {
          const [u, v] = cellOf(key);
          const [x, y] = apply(m, u * G, v * G);
          ctx.fillStyle = tint(r.evaluate(x, y), 0.3);
          ctx.beginPath();
          for (const [du, dv] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
            ctx.lineTo(...this.toScreen(...apply(m, (u + du) * G, (v + dv) * G)));
          }
          ctx.fill();
        }
        ctx.restore();
      }
    }
    // The others picked with the first (to combine).
    for (const si of ed.sel?.kind === "shape" ? (ed.sel.more ?? []) : []) {
      if (!data.shapes[si]) {
        continue;
      }
      const [ring, holes] = r.coordsOf(data.shapes[si]);
      if (ring.length < 3) {
        continue;
      }
      this.path([ring, ...holes]);
      ctx.fillStyle = "rgba(255,213,74,0.1)";
      ctx.fill("evenodd");
      ctx.strokeStyle = "#ffd54a";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const one = ed.sel?.kind === "shape" && !ed.sel.more?.length ? data.shapes[ed.sel.i] : null;
    // A picked ramp's arrow ends (dragged with Elegir): its tail dark, its head yellow.
    if (ed.tool === "edit" && one?.kind === "ramp" && one.ramp) {
      for (const [end, fill] of [["a", "#222"], ["b", "#ffd54a"]] as const) {
        const [x, y] = this.toScreen(...one.ramp[end]);
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = "#ffd54a";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    // Water: its cells, a light blue over the map.
    if (this.waterCells.length > 0) {
      ctx.fillStyle = "rgba(90,170,255,0.35)";
      const size = this.waterStep * this.scale + 0.5;
      for (let k = 0; k < this.waterCells.length; k += 2) {
        const [x, y] = this.toScreen(this.waterCells[k], this.waterCells[k + 1]);
        ctx.fillRect(x, y, size, size);
      }
    }
    // A wall picture's rectangle: the picked shape's, and one being dragged.
    const skin = one?.skin;
    if (skin || ed.skinBox) {
      ctx.strokeStyle = "#ff9f43";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      if (ed.skinBox) {
        const [ax, ay] = this.toScreen(ed.skinBox.start.x, ed.skinBox.start.y);
        const [bx, by] = this.toScreen(ed.skinBox.end.x, ed.skinBox.end.y);
        ctx.strokeRect(ax, ay, bx - ax, by - ay);
      } else if (skin) {
        this.path([[skin.base[0], skin.base[1], skin.top[1], skin.top[0]]]);
        ctx.stroke();
        // Its foot: the wall's ground.
        ctx.setLineDash([]);
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(...this.toScreen(...skin.base[0]));
        ctx.lineTo(...this.toScreen(...skin.base[1]));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    if (ed.knife) {
      ctx.strokeStyle = "#ff6b6b";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(...this.toScreen(...ed.knife.a));
      ctx.lineTo(...this.toScreen(...ed.knife.b));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // A standing shape's edge it stands on.
    for (const layer of r.layers) {
      if (!layer.stand) {
        continue;
      }
      const base = standSide(layer.stand, layer.ring, layer.box, data.w, data.h).base;
      ctx.strokeStyle = "#ff9f43";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(...this.toScreen(...base[0]));
      ctx.lineTo(...this.toScreen(...base[1]));
      ctx.stroke();
    }
    if (ed.stroke) {
      ctx.strokeStyle = ed.stroke.erase ? "rgba(255,107,107,0.45)" : "rgba(255,213,74,0.45)";
      ctx.lineWidth = ed.settings.shapeRadius * 2 * this.scale;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ed.stroke.pts.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(...this.toScreen(x, y)) : ctx.lineTo(...this.toScreen(x, y))));
      if (ed.stroke.pts.length === 1) {
        ctx.lineTo(...this.toScreen(ed.stroke.pts[0][0] + 1e-3, ed.stroke.pts[0][1]));
      }
      ctx.stroke();
      ctx.lineCap = "butt";
      ctx.lineJoin = "miter";
    }
    if (ed.cursor && (ed.tool === "paintShape" || ed.isBrush())) {
      const [x, y] = this.toScreen(ed.cursor.x, ed.cursor.y);
      ctx.strokeStyle = ed.tool === "paintShape" ? "#ffd54a" : ed.brushKind === "lower" ? "#ff9f6b" : "#fff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, (ed.tool === "paintShape" ? ed.settings.shapeRadius : ed.settings.radius) * this.scale, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function arrow(ctx: CanvasRenderingContext2D, [ax, ay]: [number, number], [bx, by]: [number, number], color: string) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  const angle = Math.atan2(by - ay, bx - ax);
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - Math.cos(angle - 0.4) * 12, by - Math.sin(angle - 0.4) * 12);
  ctx.lineTo(bx - Math.cos(angle + 0.4) * 12, by - Math.sin(angle + 0.4) * 12);
  ctx.fill();
}

function label(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, selected: boolean) {
  ctx.font = "bold 12px system-ui";
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = selected ? "#ffd54a" : "rgba(20,20,24,0.8)";
  ctx.fillRect(x - w / 2, y - 9, w, 18);
  ctx.fillStyle = selected ? "#111" : "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}
