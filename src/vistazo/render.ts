import { inShape, type StandEdge, type Token, type VistazoScene } from "./scene";

// The Vistazo's 3D view, drawn with CSS 3D: each terrain piece is a copy
// of the map clipped to its outline and raised to its height, with walls
// down to whatever is lower beside it. Tokens are drawn on a flat layer
// above (so they never cut into the terrain), each at its 3D point as it
// lands on screen; one the terrain hides from the camera (a ray from it to
// the eye crosses the terrain's surface) is drawn faded.
//
// The terrain is only rebuilt when the map or the terrain changes: a token
// moving rebuilds the tokens alone (see VistazoScene.terrainKey).
//
// Everything is drawn in view units, VIEW_CELL px a cell, whatever the
// scene's dpi: the CSS layers stay a sane size on big maps.

const VIEW_CELL = 50;

export type Options = {
  heightScale: number;
  /** 0..1: how much darker walls facing away from the light get. */
  shade: number;
  /** 0..100: from almost isometric to strong. */
  perspective: number;
  tint: boolean;
  tokens: boolean;
  xray: boolean;
  edges: boolean;
  anchor: "center" | "base";
  /** Faint lines on the walls at every cell of height. */
  levels: boolean;
  /** The grid's cells drawn on the ground and the tops (square grids). */
  grid: boolean;
  /** Lines from the selected token to the others, by Banda. */
  distances: boolean;
};

/** `focus`: the scene point the camera turns around (null: the map's middle), and its height in grid units. */
export type Camera = { tilt: number; yaw: number; zoom: number; panX: number; panY: number; focus: { x: number; y: number; z: number } | null };

/** A line from the origin token to another: its colour and what it says. */
export type DistanceLine = { id: string; color: string; label: string };

export type TokenText = (token: Token) => { title: string; detail: string };

type Wall = { ax: number; ay: number; len: number; ang: number; top: number; bot: number; edge: boolean; mx: number; my: number; nx: number; ny: number; lit: number };

type TokenView = {
  token: Token;
  el: HTMLElement;
  disc: HTMLElement;
  img: HTMLElement;
  stem: HTMLElement | null;
  zTok: number;
  stemTop: number;
  screen: { x: number; y: number };
  hidden: boolean;
};

/** Which way a standing block's front faces. */
const FACING: Record<StandEdge, [number, number]> = { bottom: [0, 1], top: [0, -1], right: [1, 0], left: [-1, 0] };

/** Light from the north-west, for the walls' shading. */
const LIGHT: [number, number] = [-0.6, -0.8];

export const tintOf = (height: number) => `hsl(${200 - height * 34} 75% 50%)`;

export class VistazoView {
  private readonly cam: HTMLElement;
  private readonly terrainLayer: HTMLElement;
  private readonly tokenLayer: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly lines: SVGSVGElement;
  private readonly tokenOverlay: HTMLElement;
  private scene: VistazoScene | null = null;
  private terrainKey = "";
  private selected = new Set<string>();
  private distanceOrigin: string | null = null;
  private distanceLines: DistanceLine[] = [];
  /** View units per scene px. */
  private u = 1;
  private walls: Wall[] = [];
  private tokenViews: TokenView[] = [];
  private colors: ((x: number, y: number) => [number, number, number]) | null = null;
  private colorsFor = "";
  private grid = { x0: 0, y0: 0, step: 1, w: 0, h: 0, cells: new Float32Array(0) };
  private minH = 0;
  private maxH = 0;
  private base = 0;
  private fit = 1;
  private persp = 2200;
  private width = 0;
  private height = 0;
  /** View px per grid unit of height. */
  private k = VIEW_CELL;
  readonly camera: Camera = { tilt: 0, yaw: 0, zoom: 1, panX: 0, panY: 0, focus: null };
  options: Options;
  onCamera: () => void = () => {};

