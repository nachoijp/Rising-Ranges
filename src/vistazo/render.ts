import * as THREE from "three";
import type { MultiPolygon } from "polygon-clipping";
import { inShape, type Piece, type StandEdge, type Token, type VistazoScene } from "./scene";

// The Vistazo's 3D view. The terrain is drawn with WebGL (three.js): each
// piece lies at its height with the map as its texture, walls go down to
// whatever is lower beside it, and the GPU's depth buffer sorts it all out.
// (It was CSS 3D first: at grazing angles the browser had hundreds of
// near edge-on layers to raster and sort, and dropped some at random.)
//
// Tokens are drawn on a flat HTML layer above (so they never cut into the
// terrain and keep their labels), each at its 3D point as it lands on
// screen; one the terrain hides from the camera (a ray from it to the eye
// crosses the terrain's surface) is drawn faded.
//
// The camera is worked out as a CSS transform would be (camMatrix): the
// tokens are placed with it, and the WebGL camera is built from the same
// matrix, so both always agree.
//
// The terrain is only rebuilt when the map or the terrain changes: a token
// moving rebuilds the tokens alone (see VistazoScene.terrainKey).
//
// Everything is drawn in view units, VIEW_CELL px a cell, whatever the
// scene's dpi; x right, y down (as on the map), z up.

const VIEW_CELL = 50;

// Colours pass through as they are, as they did in CSS: the map's pixels,
// the walls' shades and the tints, without linear/sRGB conversions.
THREE.ColorManagement.enabled = false;

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
  /** What a token's label says. */
  tokenLabels: "full" | "height" | "name" | "none";
  /** What a distance line says. */
  distanceLabels: "full" | "distance" | "none";
  /** The labels' size, 1 as designed. */
  labelSize: number;
  /** 0..1: higher ground a little lighter, and a soft shadow at the foot of the walls. */
  relief: number;
  /** The Props layer: lying on the ground as on the map, standing up like the tokens, or left out. */
  props: "flat" | "stand" | "none";
};

/** `focus`: the scene point the camera turns around (null: the map's middle), and its height in grid units. */
export type Camera = { tilt: number; yaw: number; zoom: number; panX: number; panY: number; focus: { x: number; y: number; z: number } | null };

/** A line from the origin token to another: its colour and what it says. */
export type DistanceLine = { id: string; color: string; band: string; distance: string };

/** A token's label parts: its name, its height, and where it is (on the ground, flying…). */
export type TokenText = (token: Token) => { name: string; height: string; detail: string };

type Wall = { ax: number; ay: number; bx: number; by: number; top: number; bot: number; edge: boolean; mx: number; my: number; nx: number; ny: number; lit: number };

type TokenView = {
  token: Token;
  el: HTMLElement;
  disc: HTMLElement;
  img: HTMLElement;
  zTok: number;
  screen: { x: number; y: number };
  hidden: boolean;
  /** A standing prop: always on its base, never selected. */
  prop?: boolean;
};

type Texture = { canvas: HTMLCanvasElement; x0: number; y0: number; w: number; h: number };

/** Which way a standing block's front faces. */
const FACING: Record<StandEdge, [number, number]> = { bottom: [0, 1], top: [0, -1], right: [1, 0], left: [-1, 0] };

/** Light from the north-west, for the walls' shading. */
const LIGHT: [number, number] = [-0.6, -0.8];

/** A neutral stone, for walls (and pieces) when the map can't be read. */
const STONE: [number, number, number] = [138, 128, 112];

/** The texture's longest side at most, in px. */
const TEXTURE_MAX = 4096;

export const tintOf = (height: number) => `hsl(${200 - height * 34} 75% 50%)`;

