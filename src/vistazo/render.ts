import * as THREE from "three";
import { TessellateModifier } from "three/examples/jsm/modifiers/TessellateModifier.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { MultiPolygon } from "polygon-clipping";
import { inShape, pieceHeight, type Bridge, type Piece, type Prop, type Token, type VistazoScene } from "./scene";
import { distance3D } from "../engine/distance";
import { cellCorners, groundOffset } from "../engine/hex";
import type { Fog } from "./fog";
import { visibleBox } from "./visibleBox";
import { buildWeather, cloudShadowMaterial, setWeatherTime } from "./weather";
import { buildTemplate, templateTip, type Template } from "./templates";
import { QUALITY, STONE, TEXTURE_MAX, VIEW_CELL, type Camera, type DistanceLine, type Options, type Reach, type Texture, type TokenText, type TokenView, type Wall, type WallStyle, tintOf } from "./view/types";
import { isShared, patternTexture } from "./view/patterns";
import { floorOf, mediaElement, propsKey, propToken, raised, skinAcross, skinPoint, visibleOnScreen, within } from "./view/helpers";
import { computeWalls, type Region } from "./view/walls";
import { BaseBatch, moveBase, type BaseSeat } from "./view/bases";
import { UNDER_FRAGMENT, UNDER_VERTEX } from "./view/shaders";
import { waterMaterial, waterReach, waterShape, type WaterReach } from "./view/water";
import { time } from "../timing";

export type { Camera, DistanceLine, Options, Quality, Reach, TokenText, WallStyle } from "./view/types";
export { tintOf };

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

// Colours pass through as they are, as they did in CSS: the map's pixels,
// the walls' shades and the tints, without linear/sRGB conversions.
THREE.ColorManagement.enabled = false;


/** The painted bases' picture (see paintBases): pixels a cell, and the most a side (as a texture holds). */
const BASES_PER_CELL = 48;
const BASES_MAX = 4096;