  constructor(
    private readonly stage: HTMLElement,
    private readonly tokenText: TokenText,
    options: Options
  ) {
    this.options = options;
    this.cam = document.createElement("div");
    this.cam.className = "cam";
    this.terrainLayer = document.createElement("div");
    this.terrainLayer.className = "layer3d";
    this.tokenLayer = document.createElement("div");
    this.tokenLayer.className = "layer3d";
    this.cam.append(this.terrainLayer, this.tokenLayer);
    this.overlay = document.createElement("div");
    this.overlay.className = "ov";
    this.lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.lines.classList.add("lines");
    this.tokenOverlay = document.createElement("div");
    this.overlay.append(this.lines, this.tokenOverlay);
    stage.prepend(this.cam, this.overlay);
    new ResizeObserver(() => this.measure()).observe(stage);
  }

  setScene(scene: VistazoScene) {
    this.scene = scene;
    this.u = VIEW_CELL / scene.dpi;
    const heights = scene.pieces.map((piece) => piece.height);
    this.minH = Math.min(0, ...heights);
    this.maxH = Math.max(0, ...heights);
    // The block reaches below the deepest token, so a buried one is inside it.
    const base = Math.min(this.minH, ...scene.tokens.map((t) => t.terrain + t.own - 1));
    if (scene.terrainKey === this.terrainKey && base === this.base) {
      this.buildTokens();
      this.measure();
      return;
    }
    this.terrainKey = scene.terrainKey;
    this.base = base;
    this.computeGrid();
    this.computeWalls();
    this.build();
    this.loadColors();
  }

  /** The tokens selected in Owlbear, ringed here too. */
  setSelected(ids: string[]) {
    this.selected = new Set(ids);
    for (const view of this.tokenViews) {
      view.el.classList.toggle("selected", this.selected.has(view.token.id));
    }
  }

  /** Lines from `origin` to the tokens in `lines` (null: none). */
  setDistances(origin: string | null, lines: DistanceLine[]) {
    this.distanceOrigin = origin;
    this.distanceLines = lines;
    this.apply();
  }

  /** The token an event happened on, if it was one. */
  tokenAt(target: EventTarget | null): string | null {
    const el = target instanceof Element ? target.closest<HTMLElement>(".tok") : null;
    return el?.dataset.id ?? null;
  }