export class VistazoView {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer | null;
  private readonly world = new THREE.Scene();
  private readonly terrainGroup = new THREE.Group();
  private readonly edgeGroup = new THREE.Group();
  private readonly tokenGroup = new THREE.Group();
  private readonly glCamera = new THREE.Camera();
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
  /** The map drawn once on a canvas (see loadColors); null until it's ready, or if the images can't be read. */
  private texture: Texture | null = null;
  private mapTexture: THREE.Texture | null = null;
  /** The materials of the pieces, to dim or see through without rebuilding. */
  private pieceMaterials: THREE.MeshBasicMaterial[] = [];
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
    this.canvas = document.createElement("canvas");
    this.canvas.className = "gl";
    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    } catch (error) {
      console.error("Rising Ranges: Vistazo couldn't start WebGL", error);
    }
    this.renderer = renderer;
    this.glCamera.matrixAutoUpdate = false;
    this.world.add(this.terrainGroup, this.edgeGroup, this.tokenGroup);
    this.overlay = document.createElement("div");
    this.overlay.className = "ov";
    this.lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.lines.classList.add("lines");
    this.tokenOverlay = document.createElement("div");
    this.overlay.append(this.lines, this.tokenOverlay);
    stage.prepend(this.canvas, this.overlay);
    new ResizeObserver(() => this.measure()).observe(stage);
  }

  /** Whether WebGL could start (without it there's nothing to draw the terrain with). */
  get ready(): boolean {
    return this.renderer !== null;
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
    const changed = (keys: (keyof Options)[]) => keys.some((key) => key in options && options[key] !== this.options[key]);
    const rebuild = changed(["heightScale", "shade", "levels", "relief", "tint"]);
    const regrid = changed(["grid"]);
    const relabel = changed(["tokenLabels", "props"]);
    this.options = { ...this.options, ...options };
    this.stage.style.setProperty("--label-scale", String(this.options.labelSize));
    this.stage.classList.toggle("notok", !this.options.tokens);
    this.stage.classList.toggle("xray", this.options.xray);
    if (regrid && this.texture) {
      this.useTexture();
    }
    if (rebuild) {
      this.build();
    } else {
      if (relabel) {
        this.buildTokens();
      }
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
    const l = Math.hypot(...LIGHT);
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
            this.walls.push({
              ax, ay, bx, by, top: piece.height, bot: below, edge: outside === undefined,
              mx: mx - nx * probe * 3, my: my - ny * probe * 3, nx, ny,
              lit: Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1]) / l),
            });
          }
        }
      }
    }
  }

  /**
   * The map drawn once on a canvas: small, to colour each wall like the
   * ground at its top, and up to TEXTURE_MAX px across as the texture every
   * piece shows. Off if the images can't be read (CORS): then the pieces
   * and walls are a plain stone.
   */
  private loadColors() {
    const scene = this.scene!;
    const key = JSON.stringify([scene.maps.map((map) => [map.url, map.transform]), scene.bounds]);
    if (key === this.colorsFor) {
      return;
    }
    this.colorsFor = key;
    this.colors = null;
    this.texture = null;
    this.mapTexture?.dispose();
    this.mapTexture = null;
    if (scene.maps.length === 0) {
      return;
    }
    const { x0, y0, x1, y1 } = scene.bounds;
    const w = x1 - x0;
    const h = y1 - y0;
    const draw = (images: HTMLImageElement[], px: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(w * px));
      canvas.height = Math.max(1, Math.ceil(h * px));
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.imageSmoothingQuality = "high";
      images.forEach((img, index) => {
        const map = scene.maps[index];
        context.setTransform(new DOMMatrix().scale(px).translate(-x0, -y0).multiply(new DOMMatrix(map.transform)));
        // At the size the item says (the file may be another size).
        context.drawImage(img, 0, 0, map.width, map.height);
      });
      return { canvas, context };
    };
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
        const small = draw(images, Math.min(1, 1024 / Math.max(w, h)));
        const data = small.context.getImageData(0, 0, small.canvas.width, small.canvas.height).data;
        const sw = small.canvas.width;
        const sh = small.canvas.height;
        this.colors = (x, y) => {
          const i = Math.max(0, Math.min(sw - 1, Math.round(((x - x0) / w) * sw)));
          const j = Math.max(0, Math.min(sh - 1, Math.round(((y - y0) / h) * sh)));
          const at = (j * sw + i) * 4;
          return data[at + 3] === 0 ? STONE : [data[at], data[at + 1], data[at + 2]];
        };
        const most = Math.min(TEXTURE_MAX, this.renderer?.capabilities.maxTextureSize ?? TEXTURE_MAX);
        const big = draw(images, Math.min(1, most / Math.max(w, h)));
        this.texture = { canvas: big.canvas, x0, y0, w, h };
        this.useTexture();
        this.build();
      })
      .catch((error) => {
        console.error("Rising Ranges: Vistazo couldn't read the map images, drawing plain terrain", error);
      });
  }

  /** The map texture, with the grid's cells drawn on it when they're asked for. */
  private useTexture() {
    const texture = this.texture;
    const scene = this.scene;
    if (!texture || !scene) {
      return;
    }
    let source: HTMLCanvasElement = texture.canvas;
    if (this.options.grid && scene.squareGrid) {
      source = document.createElement("canvas");
      source.width = texture.canvas.width;
      source.height = texture.canvas.height;
      const context = source.getContext("2d")!;
      context.drawImage(texture.canvas, 0, 0);
      const px = source.width / texture.w;
      context.strokeStyle = "rgba(0,0,0,0.35)";
      context.lineWidth = Math.max(1, px * scene.dpi * 0.02);
      context.beginPath();
      for (let x = Math.ceil(texture.x0 / scene.dpi) * scene.dpi; x <= texture.x0 + texture.w; x += scene.dpi) {
        context.moveTo((x - texture.x0) * px, 0);
        context.lineTo((x - texture.x0) * px, source.height);
      }
      for (let y = Math.ceil(texture.y0 / scene.dpi) * scene.dpi; y <= texture.y0 + texture.h; y += scene.dpi) {
        context.moveTo(0, (y - texture.y0) * px);
        context.lineTo(source.width, (y - texture.y0) * px);
      }
      context.stroke();
    }
    this.mapTexture?.dispose();
    const map = new THREE.CanvasTexture(source);
    map.anisotropy = this.renderer?.capabilities.getMaxAnisotropy() ?? 1;
    this.mapTexture = map;
    for (const material of this.pieceMaterials) {
      if (material.map) {
        material.map = map;
        material.needsUpdate = true;
      }
    }
    this.render();
  }

  // ---------- Building the 3D scene ----------

  private clear(group: THREE.Group) {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(material) ? material : material ? [material] : []).forEach((m) => {
          // The map texture is shared: only a prop's own is let go.
          const own = (m as THREE.MeshBasicMaterial).map;
          if (own && own !== this.mapTexture) {
            own.dispose();
          }
          m.dispose();
        });
      });
    }
  }

  /** A piece's outline as a flat shape, in view units. */
  private shapeGeometry(shape: MultiPolygon): THREE.ShapeGeometry {
    const u = this.u;
    const shapes = shape.map((polygon) => {
      const outer = new THREE.Shape(polygon[0].map(([x, y]) => new THREE.Vector2(x * u, y * u)));
      outer.holes = polygon.slice(1).map((ring) => new THREE.Path(ring.map(([x, y]) => new THREE.Vector2(x * u, y * u))));
      return outer;
    });
    return new THREE.ShapeGeometry(shapes);
  }

  /** Texture coordinates for view-unit points `xy` (x, y pairs), from where the map texture lies. */
  private uvs(xy: ArrayLike<number>, count: number): Float32Array {
    const uv = new Float32Array(count * 2);
    const t = this.texture;
    const scene = this.scene!;
    const box = t ?? { x0: scene.bounds.x0, y0: scene.bounds.y0, w: scene.bounds.x1 - scene.bounds.x0 || 1, h: scene.bounds.y1 - scene.bounds.y0 || 1 };
    for (let i = 0; i < count; i++) {
      uv[i * 2] = (xy[i * 3] / this.u - box.x0) / box.w;
      uv[i * 2 + 1] = 1 - (xy[i * 3 + 1] / this.u - box.y0) / box.h;
    }
    return uv;
  }

  private pieceMaterial(height: number, textured: boolean, fill?: [number, number, number]): THREE.MeshBasicMaterial {
    const span = this.maxH - this.minH || 1;
    // Higher ground a little lighter: up to ±25% from the lowest to the highest.
    const lit = 1 + this.options.relief * 0.5 * ((height - this.minH) / span - 0.5);
    const color = new THREE.Color(...(fill ?? (textured && this.mapTexture ? [255, 255, 255] : STONE)).map((v) => v / 255) as [number, number, number]);
    if (this.options.tint) {
      color.lerp(new THREE.Color(tintOf(height)), 0.5);
    }
    color.multiplyScalar(lit);
    const material = new THREE.MeshBasicMaterial({
      color,
      map: textured ? this.mapTexture : null,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    material.userData.color = color.clone();
    this.pieceMaterials.push(material);
    return material;
  }

  private build() {
    const scene = this.scene;
    if (!scene) {
      return;
    }
    this.clear(this.terrainGroup);
    this.clear(this.edgeGroup);
    this.pieceMaterials = [];
    const u = this.u;
    this.k = VIEW_CELL * this.options.heightScale;
    const k = this.k;

    for (const piece of scene.pieces) {
      this.buildPiece(piece);
    }

    // The walls: two meshes (inside and at the map's edge, which can be hidden), coloured top to bottom.
    for (const edge of [false, true]) {
      const walls = this.walls.filter((wall) => wall.edge === edge);
      if (walls.length === 0) {
        continue;
      }
      const positions = new Float32Array(walls.length * 18);
      const colors = new Float32Array(walls.length * 18);
      const levels: number[] = [];
      walls.forEach((wall, i) => {
        const s = 1 - this.options.shade * (1 - (0.45 + 0.55 * wall.lit));
        const rgb = this.colors ? this.colors(wall.mx, wall.my) : STONE;
        const top = rgb.map((v) => (v / 255) * s * 0.92);
        const bottom = top.map((v) => v * 0.62);
        const [ax, ay, bx, by] = [wall.ax * u, wall.ay * u, wall.bx * u, wall.by * u];
        const zt = wall.top * k;
        const zb = wall.bot * k;
        const quad = [ax, ay, zt, bx, by, zt, bx, by, zb, ax, ay, zt, bx, by, zb, ax, ay, zb];
        positions.set(quad, i * 18);
        const shades = [top, top, bottom, top, bottom, bottom];
        shades.forEach((c, j) => colors.set(c, i * 18 + j * 3));
        // Level lines at every whole cell of height, counted from the ground.
        if (this.options.levels) {
          for (let n = Math.ceil(wall.bot + 1e-6); n < wall.top - 1e-6; n++) {
            levels.push(ax, ay, n * k, bx, by, n * k);
          }
        }
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const group = edge ? this.edgeGroup : this.terrainGroup;
      const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
      material.userData.color = new THREE.Color(1, 1, 1);
      this.pieceMaterials.push(material);
      group.add(new THREE.Mesh(geometry, material));
      if (levels.length > 0) {
        const lines = new THREE.BufferGeometry();
        lines.setAttribute("position", new THREE.BufferAttribute(new Float32Array(levels), 3));
        group.add(new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 })));
      }
    }

    // A soft shadow on the ground at the foot of each wall, fading out from it.
    if (this.options.relief > 0) {
      const inside = this.walls.filter((wall) => !wall.edge);
      const positions = new Float32Array(inside.length * 18);
      const colors = new Float32Array(inside.length * 24);
      const reach = VIEW_CELL * 0.45;
      const dark = 0.45 * this.options.relief;
      inside.forEach((wall, i) => {
        const [ax, ay, bx, by] = [wall.ax * u, wall.ay * u, wall.bx * u, wall.by * u];
        const [cx, cy, dx, dy] = [ax + wall.nx * reach, ay + wall.ny * reach, bx + wall.nx * reach, by + wall.ny * reach];
        const z = wall.bot * k + 0.4;
        positions.set([ax, ay, z, bx, by, z, dx, dy, z, ax, ay, z, dx, dy, z, cx, cy, z], i * 18);
        const alphas = [dark, dark, 0, dark, 0, 0];
        alphas.forEach((a, j) => colors.set([0, 0, 0, a], i * 24 + j * 4));
      });
      if (inside.length > 0) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
        const shadows = new THREE.Mesh(
          geometry,
          new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide })
        );
        shadows.renderOrder = 1;
        this.terrainGroup.add(shadows);
      }
    }

    this.buildTokens();
    this.measure();
  }

  private buildPiece(piece: Piece) {
    const u = this.u;
    const k = this.k;
    const z = piece.height * k;
    const geometry = this.shapeGeometry(piece.shape);
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    if (!piece.stand) {
      geometry.setAttribute("uv", new THREE.BufferAttribute(this.uvs(position.array, position.count), 2));
      const mesh = new THREE.Mesh(geometry, this.pieceMaterial(piece.height, true));
      mesh.position.z = z;
      this.terrainGroup.add(mesh);
      return;
    }
    // Standing: a block (its top plain stone, its sides walls) with the
    // piece turned up on its edge as its front, its far side going up,
    // stretched with the height scale like the block.
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
    const rgb = this.colors ? this.colors((x0 + x1) / 2, (y0 + y1) / 2) : STONE;
    const top = new THREE.Mesh(geometry, this.pieceMaterial(piece.height, false, rgb.map((v) => v * 0.7) as [number, number, number]));
    top.position.z = z;
    this.terrainGroup.add(top);

    const card = geometry.clone();
    const flat = (card.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    card.setAttribute("uv", new THREE.BufferAttribute(this.uvs(flat, flat.length / 3), 2));
    const hs = this.options.heightScale;
    const zb = (piece.standBase ?? 0) * k;
    const [X0, Y0, X1, Y1] = [x0 * u, y0 * u, x1 * u, y1 * u];
    for (let i = 0; i < flat.length; i += 3) {
      const X = flat[i];
      const Y = flat[i + 1];
      const turned: Record<StandEdge, [number, number, number]> = {
        bottom: [X, Y1 + 0.5, zb + (Y1 - Y) * hs],
        top: [X, Y0 - 0.5, zb + (Y - Y0) * hs],
        right: [X1 + 0.5, Y, zb + (X1 - X) * hs],
        left: [X0 - 0.5, Y, zb + (X - X0) * hs],
      };
      flat.set(turned[piece.stand], i);
    }
    card.getAttribute("position").needsUpdate = true;
    this.terrainGroup.add(new THREE.Mesh(card, this.pieceMaterial(piece.height, true)));
  }

  private buildTokens() {
    const scene = this.scene;
    if (!scene) {
      return;
    }
    this.clear(this.tokenGroup);
    const u = this.u;
    const k = this.k;
    const overlay = document.createDocumentFragment();
    // Props first, so a token is drawn over a prop where they meet.
    const propViews: TokenView[] = [];
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    for (const prop of scene.props) {
      if (this.options.props === "flat") {
        // Its picture lying on the ground, where the map has it.
        const m = new DOMMatrix(prop.transform);
        const corner = (x: number, y: number) => {
          const p = m.transformPoint(new DOMPoint(x, y));
          return [p.x * u, p.y * u, prop.terrain * k + 0.6];
        };
        const [a, b, c, d] = [corner(0, 0), corner(prop.width, 0), corner(prop.width, prop.height), corner(0, prop.height)];
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([...a, ...b, ...c, ...a, ...c, ...d]), 3));
        geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]), 2));
        const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 });
        loader.load(prop.url, (texture) => {
          material.map = texture;
          material.opacity = 1;
          material.needsUpdate = true;
          this.render();
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = 2;
        this.tokenGroup.add(mesh);
      } else if (this.options.props === "stand") {
        const el = document.createElement("div");
        el.className = "tok prop";
        const disc = document.createElement("div");
        disc.className = "disc";
        const img = document.createElement("img");
        img.src = prop.url;
        img.alt = "";
        img.draggable = false;
        disc.append(img);
        el.appendChild(disc);
        overlay.appendChild(el);
        // Drawn like a token standing on its base, without the token's marks.
        const token = { x: prop.x, y: prop.y, size: prop.size, terrain: prop.terrain, own: 0, rotation: prop.rotation, flipX: false, flipY: false } as Token;
        propViews.push({ token, el, disc, img, zTok: prop.terrain * k, screen: { x: 0, y: 0 }, hidden: false, prop: true });
      }
    }

    const ring = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
    const fill = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
    const dashes = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 6, gapSize: 5, transparent: true, opacity: 0.9 });
    this.tokenViews = scene.tokens.map((token) => {
      const zFloor = token.terrain * k;
      const zTok = (token.terrain + token.own) * k;
      const r = token.size * u * 0.4;
      // Its base on the ground under it, and a dashed line up (or down) to it.
      const disc3d = new THREE.Mesh(new THREE.CircleGeometry(r, 32), fill);
      const ring3d = new THREE.Mesh(new THREE.RingGeometry(r - 2, r, 32), ring);
      for (const mesh of [disc3d, ring3d]) {
        mesh.position.set(token.x * u, token.y * u, zFloor + 1);
        mesh.renderOrder = 3;
        this.tokenGroup.add(mesh);
      }
      if (token.own !== 0) {
        const stem = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(token.x * u, token.y * u, zTok), new THREE.Vector3(token.x * u, token.y * u, zFloor)]),
          dashes
        );
        stem.computeLineDistances();
        this.tokenGroup.add(stem);
      }
      const el = document.createElement("div");
      el.className = "tok" + (token.own < 0 ? " buried" : "") + (token.hidden ? " gmhidden" : "") + (this.selected.has(token.id) ? " selected" : "");
      el.dataset.id = token.id;
      const disc = document.createElement("div");
      disc.className = "disc";
      const img = document.createElement("img");
      img.src = token.url;
      img.alt = "";
      img.draggable = false;
      const shown = this.options.tokenLabels;
      if (shown !== "none") {
        const label = document.createElement("div");
        label.className = "lbl";
        const text = this.tokenText(token);
        const title = document.createElement("span");
        title.textContent = shown === "full" ? `${text.name} · ${text.height}` : shown === "height" ? text.height : text.name;
        label.append(title);
        if (shown === "full") {
          const detail = document.createElement("small");
          detail.textContent = text.detail;
          label.append(detail);
        }
        disc.append(label);
      }
      disc.append(img);
      el.appendChild(disc);
      overlay.appendChild(el);
      return { token, el, disc, img, zTok, screen: { x: 0, y: 0 }, hidden: false };
    });
    this.tokenViews = [...propViews, ...this.tokenViews];
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
      this.fit = Math.min(rect.width / ((x1 - x0) * this.u || 1), rect.height / ((y1 - y0) * this.u || 1)) * 0.9;
    }
    this.persp = Math.max(rect.width, rect.height) * (4.2 - (this.options.perspective / 100) * 3.4);
    this.renderer?.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
    this.apply();
  }

  /**
   * The camera as a CSS transform of the scene (view units) to the stage's
   * middle, before the perspective: a scene point p lands on screen at
   * middle + (q.x, q.y)·P/(P − q.z), q = camMatrix·p, P the perspective.
   */
  private camMatrix(): DOMMatrix {
    const scene = this.scene!;
    const c = this.camera;
    const u = this.u;
    const s = this.fit * c.zoom;
    const cx = (c.focus ? c.focus.x : (scene.bounds.x0 + scene.bounds.x1) / 2) * u;
    const cy = (c.focus ? c.focus.y : (scene.bounds.y0 + scene.bounds.y1) / 2) * u;
    const cz = c.focus ? c.focus.z * this.k : 1.5 * VIEW_CELL;
    return new DOMMatrix(
      `translate(${c.panX}px,${c.panY}px) scale3d(${s},${s},${s}) rotateX(${c.tilt}deg) rotateZ(${c.yaw}deg) ` +
        `translate3d(${-cx}px,${-cy}px,${-cz}px)`
    );
  }

  /** The WebGL camera for the same view: camMatrix as its view, and a projection doing the stage's perspective. */
  private setGlCamera(camM: DOMMatrix) {
    const P = this.persp;
    const near = P * 0.02;
    const far = P * 40;
    const a = (far + near) / (far - near);
    const b = (-2 * far * near) / (far - near);
    // clip = (q.x·2P/W, −q.y·2P/H, a·(P − q.z) + b, P − q.z): the eye at z = P, looking down −z; screen y down.
    this.glCamera.projectionMatrix.set(
      (2 * P) / this.width, 0, 0, 0,
      0, (-2 * P) / this.height, 0, 0,
      0, 0, -a, a * P + b,
      0, 0, -1, P
    );
    this.glCamera.projectionMatrixInverse.copy(this.glCamera.projectionMatrix).invert();
    const view = new THREE.Matrix4().fromArray(camM.toFloat64Array());
    this.glCamera.matrix.copy(view).invert();
    this.glCamera.matrixWorld.copy(this.glCamera.matrix);
    this.glCamera.matrixWorldInverse.copy(view);
  }

  private render() {
    if (this.renderer && this.scene && this.width > 0 && this.height > 0) {
      this.renderer.render(this.world, this.glCamera);
    }
  }

  apply() {
    const scene = this.scene;
    const c = this.camera;
    if (!scene || this.width === 0) {
      this.onCamera();
      return;
    }
    const u = this.u;
    const s = this.fit * c.zoom;
    const camM = this.camMatrix();
    this.setGlCamera(camM);

    // Seen from below, the ground is dimmed; see-through terrain fades the pieces and walls.
    const dim = c.tilt > 90 ? 0.55 : 1;
    for (const material of this.pieceMaterials) {
      material.color.copy(material.userData.color as THREE.Color).multiplyScalar(dim);
      material.transparent = this.options.xray;
      material.opacity = this.options.xray ? 0.45 : 1;
      material.depthWrite = !this.options.xray;
    }
    this.edgeGroup.visible = this.options.edges;
    this.tokenGroup.visible = this.options.tokens || this.options.props === "flat";
    for (const child of this.tokenGroup.children) {
      // Flat props stay with the props option; bases and lines go with the tokens.
      child.visible = child.renderOrder === 2 || this.options.tokens;
    }
    this.render();

    // The tokens' 3D points on screen: the same matrix, then the perspective (eye at z = persp).
    const eye = camM.inverse().transformPoint(new DOMPoint(0, 0, this.persp));
    for (const view of this.tokenViews) {
      const { token, el, disc, img, zTok } = view;
      const p = camM.transformPoint(new DOMPoint(token.x * u, token.y * u, zTok));
      const f = this.persp / Math.max(1, this.persp - p.z);
      const d = Math.max(22, token.size * u * s * f);
      view.screen = { x: this.width / 2 + p.x * f, y: this.height / 2 + p.y * f };
      el.style.transform = `translate(${view.screen.x}px,${view.screen.y}px)`;
      el.style.zIndex = String(10000 + Math.round(p.z));
      // Behind the eye: not drawn.
      el.style.visibility = this.persp - p.z > 1 ? "" : "hidden";
      const onBase = view.prop || this.options.anchor === "base";
      disc.style.cssText = `width:${d}px;height:${d}px;left:${-d / 2}px;top:${onBase ? -d : -d / 2}px`;
      // Turned as on the map (not with the camera: that reads oddly on a standing token).
      img.style.transform = `rotate(${token.rotation}deg) scale(${token.flipX ? -1 : 1},${token.flipY ? -1 : 1})`;
      const lift = onBase ? (token.size * u) / 2 : 0;
      view.hidden = this.blocked(token.x * u, token.y * u, zTok + lift + 4, eye);
      el.classList.toggle("hidden", view.hidden);
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
      text.textContent = this.options.distanceLabels === "full" ? `${line.band} · ${line.distance}` : line.distance;
      group.append(back, front);
      if (this.options.distanceLabels !== "none") {
        group.append(text);
      }
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