export class VistazoView {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer | null;
  private readonly world = new THREE.Scene();
  private readonly terrainGroup = new THREE.Group();
  /** A relief's shapes being dragged: their pieces, walls and pictures, moved whole (see moveShapes). */
  private readonly movingGroup = new THREE.Group();
  /** Which shapes are in it (their indexes, as a key). */
  private movingKey = "";
  /** What's under the shapes being dragged, where they were (see fillUnder). */
  private readonly underGroup = new THREE.Group();
  /** The relief editor's picked shapes, a veil over their tops (see highlight). */
  private readonly pickGroup = new THREE.Group();
  private picked: { shapes: number[]; color: string } = { shapes: [], color: "#bb99ff" };
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
  /** The props as last drawn (see propsKey): rebuilt when they change. */
  private drawnProps = "";
  /** The flat props' videos (webm): drawn again on each new frame of theirs (see watchVideo). */
  private videoTextures = new Set<THREE.VideoTexture>();
  private videoFrame = 0;
  /** The panel minimized: every video paused (see setPaused). */
  private paused = false;
  /** The weather's particles (see weather.ts), what they were built from, and the frames they're drawn on. */
  private weatherGroup = new THREE.Group();
  /** Clouds as shadows: the terrain's surfaces under each (see copiesIn), with the shadows' material. */
  private cloudShadowGroup = new THREE.Group();
  /** Under each bridge, the terrain's surfaces there (see copiesIn), filled from beside it (see buildUnderBridges). */
  private underBridgeGroup = new THREE.Group();
  /** Volume templates placed here (see setTemplates), and the meshes drawn for them. */
  private templates: Template[] = [];
  private templateGroup = new THREE.Group();
  /** Each template's handles (its origin; a cone's or a line's tip too), to drag it here. */
  private handles: TokenView[] = [];
  /** The tokens a template reaches (see setAffected): ringed. */
  private affected = new Set<string>();
  /** The free point measured from (see setPoint): where it is, and its marker. */
  private pointAt: { x: number; y: number; height: number } | null = null;
  private point: TokenView | null = null;
  /** Zones' water surfaces (see buildWater); moving with the weather's frames while waterMotion is on. */
  private waterGroup = new THREE.Group();
  /**
   * Each water's reach (a texture on the heights grid: where it stops at a shore or a rim) and surface's outline (see buildWater), by its zone, its level and the heights
   * round it (as the grid has them): worked out again only when one of those changed.
   */
  private waterCache = new Map<string, { reach: WaterReach; shape: MultiPolygon; used: number }>();
  private weatherKey = "";
  private weatherFrame = 0;
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
  /**
   * The map's picture without the grid drawn on it (the same texture while the grid isn't shown): what
   * walls, standing pictures and slabs' sides take from the map, where the ground's cells don't belong.
   */
  private plainTexture: THREE.Texture | null = null;
  /** The materials of the pieces, to dim or see through without rebuilding. */
  private pieceMaterials: THREE.MeshBasicMaterial[] = [];
  /** Outlines already cut small (see fineGeometry), by outline: their flat triangles, and the last build that used them. */
  private fineCache = new Map<string, { position: Float32Array; index: Uint32Array; used: number }>();
  private builds = 0;
  /** The next scene's build is a brush's let go (see settleNext). */
  private settling = false;
  /** The bases painted on the terrain (see paintBases): their picture, its texture, the copies of the terrain's tops it's laid on. */
  private baseCanvas: HTMLCanvasElement | null = null;
  private baseTexture: THREE.CanvasTexture | null = null;
  private readonly baseGroup = new THREE.Group();
  /** A painted base moved (see moveTokens): painted again once they all are. */
  private basesMoved = false;
  /** The relief editor's terrain brush, where it'd paint (see setBrushRing). */
  private brushRing: THREE.LineLoop | null = null;
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
      renderer.setPixelRatio(Math.min((QUALITY[options.quality] ?? QUALITY.high).pixels, window.devicePixelRatio || 1));
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    } catch (error) {
      console.error("Rising Ranges: Vistazo couldn't start WebGL", error);
    }
    this.renderer = renderer;
    this.glCamera.matrixAutoUpdate = false;
    this.movingGroup.matrixAutoUpdate = false;
    this.world.add(this.terrainGroup, this.underGroup, this.movingGroup, this.pickGroup, this.edgeGroup, this.tokenGroup, this.ringGroup, this.fillGroup, this.baseGroup, this.fogGroup, this.weatherGroup, this.cloudShadowGroup, this.underBridgeGroup, this.waterGroup, this.templateGroup);
    this.overlay = document.createElement("div");
    this.overlay.className = "ov";
    this.lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.lines.classList.add("lines");
    this.tokenOverlay = document.createElement("div");
    this.overlay.append(this.lines, this.tokenOverlay);
    stage.prepend(this.canvas, this.overlay);
    new ResizeObserver(() => this.measure()).observe(stage);
  }

  /** Drawn lightly (see setLite). */
  private lite = false;

  /**
   * Only the terrain's heights changed (the relief's brush), not where
   * anything is: each piece's corners moved up or down where they are, and
   * the walls and their shadows built again; the rest (water, the tokens on
   * it, the fog) as it was till the next whole build. False if it can't be
   * done so (a piece drawn flat: no corners of its own to move). Only
   * within `region` (scene px), where the heights changed.
   */
  reheight(scene: VistazoScene, region: Region): boolean {
    if (!this.scene || scene.terrainKey !== this.terrainKey) {
      return false;
    }
    const u = this.u;
    const k = this.k;
    const pieces = this.terrainGroup.children.filter((child) => child.userData.piece) as THREE.Mesh[];
    if (pieces.some((mesh) => !(mesh.userData.piece as Piece).surface)) {
      return false;
    }
    const [x0, y0, x1, y1] = [region.x0 * u, region.y0 * u, region.x1 * u, region.y1 * u];
    let refine = false;
    for (const mesh of pieces) {
      const piece = mesh.userData.piece as Piece;
      let geometry = mesh.geometry;
      if (!geometry.boundingBox) {
        geometry.computeBoundingBox();
      }
      const near = geometry.boundingBox!;
      // Drawn by its outline alone, and now its heights vary inside it (painted on, a soft edge over it):
      // cut small, there and then.
      if (!mesh.userData.fine && !(near.max.x < x0 || near.min.x > x1 || near.max.y < y0 || near.min.y > y1) && piece.fine?.()) {
        const fine = this.fineGeometry(piece);
        const position = fine.getAttribute("position") as THREE.BufferAttribute;
        fine.setAttribute("uv", new THREE.BufferAttribute(this.uvs(position.array, position.count), 2));
        for (let i = 0; i < position.count; i++) {
          position.setZ(i, pieceHeight(piece, position.getX(i) / u, position.getY(i) / u) * k);
        }
        fine.computeBoundingBox();
        mesh.geometry.dispose();
        mesh.geometry = fine;
        mesh.userData.fine = true;
        geometry = fine;
        refine = true;
      }
      const box = geometry.boundingBox!;
      if (box.max.x < x0 || box.min.x > x1 || box.max.y < y0 || box.min.y > y1) {
        continue;
      }
      const position = geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < position.count; i++) {
        const [x, y] = [position.getX(i), position.getY(i)];
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
          position.setZ(i, pieceHeight(piece, x / u, y / u) * k);
        }
      }
      position.needsUpdate = true;
    }
    for (const group of [this.terrainGroup, this.edgeGroup]) {
      const walls = group.children.filter((child) => child.userData.wall);
      const gone = new Set<THREE.Material>();
      for (const child of walls) {
        group.remove(child);
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          gone.add(material);
          material.dispose();
        }
      }
      this.pieceMaterials = this.pieceMaterials.filter((material) => !gone.has(material));
    }
    this.scene = scene;
    // The heights grid there too (what the pointer finds on the terrain: the 3D brush paints on it).
    this.regridIn(region);
    // The walls of the edges through the region worked out again; the others as they were.
    const done = new Set<string>();
    const fresh = computeWalls(scene, this.base, region, done);
    this.walls = [...this.walls.filter((wall) => !done.has(wall.seg)), ...fresh];
    this.buildWalls();
    this.buildWallShadows();
    if (refine) {
      this.highlight(this.picked.shapes);
    }
    this.requestApply();
    return true;
  }

  /**
   * A relief's shapes dragged whole (moved, turned, sized): their pieces,
   * walls and pictures taken into a group of their own the first time, and
   * that moved by `map` (scene px, [a, b, c, d, e, f]: (x, y) → (a·x + c·y + e,
   * b·x + d·y + f)) from where they were drawn; nothing worked out again.
   * "started" the first time (what's under them is to be drawn where they
   * were: see fillUnder), "moved" after, false if
   * there's nothing of them to move. Their picture is the map's where they
   * are now, as they'll have it once let go. The next whole build ends it.
   */
  moveShapes(shapes: number[], map: [number, number, number, number, number, number]): "started" | "moved" | false {
    let started = false;
    const scene = this.scene;
    if (!scene) {
      return false;
    }
    const key = [...shapes].sort((a, b) => a - b).join(",");
    if (key !== this.movingKey) {
      if (this.movingKey) {
        // Others than before: drawn again whole first (their walls back where they were).
        return false;
      }
      const picked = new Set(shapes);
      const theirs = this.terrainGroup.children.filter((child) => child.userData.si !== undefined && picked.has(child.userData.si));
      if (theirs.length === 0) {
        return false;
      }
      this.movingKey = key;
      started = true;
      // The veil stays where they were: gone till they're let go (and built again where they are).
      this.highlight([]);
      this.picked.shapes = shapes;
      for (const child of theirs) {
        this.terrainGroup.remove(child);
        this.movingGroup.add(child);
      }
      // Their walls with them; the others built again without them, and the shadows at their feet.
      const pieceOf = (wall: Wall) => scene.pieces[Number(wall.seg.split(":")[0])];
      const mine = this.walls.filter((wall) => picked.has(pieceOf(wall)?.si ?? -1));
      const others = this.walls.filter((wall) => !picked.has(pieceOf(wall)?.si ?? -1));
      for (const group of [this.terrainGroup, this.edgeGroup]) {
        for (const child of group.children.filter((c) => c.userData.wall)) {
          group.remove(child);
          const mesh = child as THREE.Mesh;
          mesh.geometry.dispose();
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            this.pieceMaterials = this.pieceMaterials.filter((m) => m !== material);
            material.dispose();
          }
        }
      }
      this.buildWalls(others);
      this.buildWallShadows(others);
      this.buildWalls(mine, this.movingGroup);
    }
    const u = this.u;
    const [a, b, c, d, e, f] = map;
    // In view units (the scene's px times u): the same turn and scale, the shift times u.
    this.movingGroup.matrix.set(a, c, 0, e * u, b, d, 0, f * u, 0, 0, 1, 0, 0, 0, 0, 1);
    this.movingGroup.matrixWorldNeedsUpdate = true;
    // Their tops (and standing pictures) take the map's picture where they are now, not where they started.
    if (this.texture) {
      const moved = (xs: ArrayLike<number>) => {
        const out = new Float32Array(xs.length);
        for (let i = 0; i < xs.length; i += 3) {
          out[i] = a * xs[i] + c * xs[i + 1] + e * u;
          out[i + 1] = b * xs[i] + d * xs[i + 1] + f * u;
        }
        return out;
      };
      for (const child of this.movingGroup.children) {
        const mesh = child as THREE.Mesh;
        const cardMap = child.userData.cardMap as Float32Array | undefined;
        if (!child.userData.piece && !cardMap) {
          continue;
        }
        const position = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
        const from = cardMap ?? (position.array as Float32Array);
        mesh.geometry.setAttribute("uv", new THREE.BufferAttribute(this.uvs(moved(from), position.count), 2));
      }
    }
    this.requestApply();
    return started ? "started" : "moved";
  }

  /**
   * The relief editor's picked shapes (their indexes), shown in the 3D: a
   * veil of `color` over their tops, the same geometry as theirs (so it
   * follows a brush's heights). Kept through builds till it's changed.
   */
  highlight(shapes: number[], color = this.picked.color) {
    this.picked = { shapes, color };
    // Their geometry is the pieces' own: only the veils' materials let go.
    for (const child of [...this.pickGroup.children]) {
      this.pickGroup.remove(child);
      ((child as THREE.Mesh).material as THREE.Material).dispose();
    }
    if (shapes.length === 0) {
      this.requestApply();
      return;
    }
    const picked = new Set(shapes);
    for (const child of this.terrainGroup.children) {
      if (!child.userData.piece || !picked.has(child.userData.si)) {
        continue;
      }
      const mesh = child as THREE.Mesh;
      const veil = new THREE.Mesh(
        mesh.geometry,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
      );
      veil.position.copy(mesh.position);
      veil.renderOrder = 3;
      this.pickGroup.add(veil);
    }
    this.requestApply();
  }

  /**
   * What's under shapes being dragged, where they were: `pieces` (the relief
   * there without them, see reliefTerrain's `within`), drawn with their walls
   * in a group of their own till the next whole build.
   */
  fillUnder(pieces: Piece[]) {
    const scene = this.scene;
    if (!scene || pieces.length === 0) {
      return;
    }
    const from = this.terrainGroup.children.length;
    for (const piece of pieces) {
      this.buildPiece(piece);
    }
    for (const child of this.terrainGroup.children.slice(from)) {
      this.terrainGroup.remove(child);
      this.underGroup.add(child);
    }
    // Their walls: beside them, the heights there as they are (the hole's edge meets the rest, no wall);
    // inside, theirs.
    const pieceAt = (x: number, y: number) => {
      for (let i = pieces.length - 1; i >= 0; i--) {
        if (inShape(x, y, pieces[i].shape)) {
          return pieces[i];
        }
      }
      return undefined;
    };
    const under: VistazoScene = {
      ...scene,
      pieces,
      pieceAt: (x, y) => pieceAt(x, y) ?? scene.pieceAt(x, y),
      heightAt: (x, y) => {
        const piece = pieceAt(x, y);
        return piece ? pieceHeight(piece, x, y) : scene.heightAt(x, y);
      },
    };
    this.buildWalls(computeWalls(under, this.base), this.underGroup);
    this.requestApply();
  }

  /**
   * Lightly, while the relief editor drags something: the terrain alone, without
   * its copies for the fog, the Banda tint, the cloud shadows and under bridges
   * (the most of a rebuild). Off again, the next scene is drawn whole (or,
   * `settling`, by settleNext's build).
   */
  setLite(lite: boolean, settling = false) {
    if (this.lite === lite) {
      return;
    }
    this.lite = lite;
    if (!lite && !settling) {
      this.terrainKey = "";
    }
  }

  /**
   * A brush let go (see vistazo/settle.ts): the next scene, of the same terrain, built again (what
   * follows the heights: the grid, the copies, the water, the tokens' places, the shadows) with the
   * walls as the brush left them (see reheight), not worked out again.
   */
  settleNext() {
    this.settling = true;
  }

  /** Whether WebGL could start (without it there's nothing to draw the terrain with). */
  get ready(): boolean {
    return this.renderer !== null;
  }

  setScene(scene: VistazoScene) {
    const settling = this.settling;
    this.settling = false;
    this.scene = scene;
    this.u = VIEW_CELL / scene.dpi;
    const heights = scene.pieces.map((piece) => piece.height);
    this.minH = Math.min(0, ...heights);
    this.maxH = Math.max(0, ...heights);
    // The block reaches a level below the lowest ground, and below the deepest token, so a buried one is
    // inside it. Not by the lowest standing token: one dragged up off the ground would build it all again.
    const base = Math.min(this.minH - 1, ...scene.tokens.map((t) => t.terrain + t.own - 1));
    if (scene.terrainKey === this.terrainKey && base === this.base && !settling) {
      // Only tokens moved (a drag): put them where they are now, without building them again.
      if (!time("3d.moveTokens", () => this.moveTokens(scene))) {
        time("3d.tokens", () => this.buildTokens());
      }
      this.updateWeather();
      this.requestApply();
      return;
    }
    const sameBase = base === this.base;
    this.terrainKey = scene.terrainKey;
    this.base = base;
    time("3d.grid", () => this.computeGrid());
    if (!settling || !sameBase) {
      this.walls = time("3d.walls.compute", () => computeWalls(scene, base));
    }
    time("3d.build", () => this.build());
    time("3d.colors", () => this.loadColors());
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
    if (this.lite) {
      return;
    }
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
    if (this.lite) {
      return;
    }
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

  /**
   * Where a stage point's ray meets a level `height` (grid units) up: what
   * a drag follows, so the cursor passing over something tall (a column)
   * doesn't make what's dragged jump onto it and back.
   */
  pickPlane(x: number, y: number, height: number): Camera["focus"] {
    if (!this.scene || this.width === 0) {
      return null;
    }
    const inverse = this.camMatrix().inverse();
    const eye = inverse.transformPoint(new DOMPoint(0, 0, this.persp));
    const through = inverse.transformPoint(new DOMPoint(x - this.width / 2, y - this.height / 2, 0));
    const dz = through.z - eye.z;
    const t = Math.abs(dz) < 1e-6 ? -1 : (height * this.k - eye.z) / dz;
    if (t <= 0) {
      return null;
    }
    return { x: (eye.x + (through.x - eye.x) * t) / this.u, y: (eye.y + (through.y - eye.y) * t) / this.u, z: height };
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
    const token = this.scene?.tokens.find((t) => t.id === id) ?? this.scene?.props.find((p) => p.id === id);
    return token ? { x: token.x, y: token.y, z: token.terrain + token.own } : null;
  }

  /** How the props are drawn: lying flat, standing, or not at all (their checkbox off). */
  private get propsMode(): Options["props"] {
    return this.options.showProps ? this.options.props : "none";
  }

  /**
   * The free point measured from (a click on empty ground), at a height
   * (grid units), or none: a marker there, the lines' and rings' origin
   * as a token's would be (see main.ts).
   */
  setPoint(point: { x: number; y: number; height: number } | null) {
    this.pointAt = point;
    this.placePoint();
    this.requestApply();
  }

  private placePoint() {
    if (this.point) {
      this.point.el.remove();
      for (const mesh of this.point.marks?.ring ? [this.point.marks.ring] : []) {
        this.tokenGroup.remove(mesh);
        mesh.geometry.dispose();
      }
      const stem = this.point.marks?.stem;
      if (stem) {
        this.tokenGroup.remove(stem);
        stem.geometry.dispose();
      }
      this.point = null;
    }
    const at = this.pointAt;
    const scene = this.scene;
    if (!at || !scene) {
      return;
    }
    const u = this.u;
    const k = this.k;
    const el = document.createElement("div");
    el.className = "tok point";
    // Picked like a token (see tokenAt), to drag it.
    el.dataset.id = FREE_POINT;
    const disc = document.createElement("div");
    disc.className = "disc";
    const img = document.createElement("span");
    img.className = "pin";
    disc.append(img);
    el.append(disc);
    this.tokenOverlay.append(el);
    const floor = this.gridHeight(at.x, at.y);
    const ground = Number.isNaN(floor) ? 0 : floor;
    // A third of a cell across: there to see and grab, not a token's size.
    const token = { id: FREE_POINT, name: "", x: at.x, y: at.y, size: scene.dpi / 3, terrain: ground, own: at.height - ground, rotation: 0, flipX: false, flipY: false, hidden: false } as Token;
    // A ring on the ground under it, and a dashed line up to it when it's raised.
    const ring = new THREE.Mesh(new THREE.RingGeometry(scene.dpi * u * 0.14, scene.dpi * u * 0.19, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    ring.position.set(at.x * u, at.y * u, ground * k + 1);
    ring.renderOrder = 3;
    ring.userData.prop = true;
    this.tokenGroup.add(ring);
    let stem: THREE.Line | null = null;
    if (Math.abs(at.height - ground) > 1e-6) {
      stem = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(at.x * u, at.y * u, at.height * k), new THREE.Vector3(at.x * u, at.y * u, ground * k)]),
        new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 6, gapSize: 5, transparent: true, opacity: 0.9 })
      );
      stem.computeLineDistances();
      stem.userData.prop = true;
      this.tokenGroup.add(stem);
    }
    this.point = { token, el, disc, img, zTok: at.height * k, screen: { x: 0, y: 0 }, hidden: false, marks: { ring, stem } };
  }

  /** The topmost prop lying flat under a stage point (a standing one is picked by its element, see tokenAt). */
  propAt(x: number, y: number): string | null {
    if (!this.scene || this.propsMode !== "flat") {
      return null;
    }
    const camM = this.camMatrix();
    const u = this.u;
    for (const view of [...this.tokenViews].reverse()) {
      if (!view.prop?.flat) {
        continue;
      }
      const z = view.zTok;
      const ring = view.prop.data.corners.map(([cx, cy]) => {
        const p = camM.transformPoint(new DOMPoint(cx * u, cy * u, z));
        const f = this.persp / Math.max(1, this.persp - p.z);
        return [this.width / 2 + p.x * f, this.height / 2 + p.y * f];
      });
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      if (inside) {
        return view.prop.data.id;
      }
    }
    return null;
  }

  setOptions(options: Partial<Options>) {
    const changed = (keys: (keyof Options)[]) => keys.some((key) => key in options && options[key] !== this.options[key]);
    const rebuild = changed(["heightScale", "shade", "levels", "relief", "tint", "wallStyle", "rings", "ringFill"]);
    const regrid = changed(["grid"]);
    const relabel = changed(["tokenLabels", "props", "showProps", "propShadows", "propLines", "propLabels"]);
    const reweather = changed(["weather", "clouds", "waterMotion", "quality"]);
    const resharpen = changed(["quality"]);
    this.options = { ...this.options, ...options };
    if (resharpen) {
      this.sharpen();
    }
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
      if (reweather) {
        this.updateWeather();
        // The water's motion turned on: the frames start even when the weather itself didn't change.
        this.playWeather();
      }
      this.measure();
    }
  }

  // ---------- Geometry ----------

  /** Heights on a grid of a fifth of a cell, for the rays (NaN outside the map). */
  private computeGrid() {
    const scene = this.scene!;
    const { x0, y0, x1, y1 } = scene.bounds;
    // A fifth of a cell; coarser on a very big map, so it's never more than MAX_GRID_POINTS points (what
    // it's for, hiding tokens and the lines' sight, doesn't need more).
    const step = Math.max(scene.dpi / 5, Math.sqrt(((x1 - x0) * (y1 - y0)) / MAX_GRID_POINTS));
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

  /** Whether a token at a scene point stands on the terrain itself (not a slab's top, nor in the air): its base painted on it. */
  private onTerrain(x: number, y: number, zFloor: number): boolean {
    const h = this.scene?.heightAt(x, y);
    return h !== undefined && Math.abs(h * this.k - zFloor) <= 0.1 * this.k;
  }

  /**
   * The bases of the tokens (and props) on the terrain, painted on it as the Banda rings are: on a picture
   * of the scene laid on copies of the terrain's tops (see baseCopy), so each follows the ground under
   * it, bumps and all. Painted again as they move, nothing built again.
   */
  private paintBases() {
    const scene = this.scene;
    if (!scene) {
      return;
    }
    const { x0, y0, x1, y1 } = scene.bounds;
    const [w, h] = [x1 - x0 || 1, y1 - y0 || 1];
    const scale = Math.min(BASES_PER_CELL / scene.dpi, BASES_MAX / Math.max(w, h));
    const [cw, ch] = [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
    if (!this.baseCanvas) {
      this.baseCanvas = document.createElement("canvas");
    }
    const canvas = this.baseCanvas;
    if (canvas.width !== cw || canvas.height !== ch) {
      [canvas.width, canvas.height] = [cw, ch];
      this.baseTexture?.dispose();
      this.baseTexture = null;
    }
    const c = canvas.getContext("2d")!;
    c.clearRect(0, 0, cw, ch);
    for (const view of this.tokenViews) {
      const base = view.painted;
      if (!base) {
        continue;
      }
      const [cx, cy, r] = [(base.x - x0) * scale, (base.y - y0) * scale, base.r * scale];
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fillStyle = "rgba(0,0,0,0.35)";
      c.fill();
      if (base.ring) {
        // As thick as a flat base's ring (2 view units).
        c.lineWidth = Math.max(1, (2 / this.u) * scale);
        c.beginPath();
        c.arc(cx, cy, r - c.lineWidth / 2, 0, Math.PI * 2);
        c.strokeStyle = "rgba(255,255,255,0.85)";
        c.stroke();
      }
    }
    if (!this.baseTexture) {
      this.baseTexture = new THREE.CanvasTexture(canvas);
      // Every copy's, every build's: not let go with one (see isShared).
      this.baseTexture.userData.shared = true;
      for (const copy of this.baseGroup.children as THREE.Mesh[]) {
        (copy.material as THREE.MeshBasicMaterial).map = this.baseTexture;
        (copy.material as THREE.MeshBasicMaterial).needsUpdate = true;
      }
    }
    this.baseTexture.needsUpdate = true;
    this.basesMoved = false;
    this.requestApply();
  }

  /** A copy of a terrain top for the painted bases (as fogCopy is for the fog): the scene's picture of them laid from above. */
  private baseCopy(geometry: THREE.BufferGeometry, z: number) {
    if (this.lite) {
      return;
    }
    const { x0, y0, x1, y1 } = this.scene!.bounds;
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
      new THREE.MeshBasicMaterial({ map: this.baseTexture, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    );
    mesh.position.z = z;
    mesh.renderOrder = 3;
    this.baseGroup.add(mesh);
  }

  /** The heights grid within a region (scene px) worked out again. */
  private regridIn(region: Region) {
    const scene = this.scene!;
    const { x0, y0, step, w, h, cells } = this.grid;
    const i0 = Math.max(0, Math.floor((region.x0 - x0) / step));
    const i1 = Math.min(w - 1, Math.ceil((region.x1 - x0) / step));
    const j0 = Math.max(0, Math.floor((region.y0 - y0) / step));
    const j1 = Math.min(h - 1, Math.ceil((region.y1 - y0) / step));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        cells[j * w + i] = scene.heightAt(x0 + i * step, y0 + j * step) ?? NaN;
      }
    }
  }

  /**
   * The relief editor's terrain brush, where it'd paint from here (its outline round the pointer on the
   * terrain, scene px; null: none), laid on the terrain as it is now.
   */
  setBrushRing(points: { x: number; y: number }[] | null) {
    const scene = this.scene;
    if (!points || !scene || points.length < 3) {
      if (this.brushRing) {
        this.world.remove(this.brushRing);
        this.brushRing.geometry.dispose();
        this.brushRing = null;
        this.requestApply();
      }
      return;
    }
    const u = this.u;
    const k = this.k;
    const lift = 0.05 * k;
    const positions = new Float32Array(points.length * 3);
    points.forEach((p, i) => positions.set([p.x * u, p.y * u, (scene.heightAt(p.x, p.y) ?? 0) * k + lift], i * 3));
    if (!this.brushRing) {
      // Over everything (a bump between the eye and it doesn't hide it), as the 2D map's own ring.
      const material = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });
      this.brushRing = new THREE.LineLoop(new THREE.BufferGeometry(), material);
      this.brushRing.renderOrder = 20;
      this.world.add(this.brushRing);
    }
    this.brushRing.geometry.dispose();
    this.brushRing.geometry = new THREE.BufferGeometry();
    this.brushRing.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.requestApply();
  }

  /** Height (grid units) at a scene point, NaN outside the map. */
  private gridHeight(x: number, y: number): number {
    const { x0, y0, step, w, h, cells } = this.grid;
    const i = Math.round((x - x0) / step);
    const j = Math.round((y - y0) / step);
    return i < 0 || j < 0 || i >= w || j >= h ? NaN : cells[j * w + i];
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
    this.dropMapTextures();
    if (scene.maps.length === 0) {
      return;
    }
    const { x0, y0, x1, y1 } = scene.bounds;
    const w = x1 - x0;
    const h = y1 - y0;
    const draw = (images: CanvasImageSource[], px: number) => {
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
          new Promise<CanvasImageSource>((resolve, reject) => {
            // A video map: its first frame (the texture is a still picture).
            if (map.video) {
              const video = mediaElement(map.url, true) as HTMLVideoElement;
              video.onloadeddata = () => {
                // Only its first frame is used: it needn't go on playing, unseen.
                video.pause();
                resolve(video);
              };
              video.onerror = reject;
              return;
            }
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
    this.dropMapTextures();
    const anisotropy = this.renderer?.capabilities.getMaxAnisotropy() ?? 1;
    const map = new THREE.CanvasTexture(source);
    map.anisotropy = anisotropy;
    this.mapTexture = map;
    if (source === texture.canvas) {
      this.plainTexture = map;
    } else {
      this.plainTexture = new THREE.CanvasTexture(texture.canvas);
      this.plainTexture.anisotropy = anisotropy;
    }
    for (const material of this.pieceMaterials) {
      if (material.userData.mapTextured) {
        material.map = material.userData.mapTextured === "plain" ? this.plainTexture : map;
        material.needsUpdate = true;
      }
    }
    this.render();
  }

  /** The map's textures let go (both, if the grid made them two). */
  private dropMapTextures() {
    if (this.plainTexture && this.plainTexture !== this.mapTexture) {
      this.plainTexture.dispose();
    }
    this.mapTexture?.dispose();
    this.mapTexture = null;
    this.plainTexture = null;
  }

  // ---------- Building the 3D scene ----------

  private clear(group: THREE.Group) {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        // A batch's instances (see BaseBatch) are its own buffer, let go with it.
        if ((object as THREE.InstancedMesh).isInstancedMesh) {
          (object as THREE.InstancedMesh).dispose();
        }
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(material) ? material : material ? [material] : []).forEach((m) => {
          // The map texture and the patterns are shared: only a prop's own is let go.
          const own = (m as THREE.MeshBasicMaterial).map;
          if (own && own !== this.mapTexture && own !== this.plainTexture && !isShared(own)) {
            own.dispose();
          }
          m.dispose();
        });
      });
    }
  }

  /**
   * A surface that isn't flat: its outline's triangles cut small, to half a
   * cell (the painted ground's own step), however big it is.
   */
  private fineGeometry(piece: Piece): THREE.BufferGeometry {
    // Cut once for an outline: the same one again (only its heights changed, a brush let go) takes the
    // same triangles, its heights set by the caller.
    const key = `${this.u}|${JSON.stringify(piece.shape)}`;
    let kept = this.fineCache.get(key);
    if (!kept) {
      const target = VIEW_CELL / 2;
      const flat = this.shapeGeometry(piece.shape);
      flat.computeBoundingBox();
      const box = flat.boundingBox!;
      const span = Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y);
      // Each pass cuts every triangle in two across its longest side (two passes halve them all): as many
      // as it takes to get them down to the target.
      const passes = Math.max(1, Math.min(28, 2 * Math.ceil(Math.log2(Math.max(1, span / target))) + 2));
      const cut = new TessellateModifier(target, passes).modify(flat.toNonIndexed());
      // Each corner once (the cut repeats it for every triangle round it, about six): its height is
      // then worked out once, not for each of them.
      const from = (cut.getAttribute("position") as THREE.BufferAttribute).array;
      const seen = new Map<number, number>();
      const corners: number[] = [];
      const index = new Uint32Array(from.length / 3);
      for (let i = 0; i < index.length; i++) {
        const x = from[i * 3];
        const y = from[i * 3 + 1];
        // To a thousandth of a view unit, as one number (both well under 2^26 thousandths).
        const at = Math.round(x * 1e3) * 2 ** 27 + Math.round(y * 1e3);
        let n = seen.get(at);
        if (n === undefined) {
          n = corners.length / 3;
          seen.set(at, n);
          corners.push(x, y, 0);
        }
        index[i] = n;
      }
      kept = { position: Float32Array.from(corners), index, used: 0 };
      cut.dispose();
      flat.dispose();
      this.fineCache.set(key, kept);
    }
    kept.used = this.builds;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(kept.position.slice(), 3));
    // Never changed: shared by every copy of it.
    geometry.setIndex(new THREE.BufferAttribute(kept.index, 1));
    return geometry;
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
   * The walls (all of them, or those given): a mesh each style, inside (in
   * the terrain, or `into`) and at the map's edge (which can be hidden),
   * shaded top to bottom and by the light, their faces as the wall style
   * has them (their zone's, or the Vistazo's), and level lines at every
   * whole cell of height.
   */
  private buildWalls(list: Wall[] = this.walls, into: THREE.Group | null = null) {
    const u = this.u;
    const k = this.k;
    // The fold's strip: how far into the map it reaches, in view units.
    const band = VIEW_CELL * 0.75;
    // One mesh for each style, inside and at the map's edge (which can be hidden).
    // A wall with a picture from the map's rectangle goes in its own mesh ("skin"), textured with the map.
    const styleOf = (wall: Wall): WallStyle | "skin" => (wall.skin && this.texture ? "skin" : (wall.style ?? this.options.wallStyle));
    const styles = new Set(list.map(styleOf));
    for (const [edge, style] of [false, true].flatMap((e) => [...styles].map((st) => [e, st] as const))) {
      const walls = list.filter((wall) => wall.edge === edge && styleOf(wall) === style);
      if (walls.length === 0) {
        continue;
      }
      const fromMap = (style === "stretch" || style === "fold" || style === "skin") && this.texture !== null;
      const pattern = style === "stone" || style === "rubble" || style === "earth" || style === "wood" ? patternTexture(style) : null;
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
        // Where its picture is: into the raised piece from the edge (the wall's normal points out,
        // to the lower side); a sunken zone's walls (a pit, a ravine: not above the ground) are drawn
        // on the map inside the hollow, on that lower side.
        const sunken = Math.max(wall.t0, wall.t1) <= 1e-6;
        const [ix, iy] = sunken ? [wall.nx, wall.ny] : [-wall.nx, -wall.ny];
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
        if (style === "skin" && wall.skin) {
          // The rectangle's picture: across it by where round the zone each end is, up it by height.
          const across = (x: number, y: number) => skinAcross(wall.skin!, x / u, y / u);
          const [sa, sb] = [across(ax, ay), across(bx, by)];
          const lowest = Math.min(zb0, zb1);
          const span = Math.max(zt0, zt1) - lowest || 1;
          const at = (s: number, z: number) => {
            const [x, y] = skinPoint(wall.skin!, s, (z - lowest) / span);
            return this.uvAt(x * u, y * u);
          };
          positions.push(ax, ay, zt0, bx, by, zt1, bx, by, zb1, ax, ay, zt0, bx, by, zb1, ax, ay, zb0);
          colors.push(...top, ...top, ...bottom, ...top, ...bottom, ...bottom);
          const [a0, b0, b1, a1] = [at(sa, zt0), at(sb, zt1), at(sb, zb1), at(sa, zb0)];
          uvs.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
        } else if (slanted) {
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
      const group = into ?? (edge ? this.edgeGroup : this.terrainGroup);
      const material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        map: fromMap ? this.plainTexture : pattern,
      });
      material.userData.color = new THREE.Color(1, 1, 1);
      material.userData.mapTextured = fromMap ? "plain" : false;
      this.pieceMaterials.push(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.wall = true;
      group.add(mesh);
      // The fog covers walls too (a wall would give the hidden terrain away); the map edge's, with them (shown or not).
      this.fogCopy(geometry, 0, edge ? this.edgeGroup : this.fogGroup);
      if (levels.length > 0) {
        const lines = new THREE.BufferGeometry();
        lines.setAttribute("position", new THREE.BufferAttribute(new Float32Array(levels), 3));
        const levelLines = new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }));
        levelLines.userData.wall = true;
        group.add(levelLines);
      }
    }
  }

  /** A soft shadow on the ground at the foot of each wall (all of them, or those given), fading out from it. */
  private buildWallShadows(list: Wall[] = this.walls) {
    const scene = this.scene!;
    const u = this.u;
    const k = this.k;
    if (this.options.relief > 0) {
      const inside = list.filter((wall) => !wall.edge);
      const positions = new Float32Array(inside.length * 18);
      const colors = new Float32Array(inside.length * 24);
      const reach = VIEW_CELL * 0.45;
      const dark = 0.45 * this.options.relief;
      // Each end goes out along the walls' normals there, averaged with the next wall's: the shadows of
      // a wall's pieces meet at their ends (out along each piece's own normal, a curve's left wedges between).
      const key = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
      const normals = new Map<string, [number, number]>();
      for (const wall of inside) {
        for (const [x, y] of [[wall.ax, wall.ay], [wall.bx, wall.by]]) {
          const sum = normals.get(key(x, y)) ?? [0, 0];
          normals.set(key(x, y), [sum[0] + wall.nx, sum[1] + wall.ny]);
        }
      }
      const out = (x: number, y: number, wall: (typeof inside)[number]): [number, number] => {
        const [sx, sy] = normals.get(key(x, y)) ?? [wall.nx, wall.ny];
        const length = Math.hypot(sx, sy);
        // Walls facing apart (a thin wall's two sides): its own way.
        return length < 0.5 ? [wall.nx, wall.ny] : [sx / length, sy / length];
      };
      inside.forEach((wall, i) => {
        const [ax, ay, bx, by] = [wall.ax * u, wall.ay * u, wall.bx * u, wall.by * u];
        const [nax, nay] = out(wall.ax, wall.ay, wall);
        const [nbx, nby] = out(wall.bx, wall.by, wall);
        const [cx, cy, dx, dy] = [ax + nax * reach, ay + nay * reach, bx + nbx * reach, by + nby * reach];
        const za = wall.b0 * k + 0.4;
        const zb = wall.b1 * k + 0.4;
        // Its far edge down on the ground there where that falls away (a slope: level with the
        // wall's foot it would hang in the air), but never up: by a corner its far edge lands on the next
        // wall's top, and climbing to it, it would cut through that wall.
        const zc = Math.min(wall.b0, scene.heightAt(cx / u, cy / u) ?? wall.b0) * k + 0.4;
        const zd = Math.min(wall.b1, scene.heightAt(dx / u, dy / u) ?? wall.b1) * k + 0.4;
        positions.set([ax, ay, za, bx, by, zb, dx, dy, zd, ax, ay, za, dx, dy, zd, cx, cy, zc], i * 18);
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
        shadows.userData.wall = true;
        this.terrainGroup.add(shadows);
      }
    }
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
    // The cut outlines not used by the last two builds: let go.
    this.builds++;
    for (const [key, kept] of this.fineCache) {
      if (kept.used < this.builds - 2) {
        this.fineCache.delete(key);
      }
    }
    this.clear(this.terrainGroup);
    this.clear(this.movingGroup);
    this.clear(this.underGroup);
    for (const child of [...this.pickGroup.children]) {
      this.pickGroup.remove(child);
      ((child as THREE.Mesh).material as THREE.Material).dispose();
    }
    this.movingKey = "";
    this.movingGroup.matrix.identity();
    this.clear(this.edgeGroup);
    this.clear(this.fillGroup);
    this.clear(this.baseGroup);
    this.reachTexture?.dispose();
    this.reachTexture = null;
    this.clear(this.fogGroup);
    this.pieceMaterials = [];
    this.k = VIEW_CELL * this.options.heightScale;

    // Each one's meshes marked with the relief shape it's of (for moving it whole).
    const mark = (from: number, si: number | undefined) => {
      for (const child of this.terrainGroup.children.slice(from)) {
        child.userData.si = si;
      }
    };
    time("3d.build.pieces", () => {
      for (const piece of scene.pieces) {
        const from = this.terrainGroup.children.length;
        this.buildPiece(piece);
        mark(from, piece.si);
      }
    });
    time("3d.build.bridges", () => {
      for (const bridge of scene.bridges) {
        const from = this.terrainGroup.children.length;
        this.buildBridge(bridge);
        mark(from, bridge.si);
      }
    });
    time("3d.build.slabs", () => this.computeSlabs());
    time("3d.build.water", () => this.buildWater());
    // Their heights follow the height scale.
    time("3d.build.templates", () => this.buildTemplates());

    time("3d.build.walls", () => this.buildWalls());

    // Not while something's being dragged (drawn lightly): the shadows at the walls' feet come back as it's let go.
    if (!this.lite) {
      time("3d.build.wallShadows", () => this.buildWallShadows());
    }
    this.fogTexture?.dispose();
    this.fogTexture = null;
    time("3d.build.fog", () => this.drawFog());
    time("3d.build.underBridges", () => this.buildUnderBridges());
    time("3d.build.tokens", () => this.buildTokens());
    time("3d.build.reach", () => this.buildReach());
    // The terrain's built again: so are the cloud shadows on it.
    this.weatherKey = "";
    time("3d.build.weather", () => this.updateWeather());
    this.highlight(this.picked.shapes);
    // Its size (it reads the page's layout, which costs): not while something's being dragged, it hasn't changed.
    if (!this.lite) {
      time("3d.measure", () => this.measure());
    }
  }

  /**
   * What the map paints under a bridge is the bridge itself (seen from
   * above): on the ground and walls below it, inside its box, the map from
   * just past its long sides instead, mirrored across them, as if the map
   * went on under it. Drawn on the terrain's surfaces there (see copiesIn).
   */
  private buildUnderBridges() {
    // Each bridge's surfaces are its own (merged from the copies: see copiesIn).
    this.clear(this.underBridgeGroup);
    const scene = this.scene;
    const texture = this.texture;
    if (!scene || !texture || !this.mapTexture) {
      return;
    }
    for (const bridge of scene.bridges) {
      const { center, along, across, halfAlong, halfAcross } = bridge.frame;
      const material = new THREE.ShaderMaterial({
        vertexShader: UNDER_VERTEX,
        fragmentShader: UNDER_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        uniforms: {
          uMap: { value: this.mapTexture },
          uU: { value: this.u },
          uTex: { value: new THREE.Vector4(texture.x0, texture.y0, texture.w, texture.h) },
          uFrame: { value: new THREE.Vector4(center.x, center.y, along.x, along.y) },
          uAcross: { value: new THREE.Vector4(across.x, across.y, halfAlong, halfAcross) },
          uBelow: { value: bridge.bottom * this.k },
        },
      });
      // Only the terrain under its box, as one mesh (one draw, not one for every piece of the map).
      const u = this.u;
      const corners = [-1, 1].flatMap((a) => [-1, 1].map((b) => ({ x: center.x + along.x * halfAlong * a + across.x * halfAcross * b, y: center.y + along.y * halfAlong * a + across.y * halfAcross * b })));
      const box = { x0: Math.min(...corners.map((c) => c.x)) * u, y0: Math.min(...corners.map((c) => c.y)) * u, x1: Math.max(...corners.map((c) => c.x)) * u, y1: Math.max(...corners.map((c) => c.y)) * u };
      const surfaces = this.copiesIn(box);
      if (!surfaces) {
        material.dispose();
        continue;
      }
      const under = new THREE.Mesh(surfaces, material);
      under.renderOrder = 1;
      under.frustumCulled = false;
      this.underBridgeGroup.add(under);
    }
  }

  /**
   * The terrain's surfaces (its fog copies: ground, tops, walls) within a box
   * (view units; all of them with none), as one geometry: positions only,
   * each copy's own offset in them. For what's drawn over the terrain itself
   * (cloud shadows, a bridge's fill), in one draw.
   */
  private copiesIn(box: { x0: number; y0: number; x1: number; y1: number } | null): THREE.BufferGeometry | null {
    const parts: THREE.BufferGeometry[] = [];
    for (const copy of this.fogGroup.children as THREE.Mesh[]) {
      const geometry = copy.geometry;
      if (!geometry.boundingBox) {
        geometry.computeBoundingBox();
      }
      const bounds = geometry.boundingBox!;
      if (box && (bounds.max.x < box.x0 || bounds.min.x > box.x1 || bounds.max.y < box.y0 || bounds.min.y > box.y1)) {
        continue;
      }
      const flat = geometry.index ? geometry.toNonIndexed() : null;
      const part = new THREE.BufferGeometry();
      part.setAttribute("position", (flat ?? geometry).getAttribute("position").clone());
      part.translate(copy.position.x, copy.position.y, copy.position.z);
      parts.push(part);
      flat?.dispose();
    }
    if (parts.length === 0) {
      return null;
    }
    const merged = mergeGeometries(parts);
    for (const part of parts) {
      part.dispose();
    }
    return merged;
  }

  /**
   * A bridge or balcony: a slab floating over the ground, its top the map
   * (as any terrain's), its underside and sides its wall style's pattern
   * (stone if it takes its walls from the map: the map there shows its top),
   * tinted with the map's colour there.
   */
  private buildBridge(bridge: Bridge) {
    const u = this.u;
    const k = this.k;
    const top = this.shapeGeometry(bridge.shape);
    const position = top.getAttribute("position") as THREE.BufferAttribute;
    top.setAttribute("uv", new THREE.BufferAttribute(this.uvs(position.array, position.count), 2));
    const deck = new THREE.Mesh(top, this.pieceMaterial(bridge.top, true));
    deck.position.z = bridge.top * k;
    this.terrainGroup.add(deck);
    this.fillCopy(top, bridge.top * k);
    this.fogCopy(top, bridge.top * k);
    this.baseCopy(top, bridge.top * k);

    const style = bridge.walls ?? this.options.wallStyle;
    const kind = style === "rubble" || style === "earth" || style === "wood" ? style : "stone";
    // With a picture from a rectangle of the map: the map, there, on its underside and sides.
    const skin = bridge.skin && this.mapTexture ? bridge.skin : undefined;
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const polygon of bridge.shape) {
      for (const [x, y] of polygon[0]) {
        cx += x;
        cy += y;
        n++;
      }
    }
    const rgb = this.colors ? this.colors(cx / n, cy / n) : STONE;
    const tint = (shade: number) => new THREE.Color(...(rgb.map((v) => (v / 255) * shade) as [number, number, number]));
    const tile = VIEW_CELL * 2;

    // Its underside, a little darker (in its own shadow).
    const under = this.shapeGeometry(bridge.shape);
    const underPosition = under.getAttribute("position") as THREE.BufferAttribute;
    const underUv = new Float32Array(underPosition.count * 2);
    for (let i = 0; i < underPosition.count; i++) {
      underUv[i * 2] = underPosition.getX(i) / tile;
      underUv[i * 2 + 1] = underPosition.getY(i) / tile;
    }
    if (skin) {
      // The rectangle laid over the slab's box: across it along one side, up it along the other.
      const xs = bridge.shape.flatMap((polygon) => polygon[0].map((p) => p[0]));
      const ys = bridge.shape.flatMap((polygon) => polygon[0].map((p) => p[1]));
      const [bx0, bx1, by0, by1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      for (let i = 0; i < underPosition.count; i++) {
        const [x, y] = skinPoint(skin, (underPosition.getX(i) / u - bx0) / (bx1 - bx0 || 1), (underPosition.getY(i) / u - by0) / (by1 - by0 || 1));
        const [su, sv] = this.uvAt(x * u, y * u);
        underUv[i * 2] = su;
        underUv[i * 2 + 1] = sv;
      }
    }
    under.setAttribute("uv", new THREE.BufferAttribute(underUv, 2));
    const belly = new THREE.Mesh(
      under,
      new THREE.MeshBasicMaterial({ map: skin ? this.mapTexture : patternTexture(kind), color: skin ? new THREE.Color(0.6, 0.6, 0.6) : tint(0.6), side: THREE.DoubleSide })
    );
    belly.position.z = bridge.bottom * k;
    this.terrainGroup.add(belly);

    // Its sides, from its underside up to its top, the pattern running along them.
    const positions: number[] = [];
    const uvs: number[] = [];
    const z0 = bridge.bottom * k;
    const z1 = bridge.top * k;
    for (const polygon of bridge.shape) {
      const ring = polygon[0];
      let along = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const [ax, ay] = [ring[i][0] * u, ring[i][1] * u];
        const [bx, by] = [ring[i + 1][0] * u, ring[i + 1][1] * u];
        const length = Math.hypot(bx - ax, by - ay);
        positions.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z0, bx, by, z1, ax, ay, z1);
        if (skin) {
          const [sa, sb] = [skinAcross(skin, ax / u, ay / u), skinAcross(skin, bx / u, by / u)];
          const at = (s: number, v: number) => {
            const [x, y] = skinPoint(skin, s, v);
            return this.uvAt(x * u, y * u);
          };
          const [a0, b0, b1, a1] = [at(sa, 0), at(sb, 0), at(sb, 1), at(sa, 1)];
          uvs.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
        } else {
          const [ua, ub] = [along / tile, (along + length) / tile];
          uvs.push(ua, z0 / tile, ub, z0 / tile, ub, z1 / tile, ua, z0 / tile, ub, z1 / tile, ua, z1 / tile);
        }
        along += length;
      }
    }
    const sides = new THREE.BufferGeometry();
    sides.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    sides.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
    this.terrainGroup.add(
      new THREE.Mesh(sides, new THREE.MeshBasicMaterial({ map: skin ? this.plainTexture : patternTexture(kind), color: skin ? new THREE.Color(0.85, 0.85, 0.85) : tint(0.85), side: THREE.DoubleSide }))
    );
  }

  private buildPiece(piece: Piece) {
    const u = this.u;
    const k = this.k;
    const z = piece.height * k;
    const fine = !!piece.surface && !(piece.coarse && !piece.fine?.());
    const geometry = fine ? this.fineGeometry(piece) : this.shapeGeometry(piece.shape);
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    if (!piece.stand) {
      geometry.setAttribute("uv", new THREE.BufferAttribute(this.uvs(position.array, position.count), 2));
      const mesh = new THREE.Mesh(geometry, this.pieceMaterial(piece.height, true));
      if (piece.surface) {
        // A ramp: each corner at its own height (a plane: the triangles stay flat).
        for (let i = 0; i < position.count; i++) {
          position.setZ(i, pieceHeight(piece, position.getX(i) / u, position.getY(i) / u) * k);
        }
        position.needsUpdate = true;
      } else {
        mesh.position.z = z;
      }
      // Its corners can be moved up or down where they are (see reheight).
      mesh.userData.piece = piece;
      mesh.userData.fine = fine;
      this.terrainGroup.add(mesh);
      this.fillCopy(geometry, piece.surface ? 0 : z);
      this.fogCopy(geometry, piece.surface ? 0 : z);
      this.baseCopy(geometry, piece.surface ? 0 : z);
      return;
    }
    // Standing: a block (its top plain stone, its sides walls) with the
    // relief's picture of it in front (its card).
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
    const roof = style === "earth" || style === "wood" || style === "rubble" ? style : "stone";
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
    this.baseCopy(geometry, z);

    if (piece.card) {
      // A relief's own picture (see relief/vistazo.ts): its corners where it has them, its picture from the map.
      const positions = new Float32Array(piece.card.length * 3);
      const uvs = new Float32Array(piece.card.length * 2);
      piece.card.forEach(([x, y, h, mx, my], i) => {
        positions.set([x * u, y * u, h * k], i * 3);
        uvs.set(this.texture ? this.uvAt(mx * u, my * u) : [0, 0], i * 2);
      });
      const card = new THREE.BufferGeometry();
      card.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      card.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      // Just in front of its walls (they're all kept): drawn toward the eye, not away as the pieces' are
      // (that offset grows with how slanting a face is seen, and put the wall over the picture there).
      const material = this.pieceMaterial(piece.height, true);
      // Its picture without the ground's grid (it's stood up: the cells would show crooked on it).
      material.map = this.plainTexture;
      material.userData.mapTextured = "plain";
      material.polygonOffsetFactor = -1;
      material.polygonOffsetUnits = -1;
      const cardMesh = new THREE.Mesh(card, material);
      // Where on the map each corner's picture is (view units), for it to follow a drag (see moveShapes).
      cardMesh.userData.cardMap = Float32Array.from(piece.card.flatMap(([, , , mx, my]) => [mx * u, my * u, 0]));
      this.terrainGroup.add(cardMesh);
      this.fogCopy(card);
    }
  }

  private buildTokens() {
    const scene = this.scene;
    if (!scene) {
      return;
    }
    this.clear(this.tokenGroup);
    this.videoTextures.clear();
    const u = this.u;
    const k = this.k;
    const overlay = document.createDocumentFragment();
    const ring = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
    const fill = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
    const dashes = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 6, gapSize: 5, transparent: true, opacity: 0.9 });
    const stemOf = (at: { x: number; y: number }, zTok: number, zFloor: number) => {
      const stem = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(at.x * u, at.y * u, zTok), new THREE.Vector3(at.x * u, at.y * u, zFloor)]),
        dashes
      );
      stem.computeLineDistances();
      return stem;
    };

    // The bases drawn together (see BaseBatch): the props' (a disc), then the tokens' (a disc and a ring).
    const propBases = new BaseBatch(false);
    const tokenBases = new BaseBatch(true);

    // Props first, so a token is drawn over a prop where they meet.
    const propViews: TokenView[] = [];
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    const shown = this.propsMode;
    const { propShadows, propLines, propLabels } = this.options;
    for (const prop of shown === "none" ? [] : scene.props) {
      const flat = shown === "flat";
      const zFloor = prop.terrain * k;
      const zTok = (prop.terrain + prop.own) * k;
      const el = document.createElement("div");
      el.className = "tok prop" + (flat ? " flat" : "") + (propShadows ? "" : " noshadow") + (prop.own < 0 ? " buried" : "");
      el.dataset.id = prop.id;
      const disc = document.createElement("div");
      disc.className = "disc";
      let img: HTMLElement;
      let mesh: THREE.Mesh | null = null;
      let shadow: THREE.Mesh | null = null;
      let seat: BaseSeat | undefined;
      let painted: TokenView["painted"];
      if (flat) {
        // Its picture lying on the ground, where the map has it (and, raised, its shadow on the ground under it).
        img = document.createElement("span");
        const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 });
        const dark = propShadows && prop.own > 0 ? new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 }) : null;
        const show = (texture: THREE.Texture) => {
          material.map = texture;
          material.opacity = 1;
          material.needsUpdate = true;
          if (dark) {
            dark.map = texture;
            dark.opacity = 0.4;
            dark.needsUpdate = true;
          }
          this.requestApply();
        };
        if (prop.video) {
          // Playing on the ground, as on the map.
          const video = mediaElement(prop.url, true) as HTMLVideoElement;
          video.onloadeddata = () => {
            const texture = new THREE.VideoTexture(video);
            show(texture);
            this.videoTextures.add(texture);
            this.watchVideo(texture);
            if (this.paused) {
              video.pause();
            }
          };
        } else {
          loader.load(prop.url, show);
        }
        mesh = new THREE.Mesh(this.propQuad(prop, zTok + 0.6), material);
        mesh.renderOrder = 2;
        mesh.userData.prop = true;
        this.tokenGroup.add(mesh);
        if (dark) {
          shadow = new THREE.Mesh(this.propQuad(prop, zFloor + 0.4), dark);
          shadow.renderOrder = 1;
          shadow.userData.prop = true;
          this.tokenGroup.add(shadow);
        }
      } else {
        img = mediaElement(prop.url, prop.video);
        disc.append(img);
        if (propShadows) {
          // A dark base on the ground under it, as a token's.
          // As big as its footprint (80% of it, as a token's).
          if (this.onTerrain(prop.x, prop.y, zFloor)) {
            painted = { x: prop.x, y: prop.y, r: prop.radius * 0.8, ring: false };
          } else {
            seat = propBases.add(prop.radius * u * 0.8, prop.x * u, prop.y * u, zFloor + 1);
          }
        }
      }
      let stem: THREE.Line | null = null;
      if (propLines && prop.own !== 0) {
        stem = stemOf(prop, zTok, zFloor);
        stem.userData.prop = true;
        this.tokenGroup.add(stem);
      }
      let title: HTMLElement | undefined;
      let detail: HTMLElement | undefined;
      if (propLabels) {
        const label = document.createElement("div");
        label.className = "lbl";
        title = document.createElement("span");
        label.append(title);
        if (this.options.tokenLabels === "full") {
          detail = document.createElement("small");
          label.append(detail);
        }
        disc.prepend(label);
      }
      el.appendChild(disc);
      overlay.appendChild(el);
      const view: TokenView = {
        token: propToken(prop),
        el,
        disc,
        img,
        zTok,
        screen: { x: 0, y: 0 },
        hidden: false,
        marks: { ring: null, stem },
        seat,
        painted,
        title,
        detail,
        prop: { data: prop, flat, mesh, shadow },
      };
      this.writeLabel(view);
      propViews.push(view);
    }

    this.tokenViews = scene.tokens.map((token) => {
      const zFloor = floorOf(token) * k;
      const zTok = (token.terrain + token.own) * k;
      // Its base as big as its footprint (80% of it): as it's measured, set by hand or from its image.
      const r = token.radius * u * 0.8;
      // Its base on the ground under it, and a dashed line up (or down) to it.
      // On the terrain: painted on it (see paintBases); off it (a slab's top, in the air): a flat one.
      const painted = this.onTerrain(token.x, token.y, zFloor) ? { x: token.x, y: token.y, r: token.radius * 0.8, ring: true } : undefined;
      const seat = painted ? undefined : tokenBases.add(r, token.x * u, token.y * u, zFloor + 1);
      let stem: THREE.Line | null = null;
      if (raised(token)) {
        stem = stemOf(token, zTok, zFloor);
        this.tokenGroup.add(stem);
      }
      const el = document.createElement("div");
      el.className = "tok" + (token.own < 0 ? " buried" : "") + (token.hidden ? " gmhidden" : "") + (this.selected.has(token.id) ? " selected" : "") + (this.affected.has(token.id) ? " affected" : "");
      el.dataset.id = token.id;
      const disc = document.createElement("div");
      disc.className = "disc";
      const img = mediaElement(token.url, token.video);
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
      const view: TokenView = { token, el, disc, img, zTok, screen: { x: 0, y: 0 }, hidden: false, marks: { ring: null, stem }, seat, painted, title, detail };
      this.writeLabel(view);
      return view;
    });
    this.tokenViews = [...propViews, ...this.tokenViews];
    propBases.build(this.tokenGroup, fill, ring, true);
    tokenBases.build(this.tokenGroup, fill, ring, false);
    this.paintBases();
    this.tokenOverlay.replaceChildren(overlay);
    // Drawn again with the tokens: the free point's marker and the templates' handles too.
    this.placePoint();
    this.placeHandles();
    this.drawnProps = propsKey(scene.props);
    // Drawn again while minimized: its new videos paused too.
    if (this.paused) {
      this.pauseVideos();
    }
  }

  /**
   * The view only draws when something changes; a video on the ground
   * changes with each of its frames, so it's drawn again on each new one
   * (only the picture: nothing else is worked out again), until it's gone.
   */
  private watchVideo(texture: THREE.VideoTexture) {
    const video = texture.image as HTMLVideoElement;
    const onFrame = () => {
      if (!this.videoTextures.has(texture)) {
        return;
      }
      this.requestRender();
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  /** The picture drawn again, once a frame at most however many videos ask. */
  private requestRender() {
    if (!this.videoFrame) {
      this.videoFrame = requestAnimationFrame(() => {
        this.videoFrame = 0;
        this.render();
      });
    }
  }

  /** Every video and the weather stopped (the panel minimized), or going again. */
  setPaused(paused: boolean) {
    this.paused = paused;
    this.pauseVideos();
    this.playWeather();
  }

  /** The weather's particles built again when what they depend on changed (the weather, the heights, the option). */
  private updateWeather() {
    const scene = this.scene;
    const weathers = scene && this.options.weather ? scene.weather : [];
    const key = JSON.stringify([weathers, this.u, this.k, this.minH, this.maxH, this.options.clouds, this.options.quality]);
    if (key === this.weatherKey) {
      return;
    }
    this.weatherKey = key;
    this.clear(this.weatherGroup);
    this.clear(this.cloudShadowGroup);
    if (scene && weathers.length > 0) {
      const frame = { u: this.u, cell: VIEW_CELL, k: this.k, lowest: this.minH, highest: this.maxH, amount: this.look.amount };
      for (const object of buildWeather(weathers, frame, scene.dpi, this.options.clouds)) {
        this.weatherGroup.add(object);
      }
      if (this.options.clouds === "shadows") {
        for (const weather of weathers.filter((w) => w.type === "CLOUD")) {
          const material = cloudShadowMaterial(weather, frame);
          // The terrain within its item's box, as one mesh (one draw).
          const u = this.u;
          const surfaces = this.copiesIn({ x0: weather.box.x0 * u, y0: weather.box.y0 * u, x1: weather.box.x1 * u, y1: weather.box.y1 * u });
          if (!surfaces) {
            material.dispose();
            continue;
          }
          const shadow = new THREE.Mesh(surfaces, material);
          // Under the fog (5), over the ground and its rings.
          shadow.renderOrder = 4;
          shadow.frustumCulled = false;
          this.cloudShadowGroup.add(shadow);
        }
      }
    }
    this.playWeather();
  }

  /** Whether there's weather to animate (particles, haze or cloud shadows). */
  private get hasWeather() {
    return (
      this.weatherGroup.children.length > 0 ||
      this.cloudShadowGroup.children.length > 0 ||
      (this.moving && this.templateGroup.children.length > 0) ||
      (this.moving && this.options.waterMotion && this.waterGroup.children.length > 0)
    );
  }

  /** The volume templates to draw (only in this view), moving with the weather's frames. */
  setTemplates(templates: Template[]) {
    this.templates = templates;
    this.buildTemplates();
    this.playWeather();
    this.requestApply();
  }

  private buildTemplates() {
    this.clear(this.templateGroup);
    if (!this.scene) {
      return;
    }
    for (const template of this.templates) {
      this.templateGroup.add(buildTemplate(template, this.u, VIEW_CELL, this.k));
    }
    this.placeHandles();
  }

  /**
   * Each template's handles, as markers on the overlay (picked like a
   * token: see tokenAt): its origin, to move it; a cone's or a line's tip
   * (at its length's end, a body's height up), to turn it.
   */
  private placeHandles() {
    for (const handle of this.handles) {
      handle.el.remove();
      for (const mesh of [handle.marks?.ring, handle.marks?.stem].filter((mark): mark is THREE.Mesh | THREE.Line => !!mark)) {
        this.tokenGroup.remove(mesh);
        (mesh as THREE.Mesh).geometry.dispose();
      }
    }
    this.handles = [];
    const scene = this.scene;
    if (!scene) {
      return;
    }
    const k = this.k;
    const make = (id: string, x: number, y: number, z: number, tip: boolean) => {
      const el = document.createElement("div");
      el.className = "tok point handle" + (tip ? " tip" : "");
      el.dataset.id = id;
      const disc = document.createElement("div");
      disc.className = "disc";
      const img = document.createElement("span");
      img.className = "pin";
      disc.append(img);
      el.append(disc);
      this.tokenOverlay.append(el);
      const token = { id, name: "", x, y, size: scene.dpi / 4, terrain: z, own: 0, rotation: 0, flipX: false, flipY: false, hidden: false } as Token;
      // A ring on the ground under it, and a dashed line down to it when it's off the ground.
      const u = this.u;
      const floor = this.gridHeight(x, y);
      const ground = Number.isNaN(floor) ? 0 : floor;
      const ring = new THREE.Mesh(new THREE.RingGeometry(scene.dpi * u * 0.1, scene.dpi * u * 0.14, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
      ring.position.set(x * u, y * u, ground * k + 1);
      ring.renderOrder = 3;
      ring.userData.prop = true;
      this.tokenGroup.add(ring);
      let stem: THREE.Line | null = null;
      if (Math.abs(z - ground) > 1e-6) {
        stem = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x * u, y * u, z * k), new THREE.Vector3(x * u, y * u, ground * k)]),
          new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 6, gapSize: 5, transparent: true, opacity: 0.85 })
        );
        stem.computeLineDistances();
        stem.userData.prop = true;
        this.tokenGroup.add(stem);
      }
      this.handles.push({ token, el, disc, img, zTok: z * k, screen: { x: 0, y: 0 }, hidden: false, marks: { ring, stem } });
    };
    for (const template of this.templates) {
      make(`${TEMPLATE_HANDLE}${template.id}:origin`, template.x, template.y, template.z, false);
      if (template.shape === "cone" || template.shape === "line") {
        const tip = templateTip(template);
        const across = tip.across * scene.dpi;
        make(`${TEMPLATE_HANDLE}${template.id}:tip`, template.x + template.dir.x * across, template.y + template.dir.y * across, template.z + tip.rise, true);
      }
    }
  }

  /** The tokens a template reaches, ringed (see main.ts). */
  setAffected(ids: Set<string>) {
    this.affected = ids;
    for (const view of this.tokenViews) {
      if (!view.prop) {
        view.el.classList.toggle("affected", ids.has(view.token.id));
      }
    }
  }

  /**
   * Each zone with water: a surface at its floor plus the water's depth,
   * the map's own picture there seen through it (its colour, gently
   * wobbling), with glints drifting over it and a little see-through.
   */
  private buildWater() {
    this.clear(this.waterGroup);
    const scene = this.scene;
    if (!scene || !this.texture || !this.mapTexture) {
      return;
    }
    const t = this.texture;
    for (const piece of scene.pieces) {
      if (!piece.water || piece.stand) {
        continue;
      }
      const level = piece.height + piece.water;
      const key = `${level}|${JSON.stringify(piece.shape)}|${this.gridKey(piece.shape, scene.dpi * 2)}`;
      let kept = this.waterCache.get(key);
      if (!kept) {
        kept = { reach: waterReach(scene, piece as Piece & { water: number }), shape: waterShape(scene, piece), used: 0 };
        this.waterCache.set(key, kept);
      }
      kept.used = this.builds;
      const surface = new THREE.Mesh(this.shapeGeometry(kept.shape), waterMaterial(this.mapTexture, t, this.u, scene.dpi, kept.reach));
      surface.position.z = level * this.k;
      surface.renderOrder = 4;
      this.waterGroup.add(surface);
    }
    // Those no build since the last has used: let go (their masks with them).
    for (const [key, kept] of this.waterCache) {
      if (kept.used < this.builds - 1) {
        kept.reach.mask.dispose();
        this.waterCache.delete(key);
      }
    }
    this.playWeather();
  }

  /** The grid's heights within a shape's box (and `margin` round it), as a short key: the same while they are. */
  private gridKey(shape: MultiPolygon, margin: number): string {
    const { x0, y0, step, w, h, cells } = this.grid;
    const xs = shape.flatMap((polygon) => polygon[0].map((p) => p[0]));
    const ys = shape.flatMap((polygon) => polygon[0].map((p) => p[1]));
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - margin - x0) / step));
    const i1 = Math.min(w - 1, Math.ceil((Math.max(...xs) + margin - x0) / step));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - margin - y0) / step));
    const j1 = Math.min(h - 1, Math.ceil((Math.max(...ys) + margin - y0) / step));
    // FNV-1a over the heights' bits.
    const bits = new Uint32Array(cells.buffer, cells.byteOffset, cells.length);
    let hash = 0x811c9dc5;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        hash = Math.imul(hash ^ bits[j * w + i], 0x01000193);
      }
    }
    return `${step}:${i0},${j0},${i1},${j1}:${(hash >>> 0).toString(36)}`;
  }

  /**
   * While there's weather (and the panel shows), it's drawn again about 30
   * times a second: its particles move on the GPU, so only their time changes.
   */
  private playWeather() {
    if (this.weatherFrame || this.paused || !this.hasWeather) {
      return;
    }
    let last = 0;
    const tick = (time: number) => {
      if (this.paused || !this.hasWeather) {
        this.weatherFrame = 0;
        return;
      }
      if (time - last >= this.look.frameMs) {
        last = time;
        this.weatherUniforms();
        this.render();
      }
      this.weatherFrame = requestAnimationFrame(tick);
    };
    this.weatherFrame = requestAnimationFrame(tick);
  }

  /** The weather on to now, its particles sized for the camera (screen px a view unit at the eye's distance, in device px). */
  private weatherUniforms() {
    const pointScale = this.fit * this.camera.zoom * this.persp * (this.renderer?.getPixelRatio() ?? 1);
    // The shadows share one material per cloud: set once is enough, but setting it again is harmless.
    setWeatherTime([...this.weatherGroup.children, ...this.cloudShadowGroup.children], performance.now() / 1000, pointScale, this.persp, this.fit * this.camera.zoom);
    for (const mesh of this.templateGroup.children) {
      const { uniforms } = (mesh as THREE.Mesh).material as THREE.ShaderMaterial;
      // Still at low quality (their look, not moving).
      if (this.moving) {
        uniforms.uTime.value = performance.now() / 1000;
      }
      uniforms.uEyeZ.value = this.persp;
    }
    if (this.moving && this.options.waterMotion) {
      for (const surface of this.waterGroup.children) {
        ((surface as THREE.Mesh).material as THREE.ShaderMaterial).uniforms.uTime.value = performance.now() / 1000;
      }
    }
  }

  /** The quality now (see QUALITY), and whether things move at it. */
  private get look() {
    return QUALITY[this.options.quality] ?? QUALITY.high;
  }

  private get moving() {
    return this.look.motion;
  }

  /** The canvas's sharpness for the quality now (redrawn at it). */
  private sharpen() {
    this.renderer?.setPixelRatio(Math.min(this.look.pixels, window.devicePixelRatio || 1));
    this.canvasSize = { w: 0, h: 0 };
    this.pauseVideos();
  }

  private pauseVideos() {
    const videos = [...this.stage.querySelectorAll("video"), ...[...this.videoTextures].map((texture) => texture.image as HTMLVideoElement)];
    for (const video of videos) {
      // Minimized, or at low quality: still.
      if (this.paused || !this.moving) {
        video.pause();
      } else {
        void video.play().catch(() => {});
      }
    }
  }

  /** A flat prop's picture as two triangles in view units, at height z (its uv the picture's). */
  private propQuad(prop: Prop, z: number): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.propCorners(prop, z), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]), 2));
    return geometry;
  }

  private propCorners(prop: Prop, z: number): Float32Array {
    const u = this.u;
    const m = new DOMMatrix(prop.transform);
    const corner = (x: number, y: number) => {
      const p = m.transformPoint(new DOMPoint(x, y));
      return [p.x * u, p.y * u, z];
    };
    const [a, b, c, d] = [corner(0, 0), corner(prop.width, 0), corner(prop.width, prop.height), corner(0, prop.height)];
    return new Float32Array([...a, ...b, ...c, ...a, ...c, ...d]);
  }

  /** A prop's view moved to where `prop` has it (its picture, shadow, base and line). */
  private moveProp(view: TokenView, prop: Prop) {
    const u = this.u;
    const k = this.k;
    const zFloor = prop.terrain * k;
    view.zTok = (prop.terrain + prop.own) * k;
    view.token = propToken(prop);
    view.prop!.data = prop;
    const { mesh, shadow } = view.prop!;
    for (const [object, z] of [
      [mesh, view.zTok + 0.6],
      [shadow, zFloor + 0.4],
    ] as const) {
      if (object) {
        const position = object.geometry.getAttribute("position") as THREE.BufferAttribute;
        position.copyArray(this.propCorners(prop, z));
        position.needsUpdate = true;
        object.geometry.computeBoundingSphere();
      }
    }
    if (view.seat) {
      moveBase(view.seat, prop.x * u, prop.y * u, zFloor + 1);
    }
    if (view.painted) {
      [view.painted.x, view.painted.y] = [prop.x, prop.y];
      this.basesMoved = true;
    }
    const stem = view.marks?.stem;
    if (stem) {
      const position = stem.geometry.getAttribute("position") as THREE.BufferAttribute;
      position.setXYZ(0, prop.x * u, prop.y * u, view.zTok);
      position.setXYZ(1, prop.x * u, prop.y * u, zFloor);
      position.needsUpdate = true;
      stem.computeLineDistances();
    }
    this.writeLabel(view);
  }

  /** Every label written again (the language changed: see main.ts). */
  relabel() {
    for (const view of this.tokenViews) {
      this.writeLabel(view);
    }
  }

  /** A token's label, as the options have it, from its height now. */
  private writeLabel(view: TokenView) {
    // A prop's label is on or off by itself; with the tokens' set to none, it says the name.
    const shown = view.prop && this.options.tokenLabels === "none" ? "name" : this.options.tokenLabels;
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
    const propViews = this.tokenViews.filter((view) => view.prop);
    if (views.length !== scene.tokens.length || propViews.length !== (this.propsMode === "none" ? 0 : scene.props.length)) {
      return false;
    }
    // Props moved, turned or raised are put right in place, as tokens are; any other change (which,
    // sized, its picture, raised from the ground or back down to it) draws them again.
    if (this.propsMode !== "none" && propsKey(scene.props) !== this.drawnProps) {
      return false;
    }
    const propsById = new Map(scene.props.map((prop) => [prop.id, prop]));
    for (const view of propViews) {
      const prop = propsById.get(view.token.id)!;
      if (prop !== view.prop!.data) {
        this.moveProp(view, prop);
      }
    }
    const byId = new Map(scene.tokens.map((token) => [token.id, token]));
    // A footprint changed: its base is drawn again at its new size.
    if (views.some((view) => !byId.has(view.token.id) || raised(view.token) !== raised(byId.get(view.token.id)!) || (view.token.own < 0) !== (byId.get(view.token.id)!.own < 0) || view.token.radius !== byId.get(view.token.id)!.radius)) {
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
      const zFloor = floorOf(token) * k;
      view.zTok = (token.terrain + token.own) * k;
      if (view.seat) {
        moveBase(view.seat, token.x * u, token.y * u, zFloor + 1);
      }
      if (view.painted) {
        [view.painted.x, view.painted.y] = [token.x, token.y];
        this.basesMoved = true;
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
    if (this.basesMoved) {
      this.paintBases();
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
      time("3d.render", () => this.renderer!.render(this.world, this.glCamera));
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
    // The bases painted on the terrain go with the tokens (and the props), as the flat ones do.
    this.baseGroup.visible = this.options.tokens || this.propsMode !== "none";
    this.tokenGroup.visible = this.options.tokens || this.propsMode !== "none";
    for (const child of this.tokenGroup.children) {
      // A prop's pieces stay with the props option; the tokens' bases and lines go with the tokens.
      child.visible = child.userData.prop === true || this.options.tokens;
    }
    if (this.hasWeather) {
      this.weatherUniforms();
    }
    this.render();

    // The tokens' 3D points on screen: the same matrix, then the perspective (eye at z = persp).
    const eye = camM.inverse().transformPoint(new DOMPoint(0, 0, this.persp));
    for (const view of [...this.tokenViews, ...(this.point ? [this.point] : []), ...this.handles]) {
      const { token, el, disc, img, zTok } = view;
      const p = camM.transformPoint(new DOMPoint(token.x * u, token.y * u, zTok));
      const f = this.persp / Math.max(1, this.persp - p.z);
      // Lying flat, only its label is an element, on its middle; the free point's marker, easy to grab.
      const marker = view === this.point || this.handles.includes(view);
      const d = view.prop?.flat ? 0 : Math.max(marker ? 12 : 22, token.size * u * s * f);
      view.screen = { x: this.width / 2 + p.x * f, y: this.height / 2 + p.y * f };
      el.style.transform = `translate(${view.screen.x}px,${view.screen.y}px)`;
      el.style.zIndex = String(10000 + Math.round(p.z));
      // Behind the eye: not drawn.
      el.style.visibility = this.persp - p.z > 1 ? "" : "hidden";
      // The free point's marker sits on its point, whatever the anchor (it's no picture).
      const isPoint = marker;
      const onBase = !isPoint && ((view.prop && !view.prop.flat) || this.options.anchor === "base");
      // By what of its picture shows (not its box, which may have empty margins or the figure off to
      // one side): what it stands on over the token's point, its bottom there on its base, or the
      // middle of what shows there (up and down) otherwise.
      // Set by hand (the Elevation menu's base), it's that point of its picture instead.
      const manual = view.prop?.flat || isPoint ? undefined : token.base;
      const measured = view.prop?.flat || isPoint ? undefined : visibleBox(token.url, token.video, () => this.requestApply());
      // The whole picture, only when its base is set by hand and it hasn't been read (the free point has no picture).
      const found = measured ?? (manual ? { x0: 0, y0: 0, x1: 1, y1: 1, base: 0.5, aspect: token.item.image.width / token.item.image.height } : undefined);
      const box = found && manual ? { ...found, base: manual.x, y1: manual.y } : found;
      let left = -d / 2;
      let top = onBase ? -d : -d / 2;
      // And its label just over that part, not over its box's empty top.
      let gap = 0;
      if (box) {
        const shown = visibleOnScreen(box, d, token);
        left = -d / 2 - shown.base;
        top = -d / 2 - (onBase ? shown.y1 : (shown.y0 + shown.y1) / 2);
        gap = Math.max(0, d / 2 + shown.y0);
      }
      disc.style.cssText = `width:${d}px;height:${d}px;left:${left}px;top:${top}px;--gap:${gap}px`;
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
    const origin = this.distanceOrigin === FREE_POINT ? this.point : this.tokenViews.find((view) => view.token.id === this.distanceOrigin);
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
      // Hidden from the camera: dashed. Out of the origin's sight (the terrain between them): faint, dotted.
      const sight = this.inSight(origin, target) ? "" : " nosight";
      group.setAttribute("class", (target.hidden ? "dline hidden" : "dline") + sight);
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

  /** The bridges' slabs, with their boxes (scene px) to skip them quickly, and the highest top (grid units). */
  private slabs: { bridge: Bridge; x0: number; y0: number; x1: number; y1: number }[] = [];
  private slabTop = 0;

  private computeSlabs() {
    this.slabs = (this.scene?.bridges ?? []).map((bridge) => {
      const points = bridge.shape.flatMap((polygon) => polygon[0]);
      return {
        bridge,
        x0: Math.min(...points.map((p) => p[0])),
        y0: Math.min(...points.map((p) => p[1])),
        x1: Math.max(...points.map((p) => p[0])),
        y1: Math.max(...points.map((p) => p[1])),
      };
    });
    this.slabTop = Math.max(0, ...this.slabs.map((slab) => slab.bridge.top));
  }

  /** Whether a point (view units) is inside a bridge's slab: over its outline, between its underside and its top. */
  private inSlab(vx: number, vy: number, vz: number): boolean {
    if (this.slabs.length === 0) {
      return false;
    }
    const x = vx / this.u;
    const y = vy / this.u;
    const z = vz / this.k;
    return this.slabs.some(({ bridge, x0, y0, x1, y1 }) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= bridge.bottom && z <= bridge.top && inShape(x, y, bridge.shape));
  }

  /**
   * Whether two tokens see each other: the straight line between them, at
   * eye height (most of a cell over each one's height), doesn't go into the
   * terrain on the way (a hair kept clear of each end, where they stand).
   */
  private inSight(from: TokenView, to: TokenView): boolean {
    const u = this.u;
    const k = this.k;
    const eye = 0.8 * k;
    const a = { x: from.token.x * u, y: from.token.y * u, z: from.zTok + eye };
    const b = { x: to.token.x * u, y: to.token.y * u, z: to.zTok + eye };
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const step = (this.grid.step * u) / 2;
    const clear = VIEW_CELL * 0.4;
    for (let d = clear; d < length - clear; d += step) {
      const t = d / length;
      const h = this.gridHeight((a.x + (b.x - a.x) * t) / u, (a.y + (b.y - a.y) * t) / u) * k;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const z = a.z + (b.z - a.z) * t;
      if ((!Number.isNaN(h) && z < h - 1) || this.inSlab(x, y, z)) {
        return false;
      }
    }
    return true;
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
      if (pz >= h !== above || this.inSlab(px, py, pz)) {
        return true;
      }
      if (above && dz > 0 && pz > Math.max(this.maxH, this.slabTop) * k) {
        return false;
      }
      if (dz < 0 && (pz < this.base * k || (!this.options.edges && pz < this.minH * k))) {
        return false;
      }
    }
    return false;
  }
}

/** The most points the heights grid has (see computeGrid). */
const MAX_GRID_POINTS = 200_000;

/** The free point's id among the lines' origins (see setPoint). */
export const FREE_POINT = "rising-ranges/free-point";

/** What a template's handle's id starts with: then the template's id and ":origin" or ":tip". */
export const TEMPLATE_HANDLE = "rising-ranges/template:";
