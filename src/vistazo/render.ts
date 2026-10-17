import * as THREE from "three";
import type { MultiPolygon } from "polygon-clipping";
import { inShape, pieceHeight, type Piece, type StandEdge, type Token, type VistazoScene } from "./scene";
import { distance3D } from "../engine/distance";
import { cellCorners, groundOffset } from "../engine/hex";
import type { Fog } from "./fog";

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
  /** What the walls' faces show (see buildWalls). */
  wallStyle: WallStyle;
  /** Each Banda's limit around the selected token, drawn on the terrain. */
  rings: boolean;
  /** And the ground in each Banda tinted its colour. */
  ringFill: boolean;
  /** As a player sees it: the fog over the scene, hidden tokens and what the fog covers left out. */
  playerView: boolean;
};

/**
 * The Bandas' rings around a token, as on the map: each Banda's radius plus
 * the Tolerancia (`reach`) and the token's excess bulk, across only, by the
 * metric (hex steps on a hex grid). `z` (its body's middle) isn't used by
 * the rings, which leave height out.
 */
export type Reach = {
  x: number;
  y: number;
  z: number;
  excess: number;
  metric: "spherical" | "cubic" | "cylindrical";
  hex: "hexHorizontal" | "hexVertical" | null;
  bands: { reach: number; color: string }[];
};

/**
 * A wall's face: one colour; the map's pixels at its top edge stretched
 * down; a strip of the map inside the edge folded down (mirrored where the
 * wall is taller); or a pattern drawn here (stone courses, earth strata,
 * planks) tinted with the map's colour at the edge.
 */
export type WallStyle = "flat" | "stretch" | "fold" | "stone" | "earth" | "wood";

/** `focus`: the scene point the camera turns around (null: the map's middle), and its height in grid units. */
export type Camera = { tilt: number; yaw: number; zoom: number; panX: number; panY: number; focus: { x: number; y: number; z: number } | null };

/** A line from the origin token to another: its colour and what it says. */
export type DistanceLine = { id: string; color: string; band: string; distance: string };

/** A token's label parts: its name, its height, and where it is (on the ground, flying…). */
export type TokenText = (token: Token) => { name: string; height: string; detail: string };

type Wall = {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Its top and bottom (grid units) at its two ends, a and b: a ramp's side slants. */
  t0: number;
  t1: number;
  b0: number;
  b1: number;
  edge: boolean;
  mx: number;
  my: number;
  nx: number;
  ny: number;
  lit: number;
  /** The style a zone asks for: the higher side's, or else the lower's (a pit's walls are the ground's). */
  style?: WallStyle;
};