  /** The map's middle, where the camera turns around by default. */
  middle(): { x: number; y: number; z: number } {
    const b = this.scene?.bounds ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: 1.5 / this.options.heightScale };
  }

  /** Where the camera turns around now. */
  focusPoint(): { x: number; y: number; z: number } {
    return this.camera.focus ?? this.middle();
  }

  /** A token's place, for the camera to turn around it. */
  tokenFocus(id: string): Camera["focus"] {
    const token = this.scene?.tokens.find((t) => t.id === id);
    return token ? { x: token.x, y: token.y, z: token.terrain + token.own } : null;
  }

  setOptions(options: Partial<Options>) {
    const rebuild = ["heightScale", "shade", "levels", "grid"].some((key) => key in options && options[key as keyof Options] !== this.options[key as keyof Options]);
    this.options = { ...this.options, ...options };
    this.stage.classList.toggle("tinted", this.options.tint);
    this.stage.classList.toggle("notok", !this.options.tokens);
    this.stage.classList.toggle("xray", this.options.xray);
    this.stage.classList.toggle("noedge", !this.options.edges);
    if (rebuild) {
      this.build();
    } else {
      this.measure();
    }
  }

  // ---------- Geometry ----------

  /** Heights on a grid of a fifth of a cell, for the rays (NaN outside the map). */
  private computeGrid() {
    const scene = this.scene!;
    const step = scene.dpi / 5;
    const { x0, y0, x1, y1 } = scene.bounds;
    const w = Math.ceil((x1 - x0) / step) + 1;
    const h = Math.ceil((y1 - y0) / step) + 1;
    const cells = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        cells[j * w + i] = scene.heightAt(x0 + i * step, y0 + j * step) ?? NaN;
      }
    }
    this.grid = { x0, y0, step, w, h, cells };
  }

  /** Height (grid units) at a scene point, NaN outside the map. */
  private gridHeight(x: number, y: number): number {
    const { x0, y0, step, w, h, cells } = this.grid;
    const i = Math.round((x - x0) / step);
    const j = Math.round((y - y0) / step);
    return i < 0 || j < 0 || i >= w || j >= h ? NaN : cells[j * w + i];
  }

  private computeWalls() {
    const scene = this.scene!;
    const probe = scene.dpi * 0.03;
    this.walls = [];
    for (const piece of scene.pieces) {
      for (const polygon of piece.shape) {
        for (const ring of polygon) {
          for (let i = 0; i < ring.length - 1; i++) {
            const [ax, ay] = ring[i];
            const [bx, by] = ring[i + 1];
            const dx = bx - ax;
            const dy = by - ay;
            const len = Math.hypot(dx, dy);
            if (len < probe) {
              continue;
            }
            let nx = dy / len;
            let ny = -dx / len;
            const mx = (ax + bx) / 2;
            const my = (ay + by) / 2;
            if (inShape(mx + nx * probe, my + ny * probe, piece.shape)) {
              nx = -nx;
              ny = -ny;
            }
            // A standing block's front is the picture itself.
            if (piece.stand && nx * FACING[piece.stand][0] + ny * FACING[piece.stand][1] > 0.5) {
              continue;
            }
            const outside = scene.heightAt(mx + nx * probe, my + ny * probe);
            const below = outside ?? this.base;
            // The higher side draws the wall.
            if (below >= piece.height) {
              continue;
            }
            const l = Math.hypot(...LIGHT);
            this.walls.push({
              ax, ay, len, ang: Math.atan2(dy, dx), top: piece.height, bot: below, edge: outside === undefined,
              mx: mx - nx * probe * 3, my: my - ny * probe * 3, nx, ny,
              lit: Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1]) / l),
            });
          }
        }
      }
    }
  }

  /** The map drawn small on a canvas, to colour each wall like the ground at its top. Off if the images can't be read (CORS). */
  private loadColors() {
    const scene = this.scene!;
    const key = JSON.stringify(scene.maps.map((map) => [map.url, map.transform]));
    if (key === this.colorsFor) {
      return;
    }
    this.colorsFor = key;
    this.colors = null;
    if (scene.maps.length === 0) {
      return;
    }
    const { x0, y0, x1, y1 } = scene.bounds;
    const px = Math.min(1, 1024 / Math.max(x1 - x0, y1 - y0));
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil((x1 - x0) * px);
    canvas.height = Math.ceil((y1 - y0) * px);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return;
    }
    Promise.all(
      scene.maps.map(
        (map) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = map.url;
          })
      )
    )
      .then((images) => {
        if (key !== this.colorsFor) {
          return;
        }
        images.forEach((img, index) => {
          const m = new DOMMatrix(scene.maps[index].transform);
          context.setTransform(new DOMMatrix().scale(px).translate(-x0, -y0).multiply(m));
          context.drawImage(img, 0, 0);
        });
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        this.colors = (x, y) => {
          const i = Math.max(0, Math.min(canvas.width - 1, Math.round((x - x0) * px)));
          const j = Math.max(0, Math.min(canvas.height - 1, Math.round((y - y0) * px)));
          const at = (j * canvas.width + i) * 4;
          return data[at + 3] === 0 ? STONE : [data[at], data[at + 1], data[at + 2]];
        };
        this.build();
      })
      .catch(() => {
        // Images that can't be read keep the plain stone colour.
      });
  }

  // ---------- Building the DOM ----------

  private build() {
    const scene = this.scene;
    if (!scene) {
      return;
    }
    const u = this.u;
    this.k = VIEW_CELL * this.options.heightScale;
    const k = this.k;
    const frag = document.createDocumentFragment();
    // The grid's lines, a cell apart from the scene's origin (square grids only).
    const gridLines = this.options.grid && scene.squareGrid;

    for (const piece of scene.pieces) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const polygon of piece.shape) {
        for (const [x, y] of polygon[0]) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
      const path = piece.shape
        .map((polygon) => polygon.map((ring) => "M" + ring.map(([x, y]) => `${((x - x0) * u).toFixed(1)} ${((y - y0) * u).toFixed(1)}`).join("L") + "Z").join(""))
        .join("");
      const w = (x1 - x0) * u;
      const h = (y1 - y0) * u;
      const z = piece.height * k;
      const make = (className: string, transform: string, fill?: string) => {
        const el = document.createElement("div");
        el.className = className;
        el.style.cssText = `width:${w}px;height:${h}px;clip-path:path(evenodd,'${path}');transform:${transform};--tint:${tintOf(piece.height)}`;
        if (fill) {
          el.style.background = fill;
          frag.appendChild(el);
          return;
        }
        const maps = document.createElement("div");
        maps.className = "maps";
        maps.style.transform = `scale(${u}) translate(${-x0}px,${-y0}px)`;
        for (const map of scene.maps) {
          const img = document.createElement("img");
          img.src = map.url;
          img.alt = "";
          img.draggable = false;
          img.style.cssText = `width:${map.width}px;height:${map.height}px;transform:${map.transform}`;
          maps.appendChild(img);
        }
        el.appendChild(maps);
        if (gridLines) {
          const lines = document.createElement("div");
          lines.className = "gridlines";
          lines.style.backgroundPosition = `${-((x0 * u) % VIEW_CELL)}px ${-((y0 * u) % VIEW_CELL)}px`;
          el.appendChild(lines);
        }
        frag.appendChild(el);
      };
      if (!piece.stand) {
        make("piece", `translate3d(${x0 * u}px,${y0 * u}px,${z}px)`);
        continue;
      }
      // Standing: a block (its top plain stone, its sides walls) with the
      // piece turned up on its edge as its front, its far side going up,
      // stretched with the height scale like the block.
      const rgb = this.colors ? this.colors((x0 + x1) / 2, (y0 + y1) / 2) : STONE;
      make("piece", `translate3d(${x0 * u}px,${y0 * u}px,${z}px)`, `rgb(${rgb.map((v) => Math.round(v * 0.7))})`);
      const hs = this.options.heightScale;
      const zb = (piece.standBase ?? 0) * k;
      const turn: Record<StandEdge, string> = {
        bottom: `translate3d(${x0 * u}px,${y1 * u + 0.5}px,${zb}px) rotateX(-90deg) scale(1,${hs}) translate(0,${-h}px)`,
        top: `translate3d(${x0 * u}px,${y0 * u - 0.5}px,${zb}px) rotateX(90deg) scale(1,${hs})`,
        right: `translate3d(${x1 * u + 0.5}px,${y0 * u}px,${zb}px) rotateY(90deg) scale(${hs},1) translate(${-w}px,0)`,
        left: `translate3d(${x0 * u - 0.5}px,${y0 * u}px,${zb}px) rotateY(-90deg) scale(${hs},1)`,
      };
      make("piece standing", turn[piece.stand]);
    }

    for (const wall of this.walls) {
      const s = 1 - this.options.shade * (1 - (0.45 + 0.55 * wall.lit));
      const rgb = this.colors ? this.colors(wall.mx, wall.my) : STONE;
      const top = rgb.map((v) => Math.round(v * s * 0.92));
      const bottom = top.map((v) => Math.round(v * 0.62));
      const el = document.createElement("div");
      el.className = wall.edge ? "wall edge" : "wall";
      // Level lines at every whole cell of height, counted from the ground.
      const offset = ((((wall.top % 1) + 1) % 1) - 1) * k;
      const levels = this.options.levels
        ? `repeating-linear-gradient(to bottom,transparent 0 ${k - 1.5}px,rgba(0,0,0,.3) ${k - 1.5}px ${k}px) 0 ${offset}px/100% ${k}px,`
        : "";
      el.style.cssText =
        `width:${wall.len * u + 0.8}px;height:${(wall.top - wall.bot) * k}px;background:${levels}linear-gradient(rgb(${top}),rgb(${bottom}));` +
        `transform:translate3d(${wall.ax * u}px,${wall.ay * u}px,${wall.top * k}px) rotateZ(${wall.ang}rad) rotateX(-90deg)`;
      frag.appendChild(el);
    }

    this.terrainLayer.replaceChildren(frag);
    this.buildTokens();
    this.measure();
  }

  private buildTokens() {
    const scene = this.scene;
    if (!scene) {
      return;
    }
    const u = this.u;
    const k = this.k;
    const frag = document.createDocumentFragment();
    const overlay = document.createDocumentFragment();
    this.tokenViews = scene.tokens.map((token) => {
      const zFloor = token.terrain * k;
      const zTok = (token.terrain + token.own) * k;
      const size = token.size * u;
      const base = document.createElement("div");
      base.className = "base";
      base.style.cssText = `width:${size * 0.8}px;height:${size * 0.8}px;transform:translate3d(${token.x * u - size * 0.4}px,${token.y * u - size * 0.4}px,${zFloor + 1}px)`;
      frag.appendChild(base);
      let stem: HTMLElement | null = null;
      if (token.own !== 0) {
        stem = document.createElement("div");
        stem.className = "stem";
        stem.style.height = `${Math.abs(zTok - zFloor)}px`;
        frag.appendChild(stem);
      }
      const el = document.createElement("div");
      el.className = "tok" + (token.own < 0 ? " buried" : "") + (token.hidden ? " gmhidden" : "") + (this.selected.has(token.id) ? " selected" : "");
      el.dataset.id = token.id;
      const disc = document.createElement("div");
      disc.className = "disc";
      const label = document.createElement("div");
      label.className = "lbl";
      const text = this.tokenText(token);
      const title = document.createElement("span");
      title.textContent = text.title;
      const detail = document.createElement("small");
      detail.textContent = text.detail;
      label.append(title, detail);
      const img = document.createElement("img");
      img.src = token.url;
      img.alt = "";
      img.draggable = false;
      disc.append(label, img);
      el.appendChild(disc);
      overlay.appendChild(el);
      return { token, el, disc, img, stem, zTok, stemTop: Math.max(zFloor, zTok), screen: { x: 0, y: 0 }, hidden: false };
    });
    this.tokenLayer.replaceChildren(frag);
    this.tokenOverlay.replaceChildren(overlay);
  }

  // ---------- Camera ----------

  measure() {
    const rect = this.stage.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    const scene = this.scene;
    if (scene) {
      const { x0, y0, x1, y1 } = scene.bounds;
      this.fit = Math.min(rect.width / ((x1 - x0) * this.u), rect.height / ((y1 - y0) * this.u)) * 0.9;
    }
    this.persp = Math.max(rect.width, rect.height) * (4.2 - (this.options.perspective / 100) * 3.4);
    this.stage.style.perspective = `${this.persp}px`;
    this.apply();
  }

  apply() {
    const scene = this.scene;
    const c = this.camera;
    this.stage.classList.toggle("below", c.tilt > 90);
    if (!scene) {
      this.onCamera();
      return;
    }
    const u = this.u;
    const s = this.fit * c.zoom;
    const cx = (c.focus ? c.focus.x : (scene.bounds.x0 + scene.bounds.x1) / 2) * u;
    const cy = (c.focus ? c.focus.y : (scene.bounds.y0 + scene.bounds.y1) / 2) * u;
    const cz = c.focus ? c.focus.z * this.k : 1.5 * VIEW_CELL;
    this.cam.style.transform =
      `translate(${c.panX}px,${c.panY}px) scale3d(${s},${s},${s}) rotateX(${c.tilt}deg) rotateZ(${c.yaw}deg) ` +
      `translate3d(${-cx}px,${-cy}px,${-cz}px)`;

    // The tokens' 3D points on screen: the same transform, then the stage's perspective (eye at z = persp).
    const camM = new DOMMatrix(this.cam.style.transform);
    const eye = camM.inverse().transformPoint(new DOMPoint(0, 0, this.persp));
    for (const view of this.tokenViews) {
      const { token, el, disc, img, stem, zTok, stemTop } = view;
      const p = camM.transformPoint(new DOMPoint(token.x * u, token.y * u, zTok));
      const f = this.persp / Math.max(1, this.persp - p.z);
      const d = Math.max(22, token.size * u * s * f);
      view.screen = { x: this.width / 2 + p.x * f, y: this.height / 2 + p.y * f };
      el.style.transform = `translate(${view.screen.x}px,${view.screen.y}px)`;
      el.style.zIndex = String(10000 + Math.round(p.z));
      disc.style.cssText = `width:${d}px;height:${d}px;left:${-d / 2}px;top:${this.options.anchor === "base" ? -d : -d / 2}px`;
      // Turned as on the map (not with the camera: that reads oddly on a standing token).
      img.style.transform = `rotate(${token.rotation}deg) scale(${token.flipX ? -1 : 1},${token.flipY ? -1 : 1})`;
      const lift = this.options.anchor === "base" ? (token.size * u) / 2 : 0;
      view.hidden = this.blocked(token.x * u, token.y * u, zTok + lift + 4, eye);
      el.classList.toggle("hidden", view.hidden);
      if (stem) {
        stem.style.transform = `translate3d(${token.x * u}px,${token.y * u}px,${stemTop}px) rotateZ(${-c.yaw}deg) rotateX(-90deg) translateX(-1px)`;
      }
    }
    this.drawLines();
    this.onCamera();
  }

  /** The distance lines, from the origin token's point on screen to each other's, with their reading halfway. */
  private drawLines() {
    const svg = this.lines;
    svg.replaceChildren();
    const origin = this.tokenViews.find((view) => view.token.id === this.distanceOrigin);
    if (!origin || !this.options.distances) {
      return;
    }
    const ns = "http://www.w3.org/2000/svg";
    for (const line of this.distanceLines) {
      const target = this.tokenViews.find((view) => view.token.id === line.id);
      if (!target) {
        continue;
      }
      const { x: x1, y: y1 } = origin.screen;
      const { x: x2, y: y2 } = target.screen;
      const group = document.createElementNS(ns, "g");
      group.setAttribute("class", target.hidden ? "dline hidden" : "dline");
      const back = document.createElementNS(ns, "line");
      const front = document.createElementNS(ns, "line");
      for (const el of [back, front]) {
        el.setAttribute("x1", String(x1));
        el.setAttribute("y1", String(y1));
        el.setAttribute("x2", String(x2));
        el.setAttribute("y2", String(y2));
      }
      back.setAttribute("class", "casing");
      front.setAttribute("stroke", line.color);
      const text = document.createElementNS(ns, "text");
      text.setAttribute("x", String((x1 + x2) / 2));
      text.setAttribute("y", String((y1 + y2) / 2));
      text.textContent = line.label;
      group.append(back, front, text);
      svg.appendChild(group);
    }
  }

  /**
   * Whether the terrain hides a point (view units) from the eye: the ray
   * from it crosses the terrain's surface (down or up), or leaves through a
   * wall at the map's edge. So a buried token shows from below, faded from above.
   */
  private blocked(x: number, y: number, z: number, eye: DOMPoint): boolean {
    const u = this.u;
    const k = this.k;
    const height = (vx: number, vy: number) => this.gridHeight(vx / u, vy / u) * k;
    const dx = eye.x - x;
    const dy = eye.y - y;
    const dz = eye.z - z;
    const length = Math.hypot(dx, dy, dz);
    const start = height(x, y);
    if (Number.isNaN(start)) {
      return false;
    }
    const above = z >= start;
    let last = start;
    for (let d = 12; d < length; d += 6) {
      const t = d / length;
      const px = x + dx * t;
      const py = y + dy * t;
      const pz = z + dz * t;
      const h = height(px, py);
      if (Number.isNaN(h)) {
        return this.options.edges && pz > this.base * k && pz < last;
      }
      last = h;
      if (pz >= h !== above) {
        return true;
      }
      if (above && dz > 0 && pz > this.maxH * k) {
        return false;
      }
      if (dz < 0 && (pz < this.base * k || (!this.options.edges && pz < this.minH * k))) {
        return false;
      }
    }
    return false;
  }
}

/** A neutral stone, for walls when the map can't be read. */
const STONE: [number, number, number] = [138, 128, 112];