type TokenView = {
  token: Token;
  el: HTMLElement;
  disc: HTMLElement;
  img: HTMLElement;
  zTok: number;
  /** Its marks in 3D (base and line), and its label's lines: moved and rewritten in place (see setScene). */
  marks?: { base: THREE.Mesh[]; stem: THREE.Line | null };
  title?: HTMLElement;
  detail?: HTMLElement;
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
  private readonly ringGroup = new THREE.Group();
  /** The ground tinted by Banda: a copy of each flat piece, its texture the Bandas' colours (see buildReach). */
  private readonly fillGroup = new THREE.Group();
  private reach: Reach | null = null;
  private reachTexture: THREE.DataTexture | null = null;
  private reachFrame = 0;
  private applyFrame = 0;
  private canvasSize = { w: 0, h: 0 };
  /** The props as last drawn (flat ones are meshes: rebuilt when they change). */
  private drawnProps: VistazoScene["props"] | null = null;
  /** The player view's fog: where it is, and its shade over copies of the flat pieces (as the Banda tint). */
  private readonly fogGroup = new THREE.Group();
  private fogTexture: THREE.CanvasTexture | null = null;
  private fogCanvas: HTMLCanvasElement | null = null;
  private fog: Fog | null = null;
  private fogFrame = 0;
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
    this.world.add(this.terrainGroup, this.edgeGroup, this.tokenGroup, this.ringGroup, this.fillGroup, this.fogGroup);
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
      // Only tokens moved (a drag): put them where they are now, without building them again.
      if (!this.moveTokens(scene)) {
        this.buildTokens();
      }
      this.requestApply();
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
    this.requestApply();
  }

  /** The Bandas' reach around the selected token (null: none); worked out once a frame at most (it follows a drag). */
  setReach(reach: Reach | null) {
    this.reach = reach;
    if (!this.reachFrame) {
      this.reachFrame = requestAnimationFrame(() => {
        this.reachFrame = 0;
        this.buildReach();
        this.requestApply();
      });
    }
  }

  /**
   * Each Banda's ring as on the map — across only, its height left out —
   * laid on the terrain like a shadow: its outline (a circle, a square with
   * the cubic metric, a hexagon on a hex grid) walked in short steps, each
   * at the terrain's height there. And, if asked, the ground inside each
   * tinted its colour (a texture over copies of the flat pieces).
   */
  private buildReach() {
    this.clear(this.ringGroup);
    const r = this.reach;
    const scene = this.scene;
    const show = !!r && !!scene && (this.options.rings || this.options.ringFill);
    this.fillGroup.visible = show && this.options.ringFill;
    if (!r || !scene || !show) {
      return;
    }
    const dpi = scene.dpi;
    const u = this.u;
    const k = this.k;
    const bands = r.bands.filter((band) => Number.isFinite(band.reach)).map((band) => ({ ...band, across: band.reach + r.excess }));
    // How far across a scene point is, in grid units, as the Banda's shape measures it.
    const acrossOf = (x: number, y: number) => {
      const offset = groundOffset((x - r.x) / dpi, (y - r.y) / dpi, r.hex ?? "circle");
      return distance3D(offset.x, offset.y, 0, r.metric);
    };
    if (this.options.ringFill) {
      const { x0, y0, step, w, h, cells } = this.grid;
      const data = new Uint8Array(w * h * 4);
      const colors = bands.map((band) => new THREE.Color(band.color));
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const n = j * w + i;
          if (Number.isNaN(cells[n])) {
            continue;
          }
          const across = acrossOf(x0 + i * step, y0 + j * step);
          const index = bands.findIndex((band) => across <= band.across);
          if (index >= 0) {
            data.set([Math.round(colors[index].r * 255), Math.round(colors[index].g * 255), Math.round(colors[index].b * 255), 70], n * 4);
          }
        }
      }
      if (!this.reachTexture || this.reachTexture.image.width !== w || this.reachTexture.image.height !== h) {
        this.reachTexture?.dispose();
        this.reachTexture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
        this.reachTexture.magFilter = THREE.LinearFilter;
        this.reachTexture.minFilter = THREE.LinearFilter;
        for (const child of this.fillGroup.children) {
          ((child as THREE.Mesh).material as THREE.MeshBasicMaterial).map = this.reachTexture;
          ((child as THREE.Mesh).material as THREE.MeshBasicMaterial).needsUpdate = true;
        }
      } else {
        (this.reachTexture.image.data as Uint8Array).set(data);
      }
      this.reachTexture.needsUpdate = true;
    }
    if (!this.options.rings) {
      return;
    }
    // The outline's corners, in grid units from the token, for a Banda `across` wide.
    const outline = (across: number): [number, number][] => {
      if (r.hex) {
        // Six sides, their middles `across` cells away (hex steps), pointy side as the grid has it.
        const corner = across / Math.cos(Math.PI / 6);
        const turn = r.hex === "hexHorizontal" ? Math.PI / 6 : 0;
        return Array.from({ length: 6 }, (_, i) => [Math.cos(turn + (i * Math.PI) / 3) * corner, Math.sin(turn + (i * Math.PI) / 3) * corner]);
      }
      if (r.metric === "cubic") {
        return [[-across, -across], [across, -across], [across, across], [-across, across]];
      }
      return Array.from({ length: 96 }, (_, i) => [Math.cos((i * Math.PI) / 48) * across, Math.sin((i * Math.PI) / 48) * across]);
    };
    const stride = dpi * 0.1;
    for (const band of bands) {
      const corners = outline(band.across).map(([x, y]): [number, number] => [r.x + x * dpi, r.y + y * dpi]);
      const segments: number[] = [];
      let previous: number[] | null = null;
      for (let c = 0; c < corners.length; c++) {
        const [ax, ay] = corners[c];
        const [bx, by] = corners[(c + 1) % corners.length];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / stride));
        for (let s = c === 0 ? 0 : 1; s <= steps; s++) {
          const x = ax + ((bx - ax) * s) / steps;
          const y = ay + ((by - ay) * s) / steps;
          const ground = this.gridHeight(x, y);
          // Off the map: the line breaks there.
          const point = Number.isNaN(ground) ? null : [x * u, y * u, ground * k + 1.5];
          if (point && previous) {
            segments.push(...previous, ...point);
          }
          previous = point;
        }
      }
      if (segments.length === 0) {
        continue;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segments), 3));
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: new THREE.Color(band.color), transparent: true, opacity: 0.95 }));
      lines.renderOrder = 4;
      this.ringGroup.add(lines);
    }
  }

  /** A copy of a flat piece, for the Banda tint (see buildReach): the same shape, its texture the heights grid's. */
  private fillCopy(geometry: THREE.BufferGeometry, z: number, group = this.fillGroup, texture = this.reachTexture, order = 3) {
    const { x0, y0, step, w, h } = this.grid;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const uv = new Float32Array(position.count * 2);
    for (let i = 0; i < position.count; i++) {
      // The grid's points are its texture's pixel centers.
      uv[i * 2] = ((position.getX(i) / this.u - x0) / step + 0.5) / w;
      uv[i * 2 + 1] = ((position.getY(i) / this.u - y0) / step + 0.5) / h;
    }
    const copy = geometry.clone();
    copy.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(copy, material);
    mesh.position.z = z;
    mesh.renderOrder = order;
    group.add(mesh);
  }

  /**
   * The player view's fog (null: none): a picture over everything on the
   * ground (copies of the pieces, walls and standing pictures, see fogCopy),
   * redrawn on its own once a frame at most — moving a light doesn't
   * rebuild the terrain.
   */
  setFog(fog: Fog | null) {
    this.fog = fog;
    if (!this.fogFrame) {
      this.fogFrame = requestAnimationFrame(() => {
        this.fogFrame = 0;
        this.drawFog();
        this.requestApply();
      });
    }
  }

  /** Whether a scene point is under the player view's fog. */
  fogged(x: number, y: number): boolean {
    return this.fog ? this.fog.at(x, y) : false;
  }

  /**
   * The fog as a picture of the whole map: its colour over the scene (or its
   * shapes), the lit areas cut out of it, sharp — up to 1024 px across.
   */
  private drawFog() {
    const fog = this.fog;
    const scene = this.scene;
    this.fogGroup.visible = !!fog && !!scene;
    for (const child of this.edgeGroup.children) {
      if (child.userData.fog) {
        child.visible = this.fogGroup.visible;
      }
    }
    if (!fog || !scene) {
      return;
    }
    const { x0, y0, x1, y1 } = scene.bounds;
    const w = x1 - x0 || 1;
    const h = y1 - y0 || 1;
    const px = Math.min(1024 / Math.max(w, h), (16 / scene.dpi));
    const canvas = this.fogCanvas ?? document.createElement("canvas");
    const cw = Math.max(1, Math.ceil(w * px));
    const ch = Math.max(1, Math.ceil(h * px));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      this.fogTexture?.dispose();
      this.fogTexture = null;
    }
    this.fogCanvas = canvas;
    const context = canvas.getContext("2d")!;
    context.globalCompositeOperation = "source-over";
    context.clearRect(0, 0, cw, ch);
    context.fillStyle = fog.color;
    const trace = (ring: [number, number][]) => {
      ring.forEach(([x, y], i) => (i === 0 ? context.moveTo((x - x0) * px, (y - y0) * px) : context.lineTo((x - x0) * px, (y - y0) * px)));
      context.closePath();
    };
    if (fog.filled) {
      context.fillRect(0, 0, cw, ch);
    } else {
      context.beginPath();
      fog.shapes.forEach(trace);
      context.fill("evenodd");
    }
    // What the lights reveal, cut out.
    context.globalCompositeOperation = "destination-out";
    context.beginPath();
    fog.lit.forEach(trace);
    context.fill("nonzero");
    if (!this.fogTexture) {
      this.fogTexture = new THREE.CanvasTexture(canvas);
      for (const child of [...this.fogGroup.children, ...this.edgeGroup.children.filter((c) => c.userData.fog)]) {
        const material = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
        material.map = this.fogTexture;
        material.needsUpdate = true;
      }
    }
    this.fogTexture.needsUpdate = true;
  }

  /**
   * A copy of something on the map (a piece, a wall, a standing picture),
   * for the fog to cover: the same shape and place, its texture the fog's
   * picture laid from above (so a wall takes the fog at its foot).
   */
  private fogCopy(geometry: THREE.BufferGeometry, z = 0, group: THREE.Group = this.fogGroup) {
    const scene = this.scene!;
    const { x0, y0, x1, y1 } = scene.bounds;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const uv = new Float32Array(position.count * 2);
    for (let i = 0; i < position.count; i++) {
      uv[i * 2] = (position.getX(i) / this.u - x0) / (x1 - x0 || 1);
      uv[i * 2 + 1] = 1 - (position.getY(i) / this.u - y0) / (y1 - y0 || 1);
    }
    const copy = geometry.clone();
    copy.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    const mesh = new THREE.Mesh(
      copy,
      new THREE.MeshBasicMaterial({
        map: this.fogTexture,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      })
    );
    // A little above, so what lies on the ground there (the Banda rings) is under it too.
    mesh.position.z = z + 2;
    mesh.renderOrder = 5;
    mesh.visible = group === this.fogGroup || this.fogGroup.visible;
    mesh.userData.fog = true;
    group.add(mesh);
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

  /**
   * A drag across the screen (px) as a move across the map (scene px), at
   * the height the camera turns around: turned with the camera, and longer
   * up and down the screen the flatter it looks.
   */
  screenDelta(dx: number, dy: number): { x: number; y: number } {
    const c = this.camera;
    const s = this.fit * c.zoom;
    const cos = Math.cos((c.tilt * Math.PI) / 180);
    const squash = Math.abs(cos) < 0.3 ? Math.sign(cos || 1) * 0.3 : cos;
    const vx = dx / s;
    const vy = dy / (s * squash);
    const a = (-c.yaw * Math.PI) / 180;
    return { x: (vx * Math.cos(a) - vy * Math.sin(a)) / this.u, y: (vx * Math.sin(a) + vy * Math.cos(a)) / this.u };
  }

  /** The terrain under a point of the stage (px from its corner), as a place for the camera to turn around; null off the terrain. */
  pickTerrain(x: number, y: number): Camera["focus"] {
    if (!this.scene || this.width === 0) {
      return null;
    }
    const inverse = this.camMatrix().inverse();
    const eye = inverse.transformPoint(new DOMPoint(0, 0, this.persp));
    const through = inverse.transformPoint(new DOMPoint(x - this.width / 2, y - this.height / 2, 0));
    // Along the ray over the heights grid (not against every triangle: that's thousands, every move
    // of a drag): from where it comes down into the terrain's heights to where it leaves them, in
    // steps of the grid, the first point under the ground there, then narrowed down.
    const u = this.u;
    const k = this.k;
    const dx = through.x - eye.x;
    const dy = through.y - eye.y;
    const dz = through.z - eye.z;
    if (dz >= 0) {
      return null;
    }
    const top = (this.maxH + 0.5) * k;
    const bottom = (this.base - 0.5) * k;
    const t0 = Math.max(0, (top - eye.z) / dz);
    const t1 = (bottom - eye.z) / dz;
    const length = Math.hypot(dx, dy, dz) * (t1 - t0);
    const step = (this.grid.step * u) / 2;
    const count = Math.min(20000, Math.ceil(length / step));
    const at = (t: number) => ({ x: eye.x + dx * t, y: eye.y + dy * t, z: eye.z + dz * t });
    const under = (p: { x: number; y: number; z: number }) => {
      const h = this.gridHeight(p.x / u, p.y / u);
      return !Number.isNaN(h) && p.z <= h * k;
    };
    let before = t0;
    for (let i = 1; i <= count; i++) {
      const t = t0 + ((t1 - t0) * i) / count;
      if (under(at(t))) {
        // Narrowed down between the last point above and this one.
        let lo = before;
        let hi = t;
        for (let j = 0; j < 12; j++) {
          const mid = (lo + hi) / 2;
          if (under(at(mid))) {
            hi = mid;
          } else {
            lo = mid;
          }
        }
        const p = at(hi);
        const h = this.gridHeight(p.x / u, p.y / u);
        return { x: p.x / u, y: p.y / u, z: h };
      }
      before = t;
    }
    return null;
  }

  /** A token's place, for the camera to turn around it. */
  tokenFocus(id: string): Camera["focus"] {
    const token = this.scene?.tokens.find((t) => t.id === id);
    return token ? { x: token.x, y: token.y, z: token.terrain + token.own } : null;
  }

  setOptions(options: Partial<Options>) {
    const changed = (keys: (keyof Options)[]) => keys.some((key) => key in options && options[key] !== this.options[key]);
    const rebuild = changed(["heightScale", "shade", "levels", "relief", "tint", "wallStyle", "rings", "ringFill"]);
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
    const sloped = scene.pieces.some((piece) => piece.slope);
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
            // A standing block's front is the picture itself: an unfolded one's, its base edge only (its
            // slanting sides, wider than the picture, keep their walls); a box's, whatever faces its way.
            if (piece.unfold ? onBase(piece.unfold.base, mx, my, nx, ny, piece.unfold.out, probe * 3) : piece.stand && nx * FACING[piece.stand][0] + ny * FACING[piece.stand][1] > 0.5) {
              continue;
            }
            const lower = scene.pieceAt(mx + nx * probe, my + ny * probe);
            // With ramps about, every edge is cut in short steps: a ramp may meet it anywhere along
            // it (not only at its middle), and the heights on either side change there.
            const steps = sloped ? Math.max(1, Math.ceil(len / (scene.dpi * 0.25))) : 1;
            for (let j = 0; j < steps; j++) {
              const [px, py] = [ax + (dx * j) / steps, ay + (dy * j) / steps];
              const [qx, qy] = [ax + (dx * (j + 1)) / steps, ay + (dy * (j + 1)) / steps];
              const outP = scene.heightAt(px + nx * probe, py + ny * probe);
              const outQ = scene.heightAt(qx + nx * probe, qy + ny * probe);
              const edge = outP === undefined && outQ === undefined;
              const t0 = pieceHeight(piece, px, py);
              const t1 = pieceHeight(piece, qx, qy);
              // The higher side draws the wall: where this one's lower at an end, it narrows to nothing there.
              // Beside a ramp, down to the lowest ground along the step (its ends and middle): where a ramp
              // ends partway along, a straight line between the ends would leave a wedge open, and what
              // reaches below the ground is hidden under it.
              let low0 = outP ?? this.base;
              let low1 = outQ ?? this.base;
              if (steps > 1) {
                const outM = scene.heightAt((px + qx) / 2 + nx * probe, (py + qy) / 2 + ny * probe) ?? this.base;
                low0 = low1 = Math.min(low0, low1, outM);
              }
              const b0 = Math.min(t0, low0);
              const b1 = Math.min(t1, low1);
              if (t0 - b0 < 1e-6 && t1 - b1 < 1e-6) {
                continue;
              }
              this.walls.push({
                style: piece.walls ?? lower?.walls,
                ax: px, ay: py, bx: qx, by: qy, t0, t1, b0, b1, edge,
                mx: (px + qx) / 2 - nx * probe * 3, my: (py + qy) / 2 - ny * probe * 3, nx, ny,
                lit: Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1]) / l),
              });
            }
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
    if (this.options.grid && (scene.squareGrid || scene.hexGrid)) {
      source = document.createElement("canvas");
      source.width = texture.canvas.width;
      source.height = texture.canvas.height;
      const context = source.getContext("2d")!;
      context.drawImage(texture.canvas, 0, 0);
      const px = source.width / texture.w;
      context.strokeStyle = "rgba(0,0,0,0.35)";
      context.lineWidth = Math.max(1, px * scene.dpi * 0.02);
      context.beginPath();
      const hex = scene.hexGrid;
      if (hex) {
        // Every cell's outline, laid out from one cell's center as Owlbear's grid is: flat-topped
        // cells in columns (horizontal), pointy-topped ones in rows (vertical), a cell (dpi) apart.
        const dpi = scene.dpi;
        const corners = cellCorners(0.5, hex.shape).map((c) => [c.x * dpi, c.y * dpi]);
        const across = dpi * Math.cos(Math.PI / 6);
        const flat = hex.shape === "hexHorizontal";
        const [stepA, stepB] = flat ? [across, dpi] : [dpi, across];
        const from = (v: number, origin: number, step: number) => origin + Math.floor((v - origin) / step - 1) * step;
        for (let a = from(flat ? texture.x0 : texture.y0, flat ? hex.center.x : hex.center.y, flat ? stepA : stepB); a <= (flat ? texture.x0 + texture.w : texture.y0 + texture.h) + dpi; a += flat ? stepA : stepB) {
          const line = Math.round((a - (flat ? hex.center.x : hex.center.y)) / (flat ? stepA : stepB));
          // Every other column (row) sits half a cell along.
          const shift = (((line % 2) + 2) % 2) * 0.5 * dpi;
          for (let b = from(flat ? texture.y0 : texture.x0, (flat ? hex.center.y : hex.center.x) + shift, dpi); b <= (flat ? texture.y0 + texture.h : texture.x0 + texture.w) + dpi; b += dpi) {
            const cx = flat ? a : b;
            const cy = flat ? b : a;
            corners.forEach(([x, y], i) => {
              const px0 = (cx + x - texture.x0) * px;
              const py0 = (cy + y - texture.y0) * px;
              if (i === 0) {
                context.moveTo(px0, py0);
              } else {
                context.lineTo(px0, py0);
              }
            });
            context.closePath();
          }
        }
      } else {
        for (let x = Math.ceil(texture.x0 / scene.dpi) * scene.dpi; x <= texture.x0 + texture.w; x += scene.dpi) {
          context.moveTo((x - texture.x0) * px, 0);
          context.lineTo((x - texture.x0) * px, source.height);
        }
        for (let y = Math.ceil(texture.y0 / scene.dpi) * scene.dpi; y <= texture.y0 + texture.h; y += scene.dpi) {
          context.moveTo(0, (y - texture.y0) * px);
          context.lineTo(source.width, (y - texture.y0) * px);
        }
      }
      context.stroke();
    }
    this.mapTexture?.dispose();
    const map = new THREE.CanvasTexture(source);
    map.anisotropy = this.renderer?.capabilities.getMaxAnisotropy() ?? 1;
    this.mapTexture = map;
    for (const material of this.pieceMaterials) {
      if (material.userData.mapTextured) {
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
    material.userData.mapTextured = textured;
    this.pieceMaterials.push(material);
    return material;
  }

  /**
   * The walls: two meshes (inside, and at the map's edge, which can be
   * hidden), shaded top to bottom and by the light, their faces as the
   * wall style has them (their zone's, or the Vistazo's), and level lines
   * at every whole cell of height.
   */
  private buildWalls() {
    const u = this.u;
    const k = this.k;
    // The fold's strip: how far into the map it reaches, in view units.
    const band = VIEW_CELL * 0.75;
    // One mesh for each style, inside and at the map's edge (which can be hidden).
    const styles = new Set(this.walls.map((wall) => wall.style ?? this.options.wallStyle));
    for (const [edge, style] of [false, true].flatMap((e) => [...styles].map((st) => [e, st] as const))) {
      const walls = this.walls.filter((wall) => wall.edge === edge && (wall.style ?? this.options.wallStyle) === style);
      if (walls.length === 0) {
        continue;
      }
      const fromMap = (style === "stretch" || style === "fold") && this.texture !== null;
      const pattern = style === "stone" || style === "earth" || style === "wood" ? patternTexture(style) : null;
      const positions: number[] = [];
      const colors: number[] = [];
      const uvs: number[] = [];
      const levels: number[] = [];
      for (const wall of walls) {
        const s = 1 - this.options.shade * (1 - (0.45 + 0.55 * wall.lit));
        // Taken from the map, its colour is in the texture: the vertices only shade it.
        const rgb = fromMap ? [255, 255, 255] : this.colors ? this.colors(wall.mx, wall.my) : STONE;
        const top = rgb.map((v) => (v / 255) * s * 0.92);
        const bottom = top.map((v) => v * 0.62);
        const [ax, ay, bx, by] = [wall.ax * u, wall.ay * u, wall.bx * u, wall.by * u];
        const [zt0, zt1, zb0, zb1] = [wall.t0 * k, wall.t1 * k, wall.b0 * k, wall.b1 * k];
        const zt = zt0;
        const zb = zb0;
        const length = Math.hypot(bx - ax, by - ay);
        // A slanting side (beside a ramp): one quad with its own heights at each end.
        const slanted = Math.abs(zt0 - zt1) > 1e-3 || Math.abs(zb0 - zb1) > 1e-3;
        // Into the piece from the edge (the wall's normal points out).
        const [ix, iy] = [-wall.nx, -wall.ny];
        // One slice of the face, from depth t0 to t1 below the top, with its texture coordinates.
        const slice = (t0: number, t1: number, uvTop: number[], uvBottom: number[]) => {
          const z0 = zt - t0;
          const z1 = zt - t1;
          const c0 = top.map((v, i) => v + (bottom[i] - v) * (t0 / (zt - zb || 1)));
          const c1 = top.map((v, i) => v + (bottom[i] - v) * (t1 / (zt - zb || 1)));
          positions.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z0, bx, by, z1, ax, ay, z1);
          colors.push(...c0, ...c0, ...c1, ...c0, ...c1, ...c1);
          // uvTop / uvBottom: [aU, aV, bU, bV] at the slice's top and bottom.
          uvs.push(uvTop[0], uvTop[1], uvTop[2], uvTop[3], uvBottom[2], uvBottom[3], uvTop[0], uvTop[1], uvBottom[2], uvBottom[3], uvBottom[0], uvBottom[1]);
        };
        const mapUv = (x: number, y: number) => this.uvAt(x, y);
        const height = zt - zb;
        if (slanted) {
          positions.push(ax, ay, zt0, bx, by, zt1, bx, by, zb1, ax, ay, zt0, bx, by, zb1, ax, ay, zb0);
          colors.push(...top, ...top, ...bottom, ...top, ...bottom, ...bottom);
          let uvTop: number[];
          let uvBottom: number[];
          if (style === "fold" && fromMap) {
            const deep = Math.min(band, Math.max(zt0 - zb0, zt1 - zb1));
            uvTop = [...mapUv(ax + ix * 0.5, ay + iy * 0.5), ...mapUv(bx + ix * 0.5, by + iy * 0.5)];
            uvBottom = [...mapUv(ax + ix * deep, ay + iy * deep), ...mapUv(bx + ix * deep, by + iy * deep)];
          } else if (style === "stretch" && fromMap) {
            uvTop = [...mapUv(ax + ix * 1.5, ay + iy * 1.5), ...mapUv(bx + ix * 1.5, by + iy * 1.5)];
            uvBottom = uvTop;
          } else {
            const tile = VIEW_CELL * 2;
            // Along the wall's own direction (not x + y): steps of one straight edge then run on without a jump.
            const s0 = ((ax * (bx - ax) + ay * (by - ay)) / (length || 1)) / tile;
            uvTop = [s0, zt0 / tile, s0 + length / tile, zt1 / tile];
            uvBottom = [s0, zb0 / tile, s0 + length / tile, zb1 / tile];
          }
          uvs.push(uvTop[0], uvTop[1], uvTop[2], uvTop[3], uvBottom[2], uvBottom[3], uvTop[0], uvTop[1], uvBottom[2], uvBottom[3], uvBottom[0], uvBottom[1]);
        } else if (style === "fold" && fromMap) {
          // Strips of the map just inside the edge, folded down, every other one mirrored.
          const inside = (d: number) => [...mapUv(ax + ix * d, ay + iy * d), ...mapUv(bx + ix * d, by + iy * d)];
          for (let t = 0, j = 0; t < height; t += band, j++) {
            const t1 = Math.min(height, t + band);
            const d0 = j % 2 === 0 ? 0 : band;
            const d1 = j % 2 === 0 ? t1 - t : band - (t1 - t);
            slice(t, t1, inside(d0 + 0.5), inside(d1 + 0.5));
          }
        } else if (style === "stretch" && fromMap) {
          // The map's pixels at the top edge (a hair inside), stretched down.
          const edgeUv = [...mapUv(ax + ix * 1.5, ay + iy * 1.5), ...mapUv(bx + ix * 1.5, by + iy * 1.5)];
          slice(0, height, edgeUv, edgeUv);
        } else {
          // A pattern 2 cells a tile, along the wall and down from the ground level (so courses line up).
          const tile = VIEW_CELL * 2;
          // Along the wall's own direction, as above.
          const s0 = ((ax * (bx - ax) + ay * (by - ay)) / (length || 1)) / tile;
          const v = (z: number) => z / tile;
          slice(0, height, [s0, v(zt), s0 + length / tile, v(zt)], [s0, v(zb), s0 + length / tile, v(zb)]);
        }
        // Level lines at every whole cell of height, counted from the ground.
        if (this.options.levels) {
          const lowest = Math.min(wall.b0, wall.b1);
          const highest = Math.max(wall.t0, wall.t1);
          for (let n = Math.ceil(lowest + 1e-6); n < highest - 1e-6; n++) {
            // Where along the wall that height is on its face (bottom ≤ n ≤ top), 0 to 1.
            const span = within(wall.b0, wall.b1, wall.t0, wall.t1, n);
            if (span) {
              const [s0, s1] = span;
              levels.push(ax + (bx - ax) * s0, ay + (by - ay) * s0, n * k, ax + (bx - ax) * s1, ay + (by - ay) * s1, n * k);
            }
          }
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
      const group = edge ? this.edgeGroup : this.terrainGroup;
      const material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        map: fromMap ? this.mapTexture : pattern,
      });
      material.userData.color = new THREE.Color(1, 1, 1);
      material.userData.mapTextured = fromMap;
      this.pieceMaterials.push(material);
      group.add(new THREE.Mesh(geometry, material));
      // The fog covers walls too (a wall would give the hidden terrain away); the map edge's, with them (shown or not).
      this.fogCopy(geometry, 0, edge ? this.edgeGroup : this.fogGroup);
      if (levels.length > 0) {
        const lines = new THREE.BufferGeometry();
        lines.setAttribute("position", new THREE.BufferAttribute(new Float32Array(levels), 3));
        group.add(new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 })));
      }
    }
  }

  /**
   * A four-point standing zone's picture, unfolded: its drawn shape (base,
   * top) stretched into an upright rectangle on the base edge, as tall as it
   * rises — a grid of small quads, each corner where the picture's point
   * lands, so the picture bends with it.
   */
  private unfoldedCard(piece: Piece): THREE.BufferGeometry {
    const u = this.u;
    const k = this.k;
    const { base, top, out, rise } = piece.unfold!;
    const zb = (piece.standBase ?? 0) * k;
    const steps = 12;
    const positions: number[] = [];
    const uvs: number[] = [];
    const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    for (let j = 0; j <= steps; j++) {
      for (let i = 0; i <= steps; i++) {
        const along = i / steps;
        const up = j / steps;
        const foot = lerp(base[0], base[1], along);
        const drawn = lerp(foot, lerp(top[0], top[1], along), up);
        // Half a view px out in front, so it doesn't fight the block's own faces.
        positions.push(foot[0] * u + out[0] * 0.5, foot[1] * u + out[1] * 0.5, zb + up * rise * k);
        uvs.push(...(this.texture ? this.uvAt(drawn[0] * u, drawn[1] * u) : [0, 0]));
      }
    }
    const index: number[] = [];
    for (let j = 0; j < steps; j++) {
      for (let i = 0; i < steps; i++) {
        const a = j * (steps + 1) + i;
        const b = a + 1;
        const c = a + steps + 1;
        const d = c + 1;
        index.push(a, b, d, a, d, c);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geometry.setIndex(index);
    return geometry;
  }

  /** The map texture's coordinates at a view-unit point. */
  private uvAt(x: number, y: number): [number, number] {
    const t = this.texture!;
    return [(x / this.u - t.x0) / t.w, 1 - (y / this.u - t.y0) / t.h];
  }

  private build() {
    const scene = this.scene;
    if (!scene) {
      return;
    }
    this.clear(this.terrainGroup);
    this.clear(this.edgeGroup);
    this.clear(this.fillGroup);
    this.reachTexture?.dispose();
    this.reachTexture = null;
    this.clear(this.fogGroup);
    this.pieceMaterials = [];
    const u = this.u;
    this.k = VIEW_CELL * this.options.heightScale;
    const k = this.k;

    for (const piece of scene.pieces) {
      this.buildPiece(piece);
    }

    this.buildWalls();

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
        const za = wall.b0 * k + 0.4;
        const zb = wall.b1 * k + 0.4;
        positions.set([ax, ay, za, bx, by, zb, dx, dy, zb, ax, ay, za, dx, dy, zb, cx, cy, za], i * 18);
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

    this.fogTexture?.dispose();
    this.fogTexture = null;
    this.drawFog();
    this.buildTokens();
    this.buildReach();
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
      if (piece.slope) {
        // A ramp: each corner at its own height (a plane: the triangles stay flat).
        for (let i = 0; i < position.count; i++) {
          position.setZ(i, pieceHeight(piece, position.getX(i) / u, position.getY(i) / u) * k);
        }
        position.needsUpdate = true;
      } else {
        mesh.position.z = z;
      }
      this.terrainGroup.add(mesh);
      this.fillCopy(geometry, piece.slope ? 0 : z);
      this.fogCopy(geometry, piece.slope ? 0 : z);
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
    // Its top: the walls' pattern (stone, earth or wood; stone when they take theirs from the map),
    // tinted with the map's colour there, laid out flat a tile every two cells.
    const style = piece.walls ?? this.options.wallStyle;
    const roof = style === "earth" || style === "wood" ? style : "stone";
    const tile = VIEW_CELL * 2;
    const roofUv = new Float32Array(position.count * 2);
    for (let i = 0; i < position.count; i++) {
      roofUv[i * 2] = position.getX(i) / tile;
      roofUv[i * 2 + 1] = position.getY(i) / tile;
    }
    const roofGeometry = geometry.clone();
    roofGeometry.setAttribute("uv", new THREE.BufferAttribute(roofUv, 2));
    const roofMaterial = this.pieceMaterial(piece.height, false, rgb.map((v) => v * 0.85) as [number, number, number]);
    roofMaterial.map = patternTexture(roof);
    const top = new THREE.Mesh(roofGeometry, roofMaterial);
    top.position.z = z;
    this.terrainGroup.add(top);
    this.fogCopy(geometry, z);

    if (piece.unfold) {
      const unfolded = this.unfoldedCard(piece);
      this.terrainGroup.add(new THREE.Mesh(unfolded, this.pieceMaterial(piece.height, true)));
      this.fogCopy(unfolded);
      return;
    }
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
    this.fogCopy(card);
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
      let stem: THREE.Line | null = null;
      if (token.own !== 0) {
        stem = new THREE.Line(
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
      let title: HTMLElement | undefined;
      let detail: HTMLElement | undefined;
      if (shown !== "none") {
        const label = document.createElement("div");
        label.className = "lbl";
        title = document.createElement("span");
        label.append(title);
        if (shown === "full") {
          detail = document.createElement("small");
          label.append(detail);
        }
        disc.append(label);
      }
      disc.append(img);
      el.appendChild(disc);
      overlay.appendChild(el);
      const view: TokenView = { token, el, disc, img, zTok, screen: { x: 0, y: 0 }, hidden: false, marks: { base: [disc3d, ring3d], stem }, title, detail };
      this.writeLabel(view);
      return view;
    });
    this.tokenViews = [...propViews, ...this.tokenViews];
    this.tokenOverlay.replaceChildren(overlay);
    this.drawnProps = scene.props;
  }

  /** A token's label, as the options have it, from its height now. */
  private writeLabel(view: TokenView) {
    const shown = this.options.tokenLabels;
    if (!view.title) {
      return;
    }
    const text = this.tokenText(view.token);
    view.title.textContent = shown === "full" ? `${text.name} · ${text.height}` : shown === "height" ? text.height : text.name;
    if (view.detail) {
      view.detail.textContent = text.detail;
    }
  }

  /**
   * The same tokens as drawn, some moved (or raised): each one's marks and
   * label put right in place. False when that won't do (tokens came or went,
   * one went from flying to standing or back, a prop changed): then they're
   * built again.
   */
  private moveTokens(scene: VistazoScene): boolean {
    const views = this.tokenViews.filter((view) => !view.prop);
    if (views.length !== scene.tokens.length || this.tokenViews.length - views.length !== (this.options.props === "stand" ? scene.props.length : 0)) {
      return false;
    }
    if (this.options.props === "flat" && scene.props !== this.drawnProps) {
      return false;
    }
    const byId = new Map(scene.tokens.map((token) => [token.id, token]));
    if (views.some((view) => !byId.has(view.token.id) || (view.token.own === 0) !== (byId.get(view.token.id)!.own === 0) || (view.token.own < 0) !== (byId.get(view.token.id)!.own < 0))) {
      return false;
    }
    const u = this.u;
    const k = this.k;
    for (const view of views) {
      const token = byId.get(view.token.id)!;
      const moved = token.x !== view.token.x || token.y !== view.token.y || token.own !== view.token.own || token.terrain !== view.token.terrain;
      view.token = token;
      view.el.classList.toggle("gmhidden", token.hidden);
      if (!moved) {
        continue;
      }
      const zFloor = token.terrain * k;
      view.zTok = (token.terrain + token.own) * k;
      for (const mesh of view.marks?.base ?? []) {
        mesh.position.set(token.x * u, token.y * u, zFloor + 1);
      }
      const stem = view.marks?.stem;
      if (stem) {
        const position = stem.geometry.getAttribute("position") as THREE.BufferAttribute;
        position.setXYZ(0, token.x * u, token.y * u, view.zTok);
        position.setXYZ(1, token.x * u, token.y * u, zFloor);
        position.needsUpdate = true;
        stem.computeLineDistances();
      }
      this.writeLabel(view);
    }
    return true;
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
    // Only when it really changed: setting the size reallocates the canvas's whole drawing buffer.
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w !== this.canvasSize.w || h !== this.canvasSize.h) {
      this.canvasSize = { w, h };
      this.renderer?.setSize(w, h, false);
    }
    this.apply();
  }

  /** Everything that wants the picture redrawn in a frame, drawn once in it. */
  requestApply() {
    if (!this.applyFrame) {
      this.applyFrame = requestAnimationFrame(() => {
        this.applyFrame = 0;
        this.apply();
      });
    }
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

/** A small deterministic random, so a pattern is the same every time. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A grey tile (256 px, two cells across) that repeats seamlessly, to tint
 * with the map's colour: stone courses, earth strata, or planks.
 */
function patternTexture(style: "stone" | "earth" | "wood"): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext("2d")!;
  const random = seeded(style === "stone" ? 7 : style === "earth" ? 11 : 13);
  const grey = (v: number) => `rgb(${v},${v},${v})`;
  if (style === "stone") {
    // Four courses of blocks, each row offset, with dark mortar.
    c.fillStyle = grey(120);
    c.fillRect(0, 0, size, size);
    const row = size / 4;
    for (let r = 0; r < 4; r++) {
      let x = -random() * 60;
      while (x < size) {
        const w = 70 + random() * 60;
        const shade = 205 + random() * 40;
        for (const dx of [0, size]) {
          // Drawn twice, a tile apart, so blocks wrap around the edge.
          c.fillStyle = grey(shade);
          c.fillRect(x + dx - size + 3, r * row + 3, w - 6, row - 6);
          c.fillRect(x + dx + 3, r * row + 3, w - 6, row - 6);
        }
        x += w;
      }
    }
  } else if (style === "earth") {
    // Wavy strata of different shades, with speckles.
    let y = 0;
    while (y < size) {
      const h = 14 + random() * 30;
      const shade = 170 + random() * 70;
      const phase = random() * Math.PI * 2;
      const amp = 2 + random() * 4;
      c.fillStyle = grey(shade);
      c.beginPath();
      c.moveTo(0, size);
      for (let x = 0; x <= size; x += 8) {
        c.lineTo(x, y + Math.sin((x / size) * Math.PI * 4 + phase) * amp);
      }
      c.lineTo(size, size);
      c.closePath();
      c.fill();
      y += h;
    }
    for (let i = 0; i < 900; i++) {
      c.fillStyle = grey(random() < 0.5 ? 120 + random() * 40 : 235);
      c.fillRect(random() * size, random() * size, 1 + random() * 2, 1 + random() * 2);
    }
  } else {
    // Upright planks with grain and dark gaps.
    c.fillStyle = grey(90);
    c.fillRect(0, 0, size, size);
    const widths: number[] = [];
    let total = 0;
    while (total < size - 40) {
      const w = 28 + Math.round(random() * 16);
      widths.push(w);
      total += w;
    }
    widths.push(size - total);
    let x = 0;
    for (const w of widths) {
      c.fillStyle = grey(200 + random() * 40);
      c.fillRect(x + 2, 0, w - 4, size);
      c.strokeStyle = "rgba(0,0,0,0.12)";
      c.lineWidth = 1;
      for (let g = 0; g < 4; g++) {
        const gx = x + 6 + random() * (w - 12);
        const phase = random() * Math.PI * 2;
        c.beginPath();
        for (let y = 0; y <= size; y += 8) {
          c.lineTo(gx + Math.sin((y / size) * Math.PI * 2 + phase) * 2, y);
        }
        c.stroke();
      }
      x += w;
    }
  }
  // A little noise over all of it.
  const image = c.getImageData(0, 0, size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (random() - 0.5) * 18;
    image.data[i] += n;
    image.data[i + 1] += n;
    image.data[i + 2] += n;
  }
  c.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/**
 * Where along a wall (0 to 1) the height n is on its face: its bottom runs
 * b0 to b1 and its top t0 to t1, both straight, so it's where b ≤ n ≤ t.
 */
function within(b0: number, b1: number, t0: number, t1: number, n: number): [number, number] | null {
  let lo = 0;
  let hi = 1;
  // f(s) = f0 + (f1 − f0)·s ≥ 0, narrowing [lo, hi].
  const atLeast = (f0: number, f1: number) => {
    if (Math.abs(f1 - f0) < 1e-9) {
      if (f0 < 0) {
        hi = -1;
      }
      return;
    }
    const s = -f0 / (f1 - f0);
    if (f1 > f0) {
      lo = Math.max(lo, s);
    } else {
      hi = Math.min(hi, s);
    }
  };
  atLeast(n - b0, n - b1);
  atLeast(t0 - n, t1 - n);
  return hi - lo > 1e-6 ? [lo, hi] : null;
}

/** Whether an edge (its middle, its outward normal) is on an unfolded zone's base edge: facing its way, on its line. */
function onBase(base: [[number, number], [number, number]], mx: number, my: number, nx: number, ny: number, out: [number, number], near: number): boolean {
  if (nx * out[0] + ny * out[1] < 0.98) {
    return false;
  }
  const [[ax, ay], [bx, by]] = base;
  const length = Math.hypot(bx - ax, by - ay) || 1;
  // Its distance from the base's line.
  return Math.abs(((mx - ax) * (by - ay) - (my - ay) * (bx - ax)) / length) < near;
}
