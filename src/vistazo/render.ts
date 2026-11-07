import type { TextStyle } from "@owlbear-rodeo/sdk";
import { labelFont } from "./labelFonts";
import * as THREE from "three";
import { colorAt, softColorAt, softPixels, type MapColors } from "./view/mapColors";
import { WALL_STYLE, wallBuffers, type WallBuffers } from "./view/wallBuffers";
import { wallShadowBuffers } from "./view/wallShadows";
import { FineSurfaces, pieceBuffers, uvsOver, type PieceBuffers, type Surface } from "./view/surfaces";
import { computeTerrain, type TerrainBuffers, type TerrainContext } from "./view/terrainBuffers";
import { BASE_TEX_WIDTH, binBases } from "./view/baseBins";
import { FILL_GROW, fillFrame, fillGroups, undersideBuffers } from "./view/undersides";
import { TerrainJobs, type TerrainAnswer } from "./terrainJob";
import { unpackWalls, type PackedWalls } from "./view/wallPack";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { MultiPolygon } from "polygon-clipping";
import { bridgeHighest, bridgeTop, inShape, pieceHeight, type Bridge, type MapImage, type Piece, type Prop, type Token, type VistazoScene } from "./scene";
import { isHexShape, ringSteps } from "../engine/hex";
import { foggedOf, type Fog } from "./fog";
import { visibleBox } from "./visibleBox";
import { CLOUD_GLSL, CLOUD_ZONES, buildWeather, cloudNoise, cloudShadowOf, setWeatherTime } from "./weather";
import { buildTemplate, templateTip, type Template } from "./templates";
import { doorMesh, type DoorMap, type DoorView } from "./doors";

import { LIGHT, QUALITY, STONE, TEXTURE_MAX, VIEW_CELL, type Camera, type DistanceLine, type Options, type Reach, type Texture, type TokenText, type TokenView, type Wall, tintOf } from "./view/types";
import { isShared, patternTexture } from "./view/patterns";
import { floorOf, mediaElement, propsKey, propToken, raised, skinAcross, skinPoint, visibleOnScreen } from "./view/helpers";
import { computeWalls, type Region } from "./view/walls";
import { BaseBatch, moveBase, ringMaterial, type BaseSeat } from "./view/bases";
import { UNDER_FRAGMENT, UNDER_VERTEX, WALL_GRAIN } from "./view/shaders";
import { NOISE_2D } from "./glsl";
import { reachMask, waterMaterial, waterReach, waterShape, type WaterReach } from "./view/water";
import { since, stamp, time } from "../timing";

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
// The see-through materials here are drawn with both faces in one pass (forceSinglePass): otherwise
// three.js draws a double-sided one twice, its shader looked up again each time, every frame.



/** The ground's level (view units, a hair under it): what's under it is cut away (see apply's map's edge). */
const GROUND_CLIP = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0.5);

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
  /** The ground tinted by Banda: a copy of each flat piece, its texture the Bandas' colours (see buildReach). */
  private reach: Reach | null = null;
  /** The Bandas, worked out at each pixel of the terrain (see BAND_GLSL): shared by every material they're on. */
  private readonly fillUniforms = {
    uFillU: { value: 1 },
    uFillShape: { value: 0 },
    uFillOrigin: { value: new THREE.Vector2() },
    uFillDpi: { value: 1 },
    uFillCells: { value: Array.from({ length: FILL_CELLS }, () => new THREE.Vector2()) },
    uFillCellCount: { value: 1 },
    uFillEdges: { value: new Array<number>(FILL_BANDS).fill(0) },
    uFillColors: { value: Array.from({ length: FILL_BANDS }, () => new THREE.Color()) },
    uFillBands: { value: 0 },
    /** Whether the Bandas tint the ground, and draw their rings on it (the options). */
    uFillTint: { value: 0 },
    uFillRings: { value: 0 },
  };
  private reachFrame = 0;
  private applyFrame = 0;
  private canvasSize = { w: 0, h: 0 };
  /** The props as last drawn (see propsKey): rebuilt when they change. */
  private drawnProps = "";
  /** The flat props' videos (webm): drawn again on each new frame of theirs (see watchVideo). */
  private videoTextures = new Set<THREE.VideoTexture>();
  private videoFrame = 0;
  /** The frame last drawn in (its time, see drawSoon). */
  private drawnAt = -1;
  /**
   * Opening (see firstDraw): drawn once yet, and its shaders still being compiled (in the background:
   * nothing drawn till they are, or drawing would wait for them).
   */
  private drawnOnce = false;
  private compiling = false;
  /** Openings' compiles (see firstDraw): the last one clears `compiling`. */
  private compiles = 0;
  /** This build is the map's arrival: what can wait, a moment later as at the opening (see firstDraw). */
  private deferExtras = false;
  /**
   * Materials taken off (see clear), let go once the picture's drawn with the new ones: a shader no
   * material uses any more is deleted, and built again (slowly) for the next that does.
   */
  private retired: THREE.Material[] = [];
  /** The panel minimized: every video paused (see setPaused). */
  private paused = false;
  /** The weather's particles (see weather.ts), what they were built from, and the frames they're drawn on. */
  private weatherGroup = new THREE.Group();
  /** Clouds as shadows: the terrain's surfaces under each (see copiesIn), with the shadows' material. */
  /** The clouds' shadows, worked out at each pixel of the terrain (see clouded): their zones, and the time they've drifted to. */
  private readonly cloudUniforms = {
    uCloudTime: { value: 0 },
    uCloudCell: { value: VIEW_CELL },
    uCloudCount: { value: 0 },
    uCloudBoxes: { value: Array.from({ length: CLOUD_ZONES }, () => new THREE.Vector4()) },
    uCloudDrifts: { value: Array.from({ length: CLOUD_ZONES }, () => new THREE.Vector2()) },
    uCloudCovers: { value: new Array<number>(CLOUD_ZONES).fill(0) },
    // Their shapes' picture, made the first time there are any (a clear pixel till then).
    uCloudNoise: { value: NO_FOG as THREE.Texture },
  };
  /** Under each bridge, the terrain's surfaces there (see copiesIn), filled from beside it (see buildUnderBridges). */
  private underBridgeGroup = new THREE.Group();
  /** Volume templates placed here (see setTemplates), and the meshes drawn for them. */
  private templates: Template[] = [];
  private templateGroup = new THREE.Group();
  /** The reliefs' doors (see doors.ts), and the list they're built from. */
  private doorGroup = new THREE.Group();
  private doors: DoorView[] = [];
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
  /** The player view's fog: its picture (see drawFog), laid on the terrain by its materials (see fogged). */
  private fogTexture: THREE.CanvasTexture | null = null;
  /** The fog's floor and curtains (see buildFogFloor). */
  private fogFloor: THREE.Group | null = null;
  /** Where each light's soft clearing is drawn before it's cut out of the fog (see lightMask). */
  private fogScratch: HTMLCanvasElement | null = null;
  /** The fog sharp: what's hidden, no soft edges (see drawFog, fogHidden). */
  private fogHardCanvas: HTMLCanvasElement | null = null;
  /** The sharp picture's pixels (read when first asked after it's drawn: see hiddenAt), and where it lies. */
  private hiddenPixels: Uint8ClampedArray | null = null;
  private hiddenFrame: { x0: number; y0: number; px: number; w: number; h: number } | null = null;
  private fogHardTexture: THREE.CanvasTexture | null = null;
  private fogCanvas: HTMLCanvasElement | null = null;
  /**
   * The player view's fog, laid on the terrain's tops and walls at each pixel (see fogged): its picture
   * (see drawFog), the scene's box it covers (view units), whether there's fog.
   */
  private readonly fogUniforms = {
    uFog: { value: NO_FOG as THREE.Texture },
    uFogHard: { value: NO_FOG as THREE.Texture },
    uFogBox: { value: new THREE.Vector4(0, 0, 1, 1) },
    uFogOn: { value: 0 },
  };
  /** The terrain's surfaces (tops, walls, standing pictures) and their heights, for what's drawn over them (see copiesIn). */
  private surfaces: { geometry: THREE.BufferGeometry; z: number }[] = [];
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
  /** The terrain's walls; or, from the worker, packed till they're asked for (see wallPack). */
  private wallList: Wall[] = [];
  private packedWalls: PackedWalls | null = null;
  private get walls(): Wall[] {
    if (this.packedWalls) {
      this.wallList = unpackWalls(this.packedWalls);
      this.packedWalls = null;
    }
    return this.wallList;
  }
  private set walls(walls: Wall[]) {
    this.wallList = walls;
    this.packedWalls = null;
  }
  private tokenViews: TokenView[] = [];
  private colors: ((x: number, y: number) => [number, number, number]) | null = null;
  /** The map's colour at a scene point, blurred (a few pixels to a cell) and read between them: blended walls' (see buildWalls). */
  private softColors: ((x: number, y: number) => [number, number, number]) | null = null;
  /** The map's colours as plain numbers (see mapColors): what colors and softColors read. */
  private mapColors: MapColors | null = null;
  private colorsFor = "";
  /** The map drawn once on a canvas (see loadColors); null until it's ready, or if the images can't be read. */
  private texture: Texture | null = null;
  private mapTexture: THREE.Texture | null = null;
  /**
   * The map's picture without the grid drawn on it (the same texture while the grid isn't shown): what
   * walls, standing pictures and slabs' sides take from the map, where the ground's cells don't belong.
   */
  private plainTexture: THREE.Texture | null = null;
  /** The maps' pictures (a video map's element), as the ground's texture is drawn from them (see playMaps). */
  private mapMedia: { images: CanvasImageSource[]; maps: VistazoScene["maps"] } | null = null;
  /** The grid drawn over the ground (see gridded): shared by its materials, so a change needs no rebuild. */
  private readonly gridUniforms = {
    uGridKind: { value: 0 },
    uGridDpi: { value: 1 },
    uGridCenter: { value: new THREE.Vector2() },
    uGridU: { value: 1 },
  };
  /** Bumped when the video maps start or stop (their frame callbacks see they're stale). */
  private mapsPlaying = 0;
  /** A lone video map played as the ground's texture itself (see useTexture): none of it drawn again. */
  private directVideo: HTMLVideoElement | null = null;
  /** Then, its first frame still: for what reads the map by its own reckoning (water, mirrored fills). */
  private stillTexture: THREE.Texture | null = null;
  /** The materials of the pieces, to dim or see through without rebuilding. */
  private pieceMaterials: THREE.MeshBasicMaterial[] = [];
  /**
   * What the terrain's materials work out now, besides the bases (see layers): the Bandas, the clouds'
   * shadows, the fog.
   * Left out of their shaders when off (a slow graphics card pays for them even then).
   */
  private layersOn = { bands: false, clouds: false, fog: false };
  /** Outlines already cut small (see fineGeometry), by outline: their flat triangles, and the last build that used them. */
  /** Surfaces that aren't flat, cut small once for an outline (see FineSurfaces). */
  private readonly fine = new FineSurfaces();
  /** The scene's terrain as numbers (see computeTerrain), and what it was worked out with (see terrainContext). */
  private terrain: TerrainBuffers | null = null;
  private terrainFor = "";
  /**
   * Away from the page (see terrainJob): the worker, and what it was last asked for (till it answers);
   * the walls a settling brush keeps (see setScene). None, or failed: the page works it out itself.
   */
  private jobs: TerrainJobs | null = TerrainJobs.make();
  private asked = "";
  private keepWalls: Wall[] | undefined;
  /** Bridges' fills worked out (see bridgeFill) from this map, by outline, and the last build that used them. */
  private fillCache = new Map<string, BridgeFill & { used: number }>();
  private builds = 0;
  /** The next scene's build is a brush's let go (see settleNext). */
  private settling = false;
  /**
   * The bases painted on the terrain (see paintBases): worked out at each pixel of its tops (see based),
   * from a texture of them and the bins they're in (see binBases); how many (none: not painted); the
   * bins' corner, size and how many across, and down; how far from the ground a slab's top still shows one.
   */
  private readonly baseUniforms = {
    uBaseTex: { value: baseTexture(new Float32Array(BASE_TEX_WIDTH * 4), 1) },
    uBaseCount: { value: 0 },
    uBaseBins: { value: new THREE.Vector4(0, 0, 1, 1) },
    uBaseDown: { value: 1 },
    uBaseReach: { value: VIEW_CELL },
  };
  private baseCount = 0;
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
      // The map's edge's walls cut at the ground (see apply).
      renderer.localClippingEnabled = true;
    } catch (error) {
      console.error("Rising Ranges: Vistazo couldn't start WebGL", error);
    }
    this.renderer = renderer;
    this.glCamera.matrixAutoUpdate = false;
    this.movingGroup.matrixAutoUpdate = false;
    this.world.add(this.terrainGroup, this.underGroup, this.movingGroup, this.pickGroup, this.edgeGroup, this.tokenGroup, this.weatherGroup, this.underBridgeGroup, this.waterGroup, this.templateGroup, this.doorGroup);
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
      // Their walls with them; the others built again without them, and the shadows at their feet. By the
      // shape each wall says it's of (the scene may be newer than the terrain drawn, its terrain on its way).
      const mine = this.walls.filter((wall) => picked.has(wall.si ?? -1));
      const others = this.walls.filter((wall) => !picked.has(wall.si ?? -1));
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
        new THREE.MeshBasicMaterial({ color, transparent: true, forceSinglePass: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
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
   * its surfaces kept for what's under bridges (see keepSurface),
   * nor the walls' shadows (the most of a rebuild). Off again, the next scene is drawn whole (or,
   * `settling`, by settleNext's build).
   */
  setLite(lite: boolean, settling = false) {
    if (this.lite === lite) {
      return;
    }
    this.lite = lite;
    // A drag begins with the scene's terrain still on its way from the worker (a let go just before): built
    // now, lightly, so what's dragged is what's there now (not what the last drag left), the worker's
    // answer dropped. Let go, it's built whole again.
    if (lite && this.asked && this.scene) {
      this.asked = "";
      this.build(true);
    }
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

  /** Whether the terrain's worked out away from the page (see terrainJob): its builds don't hold it up. */
  get terrainAway(): boolean {
    return this.jobs !== null;
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
    this.syncGrid();
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
      // The grid changed in Owlbear (square to hex, the hex cells moved): the ground's lines follow.
      this.syncGrid();
      this.updateWeather();
      this.requestApply();
      return;
    }
    const sameBase = base === this.base;
    this.terrainKey = scene.terrainKey;
    this.base = base;
    // Its walls kept when a brush's let go settles (its outlines haven't changed), as its level.
    this.keepWalls = settling && sameBase ? this.walls : undefined;
    if (settling) {
      // Its relief changed where it is, its key the same: the terrain worked out from it again (here, with
      // the walls kept; the worker sent it again for next time).
      this.terrainFor = "";
      this.jobs?.touched();
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
   * Each Banda as on the map — across only, its height left out — worked out at each pixel of the
   * terrain (see tinted): its ring (a circle, a square with the cubic metric, a hexagon's cells on a hex
   * grid) on the tops and walls, and, if asked, the ground inside it tinted its colour. Only numbers
   * handed to the shader: nothing built, as a Medición moves.
   */
  private buildReach() {
    const r = this.reach;
    const scene = this.scene;
    const f = this.fillUniforms;
    const show = !!r && !!scene && (this.options.rings || this.options.ringFill);
    f.uFillTint.value = this.options.ringFill ? 1 : 0;
    f.uFillRings.value = this.options.rings ? 1 : 0;
    if (!r || !scene || !show) {
      f.uFillBands.value = 0;
      this.setLayers({ bands: false });
      this.requestApply();
      return;
    }
    const dpi = scene.dpi;
    const bands = r.bands.filter((band) => Number.isFinite(band.reach)).map((band) => ({ ...band, across: band.reach + r.excess }));
    const shape = r.shape;
    // A Banda's edge, as the shader compares it: on hex cells, the whole steps it reaches (ringSteps).
    const edgeOf = (across: number) => (isHexShape(shape) ? ringSteps(across * dpi, dpi) + 1e-6 : across);
    f.uFillShape.value = isHexShape(shape) ? (shape === "hexHorizontal" ? 2 : 3) : shape === "square" ? 1 : 0;
    f.uFillOrigin.value.set(r.x, r.y);
    f.uFillDpi.value = dpi;
    const cells = (r.cells?.length ? r.cells : [{ x: 0, y: 0 }]).slice(0, FILL_CELLS);
    cells.forEach((cell, k) => f.uFillCells.value[k].set(cell.x, cell.y));
    f.uFillCellCount.value = cells.length;
    const list = bands.slice(0, FILL_BANDS);
    list.forEach((band, k) => {
      f.uFillEdges.value[k] = edgeOf(band.across);
      f.uFillColors.value[k].set(band.color);
    });
    f.uFillBands.value = list.length;
    this.setLayers({ bands: list.length > 0 });
    this.requestApply();
  }

  /** The terrain's materials with the Bandas or the fog in their shaders or not (see layersOn): only when that changes. */
  private setLayers(on: Partial<VistazoView["layersOn"]>) {
    const next = { ...this.layersOn, ...on };
    if (next.bands === this.layersOn.bands && next.clouds === this.layersOn.clouds && next.fog === this.layersOn.fog) {
      return;
    }
    this.layersOn = next;
    for (const material of this.pieceMaterials) {
      this.layers(material);
      material.needsUpdate = true;
    }
  }

  /** A terrain material's shader with what's on now (see layersOn). */
  private layers(material: THREE.MeshBasicMaterial) {
    material.defines = { ...material.defines };
    for (const [name, on] of [["RR_BANDS", this.layersOn.bands], ["RR_CLOUDS", this.layersOn.clouds], ["RR_FOG", this.layersOn.fog]] as const) {
      if (on) {
        material.defines[name] = "";
      } else {
        delete material.defines[name];
      }
    }
  }

  /**
   * The player view's fog (null: none): a picture laid on everything on the
   * ground (the pieces, walls and standing pictures, see fogged), redrawn on
   * its own once a frame at most — moving a light doesn't rebuild the terrain.
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
   * Whether the player view's fog hides a scene point, as it's drawn (its sharp picture's pixel there:
   * see drawFog, fogHidden). Quick: asked for every height read under the pointer.
   */
  hiddenAt(x: number, y: number): boolean {
    const frame = this.hiddenFrame;
    if (!this.fog || !frame || !this.fogHardCanvas) {
      return false;
    }
    if (!this.hiddenPixels) {
      this.hiddenPixels = this.fogHardCanvas.getContext("2d")!.getImageData(0, 0, frame.w, frame.h).data;
    }
    const i = Math.floor((x - frame.x0) * frame.px);
    const j = Math.floor((y - frame.y0) * frame.px);
    if (i < 0 || j < 0 || i >= frame.w || j >= frame.h) {
      return this.fog.filled;
    }
    return this.hiddenPixels[(j * frame.w + i) * 4 + 3] > 127;
  }

  /**
   * The fog as a picture of the whole map: its colour over the scene (or its
   * shapes), the lit areas cut out of it, sharp — up to 1024 px across.
   */
  private drawFog() {
    const fog = this.fog;
    const scene = this.scene;
    this.fogUniforms.uFogOn.value = fog && scene ? 1 : 0;
    this.setLayers({ fog: !!fog && !!scene });
    if (!fog || !scene) {
      this.dropFogFloor();
      this.hiddenFrame = null;
      this.hiddenPixels = null;
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
    }
    // Its shapes bottom to top: one covers, a cut one takes away what's under it.
    for (const { ring, cut } of fog.layers) {
      context.globalCompositeOperation = cut ? "destination-out" : "source-over";
      context.beginPath();
      trace(ring);
      context.fill("nonzero");
    }
    // What the lights reveal, cut out: each as its own soft edge has it (see lightMask).
    context.globalCompositeOperation = "destination-out";
    for (const area of fog.lit) {
      const box = this.lightMask(area, x0, y0, px, cw, ch);
      if (box) {
        const [bx, by, bw, bh] = box;
        context.drawImage(this.fogScratch!, bx, by, bw, bh, bx, by, bw, bh);
      }
    }
    if (!this.fogTexture) {
      this.fogTexture = new THREE.CanvasTexture(canvas);
    }
    this.fogTexture.needsUpdate = true;
    // The same, sharp: what's hidden (1) or not (0), the lights' whole reach cut out with no fading. What
    // isn't drawn goes by it (see fogHidden), so it ends on the fog's very outline, where the curtains
    // stand (see buildFogFloor); the soft picture only darkens.
    const hard = this.fogHardCanvas ?? document.createElement("canvas");
    if (hard.width !== cw || hard.height !== ch) {
      hard.width = cw;
      hard.height = ch;
      this.fogHardTexture?.dispose();
      this.fogHardTexture = null;
    }
    this.fogHardCanvas = hard;
    const sharp = hard.getContext("2d")!;
    const outline = (ring: [number, number][]) => {
      ring.forEach(([x, y], i) => (i === 0 ? sharp.moveTo((x - x0) * px, (y - y0) * px) : sharp.lineTo((x - x0) * px, (y - y0) * px)));
      sharp.closePath();
    };
    sharp.globalCompositeOperation = "source-over";
    sharp.clearRect(0, 0, cw, ch);
    sharp.fillStyle = "#ffffff";
    if (fog.filled) {
      sharp.fillRect(0, 0, cw, ch);
    }
    for (const { ring, cut } of fog.layers) {
      sharp.globalCompositeOperation = cut ? "destination-out" : "source-over";
      sharp.beginPath();
      outline(ring);
      sharp.fill("nonzero");
    }
    sharp.globalCompositeOperation = "destination-out";
    for (const area of fog.lit) {
      sharp.beginPath();
      area.rings.forEach(outline);
      sharp.fill("evenodd");
    }
    if (!this.fogHardTexture) {
      this.fogHardTexture = new THREE.CanvasTexture(hard);
    }
    this.fogHardTexture.needsUpdate = true;
    this.fogUniforms.uFogHard.value = this.fogHardTexture;
    // Its pixels for asking a point (see hiddenAt), read when first asked.
    this.hiddenPixels = null;
    this.hiddenFrame = { x0, y0, px, w: cw, h: ch };
    const u = this.u;
    this.fogUniforms.uFog.value = this.fogTexture;
    this.fogUniforms.uFogBox.value.set(x0 * u, y0 * u, w * u, h * u);
    time("3d.fog.floor", () => this.buildFogFloor(fog, scene));
  }

  /**
   * A light's clearing as a picture on the scratch canvas (see drawFog): within its outline (the walls'
   * shadows cut out), whole near it, fading out over the last `soft` of its reach, and toward its cone's
   * sides between its inner and outer angles, as Owlbear's lights are. Returns the box drawn (canvas px).
   */
  private lightMask(area: Fog["lit"][number], x0: number, y0: number, px: number, cw: number, ch: number): [number, number, number, number] | null {
    const { light, rings } = area;
    const scratch = this.fogScratch ?? (this.fogScratch = document.createElement("canvas"));
    if (scratch.width !== cw || scratch.height !== ch) {
      scratch.width = cw;
      scratch.height = ch;
    }
    const [cx, cy, r] = [(light.x - x0) * px, (light.y - y0) * px, Math.max(light.radius * px, 1e-3)];
    const bx = Math.max(0, Math.floor(cx - r - 2));
    const by = Math.max(0, Math.floor(cy - r - 2));
    const bw = Math.min(cw, Math.ceil(cx + r + 2)) - bx;
    const bh = Math.min(ch, Math.ceil(cy + r + 2)) - by;
    if (bw <= 0 || bh <= 0) {
      return null;
    }
    const g = scratch.getContext("2d")!;
    g.save();
    g.globalCompositeOperation = "source-over";
    g.clearRect(bx, by, bw, bh);
    g.beginPath();
    for (const ring of rings) {
      ring.forEach(([x, y], i) => (i === 0 ? g.moveTo((x - x0) * px, (y - y0) * px) : g.lineTo((x - x0) * px, (y - y0) * px)));
      g.closePath();
    }
    g.clip("evenodd");
    // Whole up to (1 − soft) of its reach, then fading out to its edge along a smooth S, as Owlbear's
    // lights do (they brighten the map near them too, which this doesn't).
    const whole = Math.min(1 - light.soft, 0.999);
    const radial = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    radial.addColorStop(0, "rgba(0,0,0,1)");
    const STOPS = 12;
    for (let i = 0; i <= STOPS; i++) {
      const t = i / STOPS;
      const fade = 1 - t * t * (3 - 2 * t);
      radial.addColorStop(whole + (1 - whole) * t, `rgba(0,0,0,${fade.toFixed(4)})`);
    }
    g.fillStyle = radial;
    g.fillRect(bx, by, bw, bh);
    const cone = light.cone;
    if (cone && cone.outer > cone.inner) {
      // Its sides fading: kept as much as a conic picture says, from one side of the cone round to the other.
      g.globalCompositeOperation = "destination-in";
      const conic = g.createConicGradient(cone.middle - cone.outer, cx, cy);
      const span = cone.outer / Math.PI; // the cone's share of a whole turn
      const edge = (cone.outer - cone.inner) / (2 * Math.PI);
      conic.addColorStop(0, "rgba(0,0,0,0)");
      conic.addColorStop(Math.min(edge, span / 2), "rgba(0,0,0,1)");
      conic.addColorStop(Math.max(span - edge, span / 2), "rgba(0,0,0,1)");
      conic.addColorStop(Math.min(span, 1), "rgba(0,0,0,0)");
      if (span < 1) {
        conic.addColorStop(1, "rgba(0,0,0,0)");
      }
      g.fillStyle = conic;
      g.fillRect(bx, by, bw, bh);
    }
    // Never quite all fog within its reach: darkened into the fog by its edge, not painted over (what's
    // drawn goes by the sharp picture: see fogHidden).
    g.globalCompositeOperation = "source-over";
    g.fillStyle = `rgba(0,0,0,${LIT_EDGE})`;
    g.fillRect(bx, by, bw, bh);
    g.restore();
    return [bx, by, bw, bh];
  }

  /**
   * What stands in for the terrain under the fog (which isn't drawn there,
   * see fogged): a flat floor of the fog's colour at height 0, and a curtain
   * of it along the fog's edge, from 0 to the ground's height on the clear
   * side, so a plateau cut by the fog shows a side, not its hollow. Worked
   * out with the fog's picture (a light moving redoes it, not the terrain).
   */
  private buildFogFloor(fog: Fog, scene: VistazoScene) {
    this.dropFogFloor();
    const u = this.u;
    const k = this.k;
    const color = new THREE.Color(fog.color);
    const group = new THREE.Group();
    const { x0, y0, x1, y1 } = scene.bounds;
    const floorMaterial = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    // Only where the terrain isn't drawn (a pit by the fog, or under a light's soft edge, shows); the
    // curtains reach well below it, so at a fog shape's sharp edge (its texels blur it) no gap shows.
    layer(floorMaterial, "fogfloor", this.fogUniforms, FOG_GLSL, "if (!fogHidden(vLayerAt.xy)) discard;");
    const floor = new THREE.Mesh(new THREE.PlaneGeometry((x1 - x0) * u, (y1 - y0) * u), floorMaterial);
    floor.position.set(((x0 + x1) / 2) * u, ((y0 + y1) / 2) * u, 0);
    group.add(floor);
    const fogged = foggedOf(fog, scene.world);
    if (fogged && fogged.length > 0) {
      const step = scene.dpi * 0.25;
      const near = scene.dpi * 0.05;
      // The ground's height just off the edge on its clear side (0 off the map; null: neither side clear).
      const clearHeight = (x: number, y: number, nx: number, ny: number): number | null => {
        for (const side of [1, -1]) {
          const [qx, qy] = [x + nx * near * side, y + ny * near * side];
          if (!fog.at(qx, qy)) {
            // Over a doorway, as high as its wall: the doorway's cut isn't seen through into the fog.
            return Math.max(scene.heightAt(qx, qy) ?? 0, scene.doorwayTop?.(qx, qy) ?? -Infinity);
          }
        }
        return null;
      };
      const positions: number[] = [];
      const bottom = (Math.min(0, this.minH) - 1) * k;
      for (const polygon of fogged) {
        for (const ring of polygon) {
          for (let i = 0; i < ring.length - 1; i++) {
            const [ax, ay] = ring[i];
            const [bx, by] = ring[i + 1];
            const length = Math.hypot(bx - ax, by - ay);
            if (length < 1e-6) {
              continue;
            }
            const [nx, ny] = [-(by - ay) / length, (bx - ax) / length];
            const n = Math.max(1, Math.ceil(length / step));
            // In steps: each sample's height held up to where the ground's height changes on the way
            // to the next (found by halving), then straight up or down: a slant between a plateau's
            // edge and the ground beside it would show as a wedge, a step halfway as a sliver past it.
            // From well below anything (a skirt: no gap under it at a sharp edge, a pit's side by the fog)
            // up to the ground's height there, or 0.
            const quad = (x0: number, y0: number, x1: number, y1: number, h: number | null) => {
              if (h === null) {
                return;
              }
              const [lo, hi] = [bottom, Math.max(0, h) * k];
              positions.push(x0 * u, y0 * u, lo, x1 * u, y1 * u, lo, x1 * u, y1 * u, hi, x0 * u, y0 * u, lo, x1 * u, y1 * u, hi, x0 * u, y0 * u, hi);
            };
            let last: [number, number, number | null] | null = null;
            for (let j = 0; j <= n; j++) {
              const [x, y] = [ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n];
              const h = clearHeight(x, y, nx, ny);
              if (last) {
                const [lx, ly, lh] = last;
                let [t0, t1] = [0, 1];
                if (h !== null && lh !== null && Math.abs(h - lh) > 1e-3) {
                  for (let it = 0; it < 7; it++) {
                    const t = (t0 + t1) / 2;
                    const mh = clearHeight(lx + (x - lx) * t, ly + (y - ly) * t, nx, ny) ?? 0;
                    if (Math.abs(mh - lh) <= Math.abs(mh - h)) {
                      t0 = t;
                    } else {
                      t1 = t;
                    }
                  }
                }
                const t = (t0 + t1) / 2;
                const [mx, my] = [lx + (x - lx) * t, ly + (y - ly) * t];
                quad(lx, ly, mx, my, lh);
                quad(mx, my, x, y, h);
              }
              last = [x, y, h];
            }
          }
        }
      }
      if (positions.length > 0) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
        group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })));
      }
    }
    this.fogFloor = group;
    this.world.add(group);
  }

  private dropFogFloor() {
    if (!this.fogFloor) {
      return;
    }
    this.world.remove(this.fogFloor);
    this.fogFloor.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose();
    });
    this.fogFloor = null;
  }

  /** A surface of the terrain (a top, a wall, a standing picture) kept for what's drawn over it (see copiesIn). */
  private keepSurface(geometry: THREE.BufferGeometry, z = 0) {
    if (!this.lite) {
      // A little above, as what's drawn over it was.
      this.surfaces.push({ geometry, z: z + 2 });
    }
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
    const ring = new THREE.Mesh(new THREE.RingGeometry(scene.dpi * u * 0.14, scene.dpi * u * 0.19, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, forceSinglePass: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    ring.position.set(at.x * u, at.y * u, ground * k + 1);
    ring.renderOrder = 3;
    ring.userData.prop = true;
    this.tokenGroup.add(ring);
    let stem: THREE.Line | null = null;
    if (Math.abs(at.height - ground) > 1e-6) {
      stem = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(at.x * u, at.y * u, at.height * k), new THREE.Vector3(at.x * u, at.y * u, ground * k)]),
        new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 6, gapSize: 5, transparent: true, forceSinglePass: true, opacity: 0.9 })
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
    const rebuild = changed(["heightScale", "shade", "levels", "relief", "tint", "rings", "ringFill"]);
    const regrid = changed(["grid"]);
    const relabel = changed(["tokenLabels", "props", "showProps", "propShadows", "propLines", "propLabels"]);
    const reweather = changed(["weather", "clouds", "waterMotion", "quality"]);
    const resharpen = changed(["quality"]);
    const replay = changed(["videoMaps", "quality"]);
    this.options = { ...this.options, ...options };
    // Played or still: the ground's texture drawn again, at its size for that.
    if (replay && this.scene?.maps.some((map) => map.video)) {
      this.colorsFor = "";
      this.loadColors();
    }
    if (resharpen) {
      this.sharpen();
    }
    this.stage.style.setProperty("--label-scale", String(this.options.labelSize));
    this.stage.classList.toggle("notok", !this.options.tokens);
    this.stage.classList.toggle("xray", this.options.xray);
    if (regrid) {
      this.syncGrid();
      this.requestRender();
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
  /** What the terrain's numbers are worked out with now (see computeTerrain), and a key that changes with it. */
  private terrainContext(): { context: TerrainContext; key: string } {
    const t = this.texture;
    const texture = t ? { x0: t.x0, y0: t.y0, w: t.w, h: t.h } : null;
    const context: TerrainContext = { u: this.u, k: this.k, shade: this.options.shade, levels: this.options.levels, relief: this.options.relief, texture, uvBox: this.uvBox(), colors: this.mapColors };
    return { context, key: JSON.stringify([context.u, context.k, context.shade, context.levels, context.relief, texture, context.uvBox, this.colorsFor, !!this.mapColors]) };
  }

  /**
   * The scene's terrain as numbers, up to date (true) or on its way (false): worked out by the worker
   * when the scene says what it was built from, drawn lightly too (a drag: the page not held up while
   * it's worked out, several times a second); else, or `now`, here (what the worker was asked for
   * meanwhile then dropped, as it comes: older). Its heights grid and walls the view's.
   */
  private ensureTerrain(now = false): boolean {
    const scene = this.scene!;
    const { context, key } = this.terrainContext();
    // Drawn lightly, a terrain without its extras (see computeTerrain): not the one wanted once let go.
    const want = `${scene.terrainKey}|${this.base}|${key}|${this.lite ? "lite" : ""}`;
    if (this.terrain && this.terrainFor === want) {
      return true;
    }
    const recipe = scene.recipe;
    if (this.jobs && recipe && !now && !this.keepWalls) {
      if (this.asked !== want) {
        this.asked = want;
        if (this.mapColors) {
          this.jobs.colors(this.colorsFor, this.mapColors);
        }
        void this.jobs.ask(recipe, this.base, context, this.mapColors ? this.colorsFor : null, this.lite).then((answer) => this.answered(answer, want));
      }
      return false;
    }
    this.asked = "";
    this.useTerrain(time("3d.terrain", () => computeTerrain(scene, this.base, context, this.fine, this.keepWalls, this.lite)), want);
    return true;
  }

  /** The worker's answer: built from, if it's still what's wanted (else it's been asked again since). Failed: worked out here from then on. */
  private answered(answer: TerrainAnswer, want: string) {
    if (this.asked !== want) {
      return;
    }
    this.asked = "";
    if ("failed" in answer) {
      console.error("Rising Ranges: 3D Glance's terrain worker failed, working it out on the page", answer.failed);
      this.jobs?.stop();
      this.jobs = null;
    } else if (this.scene?.terrainKey === answer.terrainKey) {
      this.useTerrain(answer.terrain, want);
      this.packedWalls = answer.walls;
    } else {
      // Still what's wanted, yet built from another scene than the page's (the worker can't make the
      // same one from what it's sent): asked again, it'd answer the same, for ever. Worked out here.
      console.warn("Rising Ranges: 3D Glance's terrain worker built another scene, working it out on the page");
      this.build(true);
      return;
    }
    this.build();
  }

  private useTerrain(terrain: TerrainBuffers, want: string) {
    this.terrain = terrain;
    this.terrainFor = want;
    this.grid = terrain.grid;
    this.walls = terrain.walls;
    this.keepWalls = undefined;
  }

  /** Whether a token at a scene point stands on the terrain itself (not a slab's top, nor in the air): its base painted on it. */
  private onTerrain(x: number, y: number, zFloor: number): boolean {
    const h = this.scene?.heightAt(x, y);
    return h !== undefined && Math.abs(h * this.k - zFloor) <= 0.1 * this.k;
  }

  /**
   * The bases of the tokens (and props) on the terrain, painted on it as the Banda tint is: at each
   * pixel of its tops (see based), so each follows the ground under it, bumps and all. Moved, only
   * these numbers change: nothing built again, no picture sent again.
   */
  private paintBases() {
    const u = this.u;
    const list = this.tokenViews.flatMap((view) => (view.painted ? [view.painted] : [])).map((base) => ({ x: base.x * u, y: base.y * u, r: base.r * u * (base.ring ? 1 : -1), z: base.z }));
    const b = this.scene?.bounds ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
    const { data, rows, bins, down } = binBases(list, { x0: b.x0 * u, y0: b.y0 * u, x1: b.x1 * u, y1: b.y1 * u });
    // The same size: its texels written over; else a texture that size.
    const texture = this.baseUniforms.uBaseTex.value;
    if (texture.image.height === rows) {
      (texture.image.data as unknown as Float32Array).set(data);
      texture.needsUpdate = true;
    } else {
      texture.dispose();
      this.baseUniforms.uBaseTex.value = baseTexture(data, rows);
    }
    this.baseUniforms.uBaseBins.value.set(...bins);
    this.baseUniforms.uBaseDown.value = down;
    this.baseCount = list.length;
    this.baseUniforms.uBaseReach.value = this.k / 2;
    this.basesMoved = false;
    this.requestApply();
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
      const material = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, forceSinglePass: true, opacity: 0.9, depthTest: false });
      this.brushRing = new THREE.LineLoop(new THREE.BufferGeometry(), material);
      this.brushRing.renderOrder = 20;
      this.world.add(this.brushRing);
    }
    this.brushRing.geometry.dispose();
    this.brushRing.geometry = new THREE.BufferGeometry();
    this.brushRing.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.requestApply();
  }

  /**
   * Height (grid units) at a scene point, NaN outside the map; 0 under the player view's fog (the
   * terrain's drawn whole, its heights under the fog not shown: see fogged, buildFogFloor).
   */
  private gridHeight(x: number, y: number): number {
    const { x0, y0, step, w, h, cells } = this.grid;
    const i = Math.round((x - x0) / step);
    const j = Math.round((y - y0) / step);
    if (i < 0 || j < 0 || i >= w || j >= h) {
      return NaN;
    }
    return this.hiddenAt(x, y) ? 0 : cells[j * w + i];
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
    this.softColors = null;
    this.mapColors = null;
    this.mapMedia = null;
    this.mapsPlaying++;
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
      .then(async (images) => {
        // In steps, the page let go between them (each is long on a slow machine): another map's
        // meanwhile, this one's dropped.
        const pause = () => new Promise((resolve) => setTimeout(resolve));
        if (key !== this.colorsFor) {
          return;
        }
        const small = draw(images, Math.min(1, 1024 / Math.max(w, h)));
        const pixels = { data: small.context.getImageData(0, 0, small.canvas.width, small.canvas.height).data, w: small.canvas.width, h: small.canvas.height };
        const colors: MapColors = { x0, y0, w, h, small: pixels, soft: softPixels(small.canvas, w, h, scene.dpi) };
        this.mapColors = colors;
        this.colors = (x, y) => colorAt(colors, x, y);
        // The doors that take the map's colours, in them now.
        this.buildDoors();
        this.softColors = (x, y) => softColorAt(colors, x, y);
        await pause();
        if (key !== this.colorsFor) {
          return;
        }
        // A video map played: a smaller texture, drawn again every frame.
        const played = this.options.videoMaps && scene.maps.some((map) => map.video);
        const cap = played ? (this.options.quality === "high" ? VIDEO_TEXTURE_MAX : VIDEO_TEXTURE_LIGHT) : TEXTURE_MAX;
        const most = Math.min(cap, this.renderer?.capabilities.maxTextureSize ?? TEXTURE_MAX);
        // A lone map (an image, or a video's first frame): its picture itself, made the graphics card's
        // size by the browser (off the page's own work), placed by its texture's transform; not drawn again
        // on a canvas as big (see placed).
        const lone = images.length === 1 && (images[0] instanceof HTMLImageElement || images[0] instanceof HTMLVideoElement) ? images[0] : null;
        let bitmap: ImageBitmap | null = null;
        if (lone && typeof createImageBitmap === "function") {
          const [lw, lh] = lone instanceof HTMLVideoElement ? [lone.videoWidth, lone.videoHeight] : [lone.naturalWidth, lone.naturalHeight];
          const fit = Math.min(1, most / Math.max(lw, lh, 1));
          try {
            bitmap = await createImageBitmap(lone, { resizeWidth: Math.max(1, Math.round(lw * fit)), resizeHeight: Math.max(1, Math.round(lh * fit)), resizeQuality: "high" });
          } catch {
            bitmap = null;
          }
        }
        const big = bitmap ? small : draw(images, Math.min(1, most / Math.max(w, h)));
        await pause();
        if (key !== this.colorsFor) {
          bitmap?.close();
          return;
        }
        this.texture?.bitmap?.close();
        this.texture = { canvas: big.canvas, x0, y0, w, h, ...(bitmap ? { bitmap } : {}) };
        this.mapMedia = { images, maps: scene.maps };
        this.fillCache.clear();
        this.useTexture();
        // The water, the walls' shadows and what's under bridges (its fill, from this map) a moment later.
        // Kept till that build draws (with the worker: once its terrain's back).
        this.deferExtras = true;
        this.build();
        this.playMaps();
      })
      .catch((error) => {
        console.error("Rising Ranges: Vistazo couldn't read the map images, drawing plain terrain", error);
      });
  }

  /** The map texture (the grid's cells are drawn over it by the ground's material: see gridded). */
  private useTexture() {
    const texture = this.texture;
    const scene = this.scene;
    if (!texture || !scene) {
      return;
    }
    const source: HTMLCanvasElement = texture.canvas;
    this.dropMapTextures();
    const anisotropy = this.renderer?.capabilities.getMaxAnisotropy() ?? 1;
    const media = this.mapMedia;
    const played = this.options.videoMaps && !!media?.images.some((img) => img instanceof HTMLVideoElement);
    // A lone video map: the video itself, its frames sent straight to the graphics card, its place on
    // the ground through the texture's own transform (see videoTexture).
    const lone = played && media!.images.length === 1 ? (media!.images[0] as HTMLVideoElement) : null;
    let map: THREE.Texture;
    if (lone) {
      map = videoTexture(lone, media!.maps[0], texture);
      this.directVideo = lone;
      // Its first frame, still (for the water and what's under bridges).
      this.stillTexture = texture.bitmap ? placed(new THREE.Texture(texture.bitmap), media!.maps[0], texture, true) : new THREE.CanvasTexture(texture.canvas);
      this.stillTexture.needsUpdate = true;
    } else if (texture.bitmap && media) {
      map = placed(new THREE.Texture(texture.bitmap), media.maps[0], texture, true);
      map.anisotropy = anisotropy;
      map.needsUpdate = true;
    } else {
      map = new THREE.CanvasTexture(source);
      map.anisotropy = anisotropy;
    }
    this.mapTexture = map;
    this.plainTexture = map;
    // Drawn again every frame: no smaller copies worked out each time (as costly as sending it).
    if (played) {
      map.generateMipmaps = false;
      map.minFilter = THREE.LinearFilter;
    }
    for (const material of this.pieceMaterials) {
      if (material.userData.mapTextured) {
        material.map = material.userData.mapTextured === "plain" ? this.plainTexture : map;
        material.needsUpdate = true;
      }
    }
    // The doors that take the map's picture, with it now.
    this.buildDoors();
    this.render();
  }

  /** The map's textures let go (both, if the grid made them two). */
  private dropMapTextures() {
    if (this.plainTexture && this.plainTexture !== this.mapTexture) {
      this.plainTexture.dispose();
    }
    this.stillTexture?.dispose();
    this.stillTexture = null;
    this.directVideo = null;
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
          if (own && own !== this.mapTexture && own !== this.plainTexture && own !== this.stillTexture && !isShared(own)) {
            own.dispose();
          }
          this.retired.push(m);
        });
      });
    }
    // Nothing drawn for a long while (minimized): not kept on.
    if (this.retired.length > 2000) {
      this.retired.splice(0).forEach((m) => m.dispose());
    }
  }

  /** A surface that isn't flat: its outline's triangles cut small (see FineSurfaces), its corners at height 0. */
  private fineGeometry(piece: Pick<Piece, "shape" | "peaks">): THREE.BufferGeometry {
    return geometryOf(this.fine.get(piece.shape, this.u, false, piece.peaks));
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
    return uvsOver(xy, count, this.u, this.uvBox());
  }

  /** Where the map's picture lies (scene px): the texture's box, or the scene's without one. */
  private uvBox() {
    const t = this.texture;
    const scene = this.scene!;
    return t ? { x0: t.x0, y0: t.y0, w: t.w, h: t.h } : { x0: scene.bounds.x0, y0: scene.bounds.y0, w: scene.bounds.x1 - scene.bounds.x0 || 1, h: scene.bounds.y1 - scene.bounds.y0 || 1 };
  }

  /** A top's or wall's material; `top`: the bases are painted on it (see based; a slab's, "deck"). */
  private pieceMaterial(height: number, textured: boolean, fill?: [number, number, number], top: boolean | "deck" = false): THREE.MeshBasicMaterial {
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
    if (textured) {
      gridded(material, this.gridUniforms);
    }
    if (top) {
      based(material, this.baseUniforms, top === "deck" ? "deck" : "top");
    }
    // The Bandas: tinting the tops, their rings on them; the fog over everything.
    tinted(material, this.fillUniforms, !!top);
    clouded(material, this.cloudUniforms);
    fogged(material, this.fogUniforms);
    this.layers(material);
    this.pieceMaterials.push(material);
    return material;
  }

  /** The grid over the ground as the options and Owlbear's grid have it (none, square, hex flat-topped or pointy). */
  private syncGrid() {
    const scene = this.scene;
    const g = this.gridUniforms;
    const hex = scene?.hexGrid;
    g.uGridKind.value = !scene || !this.options.grid ? 0 : hex ? (hex.shape === "hexHorizontal" ? 2 : 3) : scene.squareGrid ? 1 : 0;
    g.uGridDpi.value = scene?.dpi ?? 1;
    g.uGridCenter.value.set(hex?.center.x ?? 0, hex?.center.y ?? 0);
    g.uGridU.value = this.u;
    this.fillUniforms.uFillU.value = this.u;
  }

  /**
   * The walls (all of them, or those given): a mesh each style, inside (in
   * the terrain, or `into`) and at the map's edge (which can be hidden),
   * shaded top to bottom and by the light, their faces as the wall style
   * has them (their zone's, or the Vistazo's), and level lines at every
   * whole cell of height.
   */
  private buildWalls(list: Wall[] = this.walls, into: THREE.Group | null = null, worked?: WallBuffers[]) {
    const t = this.texture;
    const sets = worked ?? wallBuffers(list, { u: this.u, k: this.k, shade: this.options.shade, levels: this.options.levels, box: t ? { x0: t.x0, y0: t.y0, w: t.w, h: t.h } : null, colors: this.mapColors });
    for (const { edge, style, fromMap, positions, colors, uvs, levels } of sets) {
      const blend = style === "blend";
      const pattern = style === "stone" || style === "rubble" || style === "earth" || style === "wood" ? patternTexture(style) : null;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      const group = into ?? (edge ? this.edgeGroup : this.terrainGroup);
      const material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        map: fromMap ? this.plainTexture : pattern,
      });
      if (blend) {
        grained(material);
      }
      // The bases, as on the tops (see BASE_WALL); the Bandas' rings up the walls (no tint), and the fog: a
      // wall would give the hidden terrain away.
      based(material, this.baseUniforms, "wall");
      tinted(material, this.fillUniforms, false);
      clouded(material, this.cloudUniforms);
      fogged(material, this.fogUniforms);
      this.layers(material);
      material.userData.color = new THREE.Color(1, 1, 1);
      material.userData.mapTextured = fromMap ? "plain" : false;
      this.pieceMaterials.push(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.wall = true;
      group.add(mesh);
      if (!edge) {
        this.keepSurface(geometry);
      }
      if (levels.length > 0) {
        const lines = new THREE.BufferGeometry();
        lines.setAttribute("position", new THREE.BufferAttribute(levels, 3));
        const levelLines = new THREE.LineSegments(lines, fogCut(new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, forceSinglePass: true, opacity: 0.3 }), this.fogUniforms));
        levelLines.userData.wall = true;
        group.add(levelLines);
      }
    }
  }

  /** A soft shadow on the ground at the foot of each wall (all of them, or those given), fading out from it. */
  private buildWallShadows(list: Wall[] = this.walls, worked?: TerrainBuffers["shadows"]) {
    const scene = this.scene!;
    const shade = worked !== undefined ? worked : wallShadowBuffers(list, scene.heightAt, { u: this.u, k: this.k, relief: this.options.relief });
    if (shade) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(shade.positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(shade.colors, 4));
      // Each corner's wall foot (a wall's six corners: its foot's two ends a, b; its far edge's d, c of
      // b, a): a shadow goes with its wall under the fog, though its far edge reaches out of it.
      const feet = new Float32Array((shade.positions.length / 18) * 12);
      for (let i = 0; i < feet.length / 12; i++) {
        const p = shade.positions;
        const [ax, ay, bx, by] = [p[i * 18], p[i * 18 + 1], p[i * 18 + 3], p[i * 18 + 4]];
        feet.set([ax, ay, bx, by, bx, by, ax, ay, bx, by, ax, ay], i * 12);
      }
      geometry.setAttribute("aFoot", new THREE.BufferAttribute(feet, 2));
      const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, forceSinglePass: true, depthWrite: false, side: THREE.DoubleSide });
      const uniforms = this.fogUniforms;
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nattribute vec2 aFoot;\nvarying vec2 vFoot;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFoot = (modelMatrix * vec4(aFoot, 0.0, 1.0)).xy;");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", `#include <common>\nvarying vec2 vFoot;\n${FOG_GLSL}`)
          .replace("#include <opaque_fragment>", "if (fogHidden(vFoot)) discard;\n#include <opaque_fragment>");
      };
      material.customProgramCacheKey = () => "rising-ranges/wall-shadow-fog";
      const shadows = new THREE.Mesh(geometry, material);
      shadows.renderOrder = 1;
      shadows.userData.wall = true;
      this.terrainGroup.add(shadows);
    }
  }

  /** The map texture's coordinates at a view-unit point. */
  private uvAt(x: number, y: number): [number, number] {
    const t = this.texture!;
    const [sx, sy] = this.read(x / this.u, y / this.u);
    return [(sx - t.x0) / t.w, 1 - (sy - t.y0) / t.h];
  }

  /** Where the map's read for a scene point: past a doorway, along its wall (see VistazoScene.mapAt). */
  private read(x: number, y: number): [number, number] {
    return this.scene?.mapAt ? this.scene.mapAt(x, y) : [x, y];
  }

  /** The scene drawn (`now`: its terrain worked out here, not waited for from the worker). */
  private build(now = false) {
    const scene = this.scene;
    if (!scene) {
      return;
    }
    this.k = VIEW_CELL * this.options.heightScale;
    if (!this.ensureTerrain(now)) {
      // Its terrain on its way (see ensureTerrain): meanwhile what's drawn stays, the tokens where they are now.
      if (this.tokenViews.length === 0 || !this.moveTokens(scene)) {
        this.buildTokens();
      }
      this.requestApply();
      return;
    }
    // The cut outlines not used by the last two builds: let go.
    this.builds++;
    for (const [key, kept] of this.fillCache) {
      if (kept.used < this.builds - 2) {
        this.fillCache.delete(key);
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
    this.surfaces = [];
    this.pieceMaterials = [];
    const terrain = this.terrain!;

    // Each one's meshes marked with the relief shape it's of (for moving it whole).
    const mark = (from: number, si: number | undefined) => {
      for (const child of this.terrainGroup.children.slice(from)) {
        child.userData.si = si;
      }
    };
    time("3d.build.pieces", () => {
      scene.pieces.forEach((piece, i) => {
        const from = this.terrainGroup.children.length;
        this.buildPiece(piece, terrain.pieces[i]);
        mark(from, piece.si);
      });
    });
    time("3d.build.bridges", () => {
      for (const bridge of scene.bridges) {
        const from = this.terrainGroup.children.length;
        this.buildBridge(bridge);
        mark(from, bridge.si);
      }
    });
    time("3d.build.slabs", () => this.computeSlabs());
    // Opening: the water, the walls' shadows and what's under bridges a moment later (see firstDraw).
    const first = (!this.drawnOnce || this.deferExtras) && !this.lite;
    if (!this.lite) {
      this.deferExtras = false;
    }
    if (first) {
      this.clear(this.waterGroup);
      this.clear(this.underBridgeGroup);
    } else {
      time("3d.build.water", () => this.buildWater());
    }
    // Their heights follow the height scale.
    time("3d.build.templates", () => this.buildTemplates());

    time("3d.build.walls", () => this.buildWalls([], null, terrain.wallSets));

    // Not while something's being dragged (drawn lightly): the shadows at the walls' feet come back as it's let go.
    if (!this.lite && !first) {
      time("3d.build.wallShadows", () => this.buildWallShadows(this.terrain?.shadows !== undefined ? [] : this.walls, this.terrain?.shadows));
    }
    time("3d.build.fog", () => this.drawFog());
    if (!first) {
      time("3d.build.underBridges", () => this.buildUnderBridges());
    }
    time("3d.build.tokens", () => this.buildTokens());
    time("3d.build.reach", () => this.buildReach());
    // The terrain's built again: so are the cloud shadows on it.
    this.weatherKey = "";
    time("3d.build.weather", () => this.updateWeather());
    this.highlight(this.picked.shapes);
    // Its size (it reads the page's layout, which costs): not while something's being dragged, it hasn't changed.
    if (first) {
      this.firstDraw();
    } else if (!this.lite) {
      time("3d.measure", () => this.measure());
    }
  }

  /**
   * Opening, the terrain built: its shaders compiled in the background (the page not stuck waiting for
   * them), then drawn; then the rest (water, the walls' shadows, what's under bridges), compiled and
   * drawn too. Built again meanwhile: that build goes on from there instead.
   */
  private firstDraw() {
    const at = this.builds;
    // A moment at most (a lost context never answers): drawn then all the same, compiling as it draws.
    const compile = () =>
      Promise.race([this.renderer ? this.renderer.compileAsync(this.world, this.glCamera).catch(() => {}) : Promise.resolve(), new Promise((resolve) => setTimeout(resolve, 3000))]);
    // Compiling till it's done, unless another opening's compile has taken over since (that one says then).
    const compiling = ++this.compiles;
    const done = () => {
      if (this.compiles === compiling) {
        this.compiling = false;
      }
    };
    this.compiling = true;
    void compile().then(() => {
      done();
      if (this.builds !== at) {
        return;
      }
      this.drawnOnce = true;
      time("3d.measure", () => this.measure());
      setTimeout(() => {
        if (this.builds !== at || !this.scene) {
          return;
        }
        time("3d.build.water", () => this.buildWater());
        time("3d.build.wallShadows", () => this.buildWallShadows(this.terrain?.shadows !== undefined ? [] : this.walls, this.terrain?.shadows));
        time("3d.build.underBridges", () => this.buildUnderBridges());
        this.compiling = true;
        void compile().then(() => {
          done();
          this.requestApply();
        });
      });
    });
  }

  /**
   * What the map paints under a bridge is the bridge itself (seen from
   * above): on the ground and walls below it, within its outline (see
   * bridgeFill), something else instead. The map's colours round it, run in
   * from its sides and blended; or, mirroring, the map from just past its
   * long sides, mirrored across them, as if the map went on under it. Drawn
   * on the terrain's surfaces there (see copiesIn). Not under one that keeps
   * the map (not drawn on it), nor if the map can't be read.
   */
  private buildUnderBridges() {
    // Each bridge's surfaces are its own (merged from the copies: see copiesIn).
    this.clear(this.underBridgeGroup);
    const scene = this.scene;
    const texture = this.texture;
    if (!scene || !texture || !this.mapTexture) {
      return;
    }
    // Slabs over one another (a statue's body and arms) filled as one, over their outlines' union: no two
    // copies of the same ground taking turns pixel by pixel (see fillGroups). The terrain's, or now.
    const groups = this.terrain?.undersides ?? fillGroups(scene).map((group) => ({ ...group, ...undersideBuffers(scene, group, this.k) }));
    for (const group of groups) {
      const members = group.members.map((i) => scene.bridges[i]).filter((bridge) => bridge);
      if (members.length === 0) {
        continue;
      }
      // A mirroring one is alone in its group: its own frame.
      const bridge = members[0];
      const { center, along, across, halfAlong, halfAcross } = bridge.frame;
      const key = JSON.stringify(group.shape);
      let kept = this.fillCache.get(key);
      if (!kept) {
        const made = bridgeFill(group.shape, texture, scene.dpi * FILL_GROW);
        if (!made) {
          continue;
        }
        kept = { ...made, used: 0 };
        this.fillCache.set(key, kept);
      }
      kept.used = this.builds;
      const fill = new THREE.DataTexture(kept.pixels, kept.cols, kept.rows, THREE.RGBAFormat);
      fill.magFilter = THREE.LinearFilter;
      fill.minFilter = THREE.LinearFilter;
      fill.needsUpdate = true;
      const area = new THREE.Vector4(...kept.box);
      // Its underside's heights over the same box (see undersideBuffers).
      const { cols, rows, heights } = group;
      const underside = new THREE.DataTexture(heights, cols, rows, THREE.RGBAFormat, THREE.FloatType);
      // Read between its texels (where the card can: else nearest), so the fill's edge against what's
      // under it is a line, not stairs of texels.
      if (this.renderer?.extensions.has("OES_texture_float_linear")) {
        underside.magFilter = THREE.LinearFilter;
        underside.minFilter = THREE.LinearFilter;
      }
      underside.needsUpdate = true;
      const material = new THREE.ShaderMaterial({
        vertexShader: UNDER_VERTEX,
        fragmentShader: UNDER_FRAGMENT,
        transparent: true, forceSinglePass: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        uniforms: {
          uU: { value: this.u },
          uCell: { value: VIEW_CELL },
          uMirror: { value: bridge.under === "mirror" ? 1 : 0 },
          uMap: { value: this.stillTexture ?? this.mapTexture },
          uMapMatrix: { value: (this.stillTexture ?? this.mapTexture).matrix },
          uTex: { value: new THREE.Vector4(texture.x0, texture.y0, texture.w, texture.h) },
          uFrame: { value: new THREE.Vector4(center.x, center.y, along.x, along.y) },
          uAcross: { value: new THREE.Vector4(across.x, across.y, halfAlong, halfAcross) },
          uBelow: { value: Math.max(...members.map((m) => bridgeHighest(m) - (m.top - m.bottom))) * this.k },
          uFill: { value: fill },
          uUnderside: { value: underside },
          uBox: { value: area },
        },
      });
      fogCutShader(material, this.fogUniforms, "vAt.xy");
      material.addEventListener("dispose", () => {
        fill.dispose();
        underside.dispose();
      });
      // Only the terrain under its box, as one mesh (one draw, not one for every piece of the map).
      const u = this.u;
      const box = { x0: area.x * u, y0: area.y * u, x1: (area.x + area.z) * u, y1: (area.y + area.w) * u };
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
   * The terrain's surfaces (ground, tops, walls: see keepSurface) within a box
   * (view units; all of them with none), as one geometry: positions only,
   * each one's own height in them. For what's drawn over the terrain itself
   * (a bridge's fill), in one draw.
   */
  private copiesIn(box: { x0: number; y0: number; x1: number; y1: number } | null): THREE.BufferGeometry | null {
    const parts: THREE.BufferGeometry[] = [];
    for (const copy of this.surfaces) {
      const geometry = copy.geometry;
      if (!geometry.boundingBox) {
        geometry.computeBoundingBox();
      }
      const bounds = geometry.boundingBox!;
      if (box && (bounds.max.x < box.x0 || bounds.min.x > box.x1 || bounds.max.y < box.y0 || bounds.min.y > box.y1)) {
        continue;
      }
      const at = (geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
      const index = geometry.index?.array;
      const corners = index ? index.length : at.length / 3;
      // Only its triangles over the box (a copy is the whole ground often: a bridge's is a few of them),
      // read through its index (not made unindexed whole first); in the copy's own units (its offset taken
      // off the box), the corners' places only once the ones kept are known.
      const [ox, oy, oz] = [0, 0, copy.z];
      const [bx0, bx1, by0, by1] = box ? [box.x0 - ox, box.x1 - ox, box.y0 - oy, box.y1 - oy] : [-Infinity, Infinity, -Infinity, Infinity];
      const kept: number[] = [];
      for (let i = 0; i < corners; i += 3) {
        const a = (index ? index[i] : i) * 3;
        const b = (index ? index[i + 1] : i + 1) * 3;
        const c = (index ? index[i + 2] : i + 2) * 3;
        if (box) {
          const xa = at[a];
          const xb = at[b];
          const xc = at[c];
          const ya = at[a + 1];
          const yb = at[b + 1];
          const yc = at[c + 1];
          if ((xa < bx0 && xb < bx0 && xc < bx0) || (xa > bx1 && xb > bx1 && xc > bx1) || (ya < by0 && yb < by0 && yc < by0) || (ya > by1 && yb > by1 && yc > by1)) {
            continue;
          }
        }
        kept.push(a, b, c);
      }
      if (kept.length === 0) {
        continue;
      }
      const out = new Float32Array(kept.length * 3);
      for (let k = 0; k < kept.length; k++) {
        out[k * 3] = at[kept[k]];
        out[k * 3 + 1] = at[kept[k] + 1];
        out[k * 3 + 2] = at[kept[k] + 2];
      }
      const part = new THREE.BufferGeometry();
      part.setAttribute("position", new THREE.BufferAttribute(out, 3));
      part.translate(ox, oy, oz);
      parts.push(part);
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
    const thick = (bridge.top - bridge.bottom) * k;
    // Not flat: cut small (as a surfaced piece), each corner at its own height.
    const sloped = !!bridge.surface;
    const top = sloped ? this.fineGeometry({ shape: bridge.shape }) : this.shapeGeometry(bridge.shape);
    const position = top.getAttribute("position") as THREE.BufferAttribute;
    top.setAttribute("uv", new THREE.BufferAttribute(this.uvs(position.array, position.count), 2));
    if (sloped) {
      for (let i = 0; i < position.count; i++) {
        position.setZ(i, bridgeTop(bridge, position.getX(i) / u, position.getY(i) / u) * k);
      }
      position.needsUpdate = true;
    }
    // The bases of those on it painted on it, not those under it (see based).
    const deck = new THREE.Mesh(top, this.pieceMaterial(bridge.top, true, undefined, "deck"));
    deck.position.z = sloped ? 0 : bridge.top * k;
    this.terrainGroup.add(deck);
    this.keepSurface(top, deck.position.z);

    const style = bridge.walls ?? WALL_STYLE;
    const kind = style === "rubble" || style === "earth" || style === "wood" ? style : "stone";
    // With a picture from a rectangle of the map: the map, there, on its underside and sides.
    const skin = bridge.skin && this.mapTexture ? bridge.skin : undefined;
    // Blended: its sides the map's colours round it (blurred), its underside its tint; grain on both.
    const blend = style === "blend" && !skin;
    // Stretched or folded: its sides the map just inside its edge, as a wall's (see buildWalls); plain
    // (or those, with no map): one colour. Their underside its tint, no pattern.
    const mapped = !skin && (style === "stretch" || style === "fold") && this.texture !== null;
    const plain = !skin && (style === "flat" || style === "stretch" || style === "fold");
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
    const rgb = this.colors ? this.colors(...this.read(cx / n, cy / n)) : STONE;
    const tint = (shade: number) => new THREE.Color(...(rgb.map((v) => (v / 255) * shade) as [number, number, number]));
    const tile = VIEW_CELL * 2;

    // Its underside, a little darker (in its own shadow): as far under its top everywhere.
    const under = sloped ? top.clone() : this.shapeGeometry(bridge.shape);
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
      foggedToo(new THREE.MeshBasicMaterial({ map: skin ? this.mapTexture : blend || plain ? null : patternTexture(kind), color: skin ? new THREE.Color(0.6, 0.6, 0.6) : tint(0.6), side: THREE.DoubleSide }), this.fogUniforms)
    );
    if (blend) {
      grained(belly.material as THREE.MeshBasicMaterial);
    }
    belly.position.z = sloped ? -thick : bridge.bottom * k;
    this.terrainGroup.add(belly);

    // Its sides, round it and round its holes, from its underside up to its top, the pattern running along them.
    const positions: number[] = [];
    const uvs: number[] = [];
    const sideColors: number[] = [];
    const soft = this.softColors;
    const tone = ([x, y]: number[], shade: number) => (soft ? soft(x, y) : rgb).map((v) => (v / 255) * shade);
    const scene = this.scene!;
    const reach = scene.dpi * 0.3;
    /**
     * A door's lintel's side (see relief/doorCut.ts) at a point and height (grid units), facing out
     * (nx, ny): as the wall's on either side of it is (see wallBuffers), its top the wall's colour (read
     * in it past a jamb: the map in the doorway is its threshold), its foot the floor's outside, shaded
     * down to the floor and by the light. Not a lintel's (not in a doorway): null.
     */
    const lintelTone = (x: number, y: number, z: number, nx: number, ny: number): number[] | null => {
      const [ix, iy] = [x - nx * reach, y - ny * reach];
      const [rx, ry] = this.read(ix, iy);
      if (rx === ix && ry === iy) {
        return null;
      }
      const [ox, oy] = [x + nx * reach, y + ny * reach];
      const lit = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1]);
      const s = 1 - this.options.shade * (1 - (0.45 + 0.55 * lit));
      const top = (soft ? soft(rx, ry) : rgb).map((v) => (v / 255) * s * 0.92);
      const foot = (soft ? soft(ox, oy) : rgb).map((v) => (v / 255) * s * 0.62);
      const floor = scene.heightAt(ox, oy) ?? 0;
      const f = Math.max(0, Math.min(1, (bridge.top - z) / (bridge.top - floor || 1)));
      return top.map((v, i) => v + (foot[i] - v) * f);
    };
    // The fold's strip, as a wall's.
    const band = VIEW_CELL * 0.75;
    // Its sides' stretches: a side each, cut every half cell if it isn't flat (to follow its top).
    const stretches: [number, number, number, number][] = [];
    for (const ring of bridge.shape.flat()) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [a, b] = [ring[i], ring[i + 1]];
        const n = sloped ? Math.max(1, Math.ceil((Math.hypot(b[0] - a[0], b[1] - a[1]) * u) / (VIEW_CELL * 0.5))) : 1;
        for (let j = 0; j < n; j++) {
          stretches.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n, a[0] + ((b[0] - a[0]) * (j + 1)) / n, a[1] + ((b[1] - a[1]) * (j + 1)) / n]);
        }
      }
    }
    let along = 0;
    for (const [sax, say, sbx, sby] of stretches) {
      const [ax, ay] = [sax * u, say * u];
      const [bx, by] = [sbx * u, sby * u];
      const length = Math.hypot(bx - ax, by - ay);
      // Its top and underside at each end (the same at both, flat).
      const [za1, zb1] = [bridgeTop(bridge, sax, say) * k, bridgeTop(bridge, sbx, sby) * k];
      const [za0, zb0] = [za1 - thick, zb1 - thick];
      if (mapped && length > 1e-9) {
        // Into the slab from this side (round a hole, away from it).
        let [ix, iy] = [-(by - ay) / length, (bx - ax) / length];
        if (!inShape((ax + bx) / 2 / u + (ix * 0.05) / u, (ay + by) / 2 / u + (iy * 0.05) / u, bridge.shape)) {
          [ix, iy] = [-ix, -iy];
        }
        const inside = (d: number) => [...this.uvAt(ax + ix * d, ay + iy * d), ...this.uvAt(bx + ix * d, by + iy * d)];
        // A strip from depth dt to db under the top (at each end its own top).
        const quad = (dt: number, db: number, top: number[], bottom: number[]) => {
          positions.push(ax, ay, za1 - db, bx, by, zb1 - db, bx, by, zb1 - dt, ax, ay, za1 - db, bx, by, zb1 - dt, ax, ay, za1 - dt);
          uvs.push(bottom[0], bottom[1], bottom[2], bottom[3], top[2], top[3], bottom[0], bottom[1], top[2], top[3], top[0], top[1]);
        };
        if (style === "stretch") {
          // The map's pixels at its edge (a hair inside), stretched down.
          quad(0, thick, inside(1.5), inside(1.5));
        } else {
          // Strips of the map just inside the edge, folded down, every other one mirrored.
          for (let t = 0, j = 0; t < thick - 1e-9; t += band, j++) {
            const t1 = Math.min(thick, t + band);
            const d0 = j % 2 === 0 ? 0 : band;
            const d1 = j % 2 === 0 ? t1 - t : band - (t1 - t);
            quad(t, t1, inside(d0 + 0.5), inside(d1 + 0.5));
          }
        }
        along += length;
        continue;
      }
      positions.push(ax, ay, za0, bx, by, zb0, bx, by, zb1, ax, ay, za0, bx, by, zb1, ax, ay, za1);
      if (blend) {
        // Facing out of the slab (round a hole, into it).
        const sl = Math.hypot(sbx - sax, sby - say) || 1;
        let [nx, ny] = [-(sby - say) / sl, (sbx - sax) / sl];
        if (inShape((sax + sbx) / 2 + nx * 0.5, (say + sby) / 2 + ny * 0.5, bridge.shape)) {
          [nx, ny] = [-nx, -ny];
        }
        const lintel = (x: number, y: number, z: number) => lintelTone(x, y, z / k, nx, ny);
        const [la0, lb0, lb1, la1] = [lintel(sax, say, za0), lintel(sbx, sby, zb0), lintel(sbx, sby, zb1), lintel(sax, say, za1)];
        const [a0, b0, b1, a1] =
          la0 && lb0 && lb1 && la1 ? [la0, lb0, lb1, la1] : [tone([sax, say], 0.6), tone([sbx, sby], 0.6), tone([sbx, sby], 0.85), tone([sax, say], 0.85)];
        sideColors.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
      }
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
        uvs.push(ua, za0 / tile, ub, zb0 / tile, ub, zb1 / tile, ua, za0 / tile, ub, zb1 / tile, ua, za1 / tile);
      }
      along += length;
    }
    const sides = new THREE.BufferGeometry();
    sides.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    sides.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
    if (blend) {
      sides.setAttribute("color", new THREE.BufferAttribute(new Float32Array(sideColors), 3));
    }
    this.terrainGroup.add(
      new THREE.Mesh(
        sides,
        foggedToo(
          blend
            ? grained(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }))
            : new THREE.MeshBasicMaterial({
                map: skin || mapped ? this.plainTexture : plain ? null : patternTexture(kind),
                color: skin || mapped ? new THREE.Color(0.85, 0.85, 0.85) : tint(0.85),
                side: THREE.DoubleSide,
              }),
          this.fogUniforms
        )
      )
    );
  }

  /** A piece's meshes, from its numbers (worked out now if not given: see pieceBuffers). */
  private buildPiece(piece: Piece, worked?: PieceBuffers) {
    const t = this.texture;
    const built = worked ?? pieceBuffers(piece, { u: this.u, k: this.k, uvBox: this.uvBox(), texture: t ? { x0: t.x0, y0: t.y0, w: t.w, h: t.h } : null, colors: this.mapColors, fine: this.fine });
    const geometry = geometryOf(built.surface);
    if (built.kind === "top") {
      geometry.setAttribute("uv", new THREE.BufferAttribute(built.uv, 2));
      const mesh = new THREE.Mesh(geometry, this.pieceMaterial(piece.height, true, undefined, true));
      mesh.position.z = built.z;
      // Its corners can be moved up or down where they are (see reheight).
      mesh.userData.piece = piece;
      mesh.userData.fine = built.fine;
      this.terrainGroup.add(mesh);
      this.keepSurface(geometry, built.z);
      return;
    }
    const roofGeometry = geometry.clone();
    roofGeometry.setAttribute("uv", new THREE.BufferAttribute(built.roofUv, 2));
    const roofMaterial = this.pieceMaterial(piece.height, false, built.roofColor, true);
    roofMaterial.map = patternTexture(built.roof as "stone" | "rubble" | "earth" | "wood");
    const top = new THREE.Mesh(roofGeometry, roofMaterial);
    top.position.z = built.z;
    this.terrainGroup.add(top);
    this.keepSurface(geometry, built.z);
    if (built.card) {
      const card = new THREE.BufferGeometry();
      card.setAttribute("position", new THREE.BufferAttribute(built.card.position, 3));
      card.setAttribute("uv", new THREE.BufferAttribute(built.card.uv, 2));
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
      cardMesh.userData.cardMap = built.card.map;
      this.terrainGroup.add(cardMesh);
      this.keepSurface(card);
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
    const ring = ringMaterial();
    const fill = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, forceSinglePass: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
    const dashes = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 6, gapSize: 5, transparent: true, forceSinglePass: true, opacity: 0.9 });
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
        const material = new THREE.MeshBasicMaterial({ transparent: true, forceSinglePass: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 });
        const dark = propShadows && prop.own > 0 ? new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, forceSinglePass: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 }) : null;
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
            painted = { x: prop.x, y: prop.y, r: prop.radius * 0.8, ring: false, z: zFloor };
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
      const { name, title, detail } = propLabels ? labelsIn(disc, this.options.tokenLabels) : {};
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
        name,
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
      const painted = this.onTerrain(token.x, token.y, zFloor) ? { x: token.x, y: token.y, r: token.radius * 0.8, ring: true, z: zFloor } : undefined;
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
      const { name, title, detail } = this.options.tokenLabels !== "none" ? labelsIn(disc, this.options.tokenLabels) : {};
      disc.append(img);
      el.appendChild(disc);
      overlay.appendChild(el);
      const view: TokenView = { token, el, disc, img, zTok, screen: { x: 0, y: 0 }, hidden: false, marks: { ring: null, stem }, seat, painted, name, title, detail };
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

  /**
   * The video maps played on the ground (with the option on, not minimized):
   * at each new frame of theirs, the ground's texture drawn again from all
   * the maps (the grid over them) and sent to the graphics card. Otherwise
   * still, at the frame they're on.
   */
  private playMaps() {
    const media = this.mapMedia;
    const texture = this.texture;
    const run = ++this.mapsPlaying;
    const videos = (media?.images ?? []).filter((img): img is HTMLVideoElement => img instanceof HTMLVideoElement);
    if (!media || !texture || videos.length === 0) {
      return;
    }
    if (!this.options.videoMaps || this.paused) {
      videos.forEach((video) => video.pause());
      return;
    }
    const context = texture.canvas.getContext("2d")!;
    const px = texture.canvas.width / texture.w;
    let last = 0;
    const frame = () => {
      if (run !== this.mapsPlaying || !this.mapTexture) {
        return;
      }
      // At medium or low quality, 15 frames a second at most (the scene drawn again with each).
      const now = performance.now();
      if (this.options.quality !== "high" && now - last < 1000 / 15 - 2) {
        videos[0].requestVideoFrameCallback(frame);
        return;
      }
      last = now;
      // Straight from the video: only the scene drawn again.
      if (this.directVideo) {
        this.mapTexture.needsUpdate = true;
        this.requestRender();
        videos[0].requestVideoFrameCallback(frame);
        return;
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, texture.canvas.width, texture.canvas.height);
      media.images.forEach((img, index) => {
        const map = media.maps[index];
        context.setTransform(new DOMMatrix().scale(px).translate(-texture.x0, -texture.y0).multiply(new DOMMatrix(map.transform)));
        context.drawImage(img, 0, 0, map.width, map.height);
      });
      context.setTransform(1, 0, 0, 1, 0, 0);
      this.mapTexture.needsUpdate = true;
      this.requestRender();
      videos[0].requestVideoFrameCallback(frame);
    };
    for (const video of videos) {
      video.loop = true;
      void video.play().catch(() => {});
    }
    videos[0].requestVideoFrameCallback(frame);
  }

  /** The picture drawn again, once a frame at most however many videos ask. */
  private requestRender() {
    if (!this.videoFrame) {
      this.videoFrame = requestAnimationFrame(() => {
        this.videoFrame = 0;
        this.drawSoon();
      });
    }
  }

  /** Every video and the weather stopped (the panel minimized), or going again. */
  setPaused(paused: boolean) {
    this.paused = paused;
    this.pauseVideos();
    this.playMaps();
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
    const c = this.cloudUniforms;
    c.uCloudCount.value = 0;
    if (scene && weathers.length > 0) {
      const frame = { u: this.u, cell: VIEW_CELL, k: this.k, lowest: this.minH, highest: this.maxH, amount: this.look.amount };
      for (const object of buildWeather(weathers, frame, scene.dpi, this.options.clouds)) {
        this.weatherGroup.add(object);
      }
      // As shadows: on the terrain's own shader (see clouded), each zone's numbers.
      if (this.options.clouds === "shadows") {
        const zones = weathers.filter((w) => w.type === "CLOUD").slice(0, CLOUD_ZONES);
        zones.forEach((weather, i) => {
          const zone = cloudShadowOf(weather, frame);
          c.uCloudBoxes.value[i].set(...zone.box);
          c.uCloudDrifts.value[i].set(...zone.drift);
          c.uCloudCovers.value[i] = zone.cover;
        });
        c.uCloudCount.value = zones.length;
        if (zones.length > 0) {
          c.uCloudNoise.value = cloudNoise();
        }
      }
    }
    this.setLayers({ clouds: c.uCloudCount.value > 0 });
    this.playWeather();
  }

  /** Whether there's weather to animate (particles, haze or cloud shadows). */
  private get hasWeather() {
    return (
      this.weatherGroup.children.length > 0 ||
      this.cloudUniforms.uCloudCount.value > 0 ||
      (this.moving && this.templateGroup.children.length > 0) ||
      (this.moving && this.options.waterMotion && this.waterGroup.children.length > 0)
    );
  }

  /** The volume templates to draw (only in this view), moving with the weather's frames. */
  /** The reliefs' doors, open or shut as their fog doors are. */
  setDoors(doors: DoorView[]) {
    this.doors = doors;
    this.buildDoors();
    this.requestApply();
  }

  private buildDoors() {
    this.clear(this.doorGroup);
    const scene = this.scene;
    if (!scene) {
      return;
    }
    // What a leaf takes from the map (see DoorMap): its picture as the walls have it, its colours.
    const box = this.uvBox();
    const map: DoorMap = {
      texture: this.plainTexture ?? this.mapTexture,
      uv: (x, y) => [(x - box.x0) / box.w, 1 - (y - box.y0) / box.h],
      color: this.colors,
      grain: grained,
    };
    for (const door of this.doors) {
      // Its floor: in its opening's middle (its hinge is on the wall's end).
      let mx = (door.a.x + door.b.x) / 2, my = (door.a.y + door.b.y) / 2;
      if (door.panel !== undefined) {
        // A board against the wall (see DoorView.panel): its floor out past the wall's face.
        const len = Math.hypot(door.b.x - door.a.x, door.b.y - door.a.y) || 1;
        const out = door.panel + Math.sign(door.panel || 1) * door.cell * 0.3;
        mx += (-(door.b.y - door.a.y) / len) * out;
        my += ((door.b.x - door.a.x) / len) * out;
      }
      this.doorGroup.add(doorMesh(door, this.u, this.k, scene.heightAt(mx, my) ?? 0, VIEW_CELL, map));
    }
    // Under the player view's fog as the walls they're in: not drawn where it hides, darkened where it covers.
    const cut = new Set<THREE.Material>();
    this.doorGroup.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) cut.add(m);
      }
    });
    for (const m of cut) foggedToo(m as THREE.MeshBasicMaterial, this.fogUniforms);
  }


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
      const ring = new THREE.Mesh(new THREE.RingGeometry(scene.dpi * u * 0.1, scene.dpi * u * 0.14, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, forceSinglePass: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
      ring.position.set(x * u, y * u, ground * k + 1);
      ring.renderOrder = 3;
      ring.userData.prop = true;
      this.tokenGroup.add(ring);
      let stem: THREE.Line | null = null;
      if (Math.abs(z - ground) > 1e-6) {
        stem = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x * u, y * u, z * k), new THREE.Vector3(x * u, y * u, ground * k)]),
          new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 6, gapSize: 5, transparent: true, forceSinglePass: true, opacity: 0.85 })
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
    // Worked out with the terrain (see computeTerrain): as its waters, in order.
    const worked = this.terrain?.water ?? [];
    let w = 0;
    for (const piece of scene.pieces) {
      if (!piece.water || piece.stand) {
        continue;
      }
      const ready = worked[w++];
      const level = piece.height + piece.water;
      const key = `${level}|${JSON.stringify(piece.shape)}|${this.gridKey(piece.shape, scene.dpi * 2)}`;
      let kept = this.waterCache.get(key);
      if (!kept) {
        kept = ready
          ? { reach: reachMask(ready.reach), shape: ready.shape, used: 0 }
          : { reach: waterReach(scene, piece as Piece & { water: number }), shape: waterShape(scene, piece), used: 0 };
        this.waterCache.set(key, kept);
      }
      kept.used = this.builds;
      const surface = new THREE.Mesh(this.shapeGeometry(kept.shape), fogCutShader(waterMaterial(this.stillTexture ?? this.mapTexture, t, this.u, scene.dpi, kept.reach), this.fogUniforms, "vAt"));
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
        this.drawSoon();
      }
      this.weatherFrame = requestAnimationFrame(tick);
    };
    this.weatherFrame = requestAnimationFrame(tick);
  }

  /** The weather on to now, its particles sized for the camera (screen px a view unit at the eye's distance, in device px). */
  private weatherUniforms() {
    const pointScale = this.fit * this.camera.zoom * this.persp * (this.renderer?.getPixelRatio() ?? 1);
    setWeatherTime(this.weatherGroup.children, performance.now() / 1000, pointScale, this.persp, this.fit * this.camera.zoom);
    this.cloudUniforms.uCloudTime.value = performance.now() / 1000;
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
      [view.painted.x, view.painted.y, view.painted.z] = [prop.x, prop.y, zFloor];
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
    // Its name as Owlbear's map has it: its label's text and style, or nothing without one.
    if (view.name) {
      const label = view.token.item.text?.plainText?.trim() ?? "";
      // Not with the height alone.
      view.name.hidden = !label || shown === "height" || shown === "heightFull";
      view.name.textContent = label;
      // Owlbear's defaults for an image's label, where it has none of its own.
      const style = { padding: 8, fontFamily: "Roboto", fontSize: 24, fontWeight: 400, fillColor: "#ffffff", fillOpacity: 1, strokeColor: "#ffffff", strokeOpacity: 1, strokeWidth: 0, lineHeight: 1.5, ...(view.token.item.text?.style as Partial<TextStyle> | undefined) };
      const css = view.name.style;
      // In scene px, as Owlbear draws them: drawn here at the picture's scale (--u, see placeTokens).
      css.setProperty("--fs", String(style.fontSize));
      css.setProperty("--pad", String(style.padding));
      css.setProperty("--h", String(style.fontSize * style.lineHeight + style.padding * 2));
      css.setProperty("--sw", String(style.strokeWidth));
      css.fontFamily = `"${labelFont(style.fontFamily)}", Roboto, sans-serif`;
      css.fontWeight = String(style.fontWeight);
      css.lineHeight = String(style.lineHeight);
      css.color = `color-mix(in srgb, ${style.fillColor} ${style.fillOpacity * 100}%, transparent)`;
      css.setProperty("--stroke", `color-mix(in srgb, ${style.strokeColor} ${style.strokeOpacity * 100}%, transparent)`);
    }
    // Under it, its height and where it stands (none with the names alone).
    if (!view.title) {
      return;
    }
    const text = this.tokenText(view.token);
    view.title.parentElement!.hidden = shown === "name" || !text.height;
    view.title.textContent = text.height;
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
        [view.painted.x, view.painted.y, view.painted.z] = [token.x, token.y, zFloor];
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
    if (this.renderer && this.scene && this.width > 0 && this.height > 0 && !this.compiling) {
      time("3d.render", () => this.renderer!.render(this.world, this.glCamera));
      this.drawnAt = Number(document.timeline.currentTime ?? -1);
      for (const material of this.retired.splice(0)) {
        material.dispose();
      }
    }
  }

  /**
   * For what moves by itself (a video's new frame, the weather, the water): drawn, unless the picture was
   * drawn in this frame already or the camera's about to draw it (see requestApply), which shows the
   * change too. Otherwise each would draw it again, the same frame.
   */
  private drawSoon() {
    if (this.applyFrame || this.drawnAt === Number(document.timeline.currentTime ?? -2)) {
      return;
    }
    this.render();
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
    // The map's edge's walls off: only what's under the ground (the map's cut, its board) left out; what
    // stands over it there (a shape cut at the edge) is the terrain's own side, drawn whatever (not left
    // open). Cut where it's drawn, the walls whole: their shading as it is.
    const clipping = this.options.edges ? null : GROUND_CLIP;
    this.edgeGroup.traverse((object) => {
      const material = (object as THREE.Mesh).material as THREE.Material | undefined;
      if (material && (material.clippingPlanes?.[0] ?? null) !== clipping) {
        material.clippingPlanes = clipping ? [clipping] : null;
        material.needsUpdate = true;
      }
    });
    // The bases painted on the terrain go with the tokens (and the props), as the flat ones do.
    this.baseUniforms.uBaseCount.value = this.options.tokens || this.propsMode !== "none" ? this.baseCount : 0;
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
    const placed = stamp();
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
      // Its labels drawn at its picture's scale, as Owlbear's are (--u: screen px a scene px).
      disc.style.cssText = `width:${d}px;height:${d}px;left:${left}px;top:${top}px;--gap:${gap}px;--u:${d / Math.max(1, token.size)}`;
      // Turned as on the map (not with the camera: that reads oddly on a standing token).
      img.style.transform = `rotate(${token.rotation}deg) scale(${token.flipX ? -1 : 1},${token.flipY ? -1 : 1})`;
      const lift = onBase ? (token.size * u) / 2 : 0;
      view.hidden = this.blocked(token.x * u, token.y * u, zTok + lift + 4, eye);
      el.classList.toggle("hidden", view.hidden);
    }
    since("3d.apply.tokens", placed);
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
    this.slabTop = Math.max(0, ...this.slabs.map((slab) => bridgeHighest(slab.bridge)));
  }

  /** Whether a point (view units) is inside a bridge's slab: over its outline, between its underside and its top. */
  private inSlab(vx: number, vy: number, vz: number): boolean {
    if (this.slabs.length === 0) {
      return false;
    }
    const x = vx / this.u;
    const y = vy / this.u;
    const z = vz / this.k;
    return this.slabs.some(({ bridge, x0, y0, x1, y1 }) => {
      if (x < x0 || x > x1 || y < y0 || y > y1) {
        return false;
      }
      const top = bridgeTop(bridge, x, y);
      return z >= top - (bridge.top - bridge.bottom) && z <= top && inShape(x, y, bridge.shape);
    });
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


/** The free point's id among the lines' origins (see setPoint). */
export const FREE_POINT = "rising-ranges/free-point";

/** What a template's handle's id starts with: then the template's id and ":origin" or ":tip". */
export const TEMPLATE_HANDLE = "rising-ranges/template:";


/** A bridge's fill (see bridgeFill): RGBA bytes, cols × rows, over a box (scene units: x, y, width, height). */
type BridgeFill = { pixels: Uint8Array; cols: number; rows: number; box: [number, number, number, number] };

/**
 * What goes under a bridge in place of its drawing: over its box (`grow`
 * and a few texels wider; scene units), the map's colours; within `grow` of
 * its outline (and a texel and a half more, where its drawn edge is), those
 * round it run in and blended: averaged up a pyramid of halved grids till
 * every texel has some, then spread back down, each level filling what the
 * finer one lacked (pull-push). Its alpha: how much of the texel is within
 * `grow` of it (holes out), so it fades into the map over a texel. Null if
 * the map can't be read (the drawing is then left as it is).
 */
function bridgeFill(shape: MultiPolygon, map: Texture, grow: number): BridgeFill | null {
  const { x0, y0, step, cols, rows } = fillFrame(shape, grow);
  // Its sides (round it and its holes) as ax, ay, and the way to b, four numbers each.
  const list: number[] = [];
  for (const ring of shape.flat()) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const [ex, ey] = [ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]];
      if (ex * ex + ey * ey > 1e-18) {
        list.push(ring[i][0], ring[i][1], ex, ey);
      }
    }
  }
  const sides = new Float64Array(list);
  // Each texel's middle inside or not (holes out): a row at a time, by where the sides cross it.
  const within = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const y = y0 + (r + 0.5) * step;
    const crossings: number[] = [];
    for (let k = 0; k < sides.length; k += 4) {
      const [ay, ey] = [sides[k + 1], sides[k + 3]];
      if (ay > y !== ay + ey > y) {
        crossings.push(sides[k] + ((y - ay) / ey) * sides[k + 2]);
      }
    }
    crossings.sort((a, b) => a - b);
    for (let c = 0, n = 0; c < cols; c++) {
      const x = x0 + (c + 0.5) * step;
      while (n < crossings.length && crossings[n] < x) {
        n++;
      }
      within[r * cols + c] = n % 2;
    }
  }
  // Only those near the outline need how near: the rest are well in or well out.
  const band = grow + step * 2.5;
  const near = new Uint8Array(cols * rows);
  for (let k = 0; k < sides.length; k += 4) {
    const [ax, ay, bx, by] = [sides[k], sides[k + 1], sides[k] + sides[k + 2], sides[k + 1] + sides[k + 3]];
    const [c0, c1] = [Math.max(0, Math.floor((Math.min(ax, bx) - band - x0) / step)), Math.min(cols - 1, Math.ceil((Math.max(ax, bx) + band - x0) / step))];
    const [r0, r1] = [Math.max(0, Math.floor((Math.min(ay, by) - band - y0) / step)), Math.min(rows - 1, Math.ceil((Math.max(ay, by) + band - y0) / step))];
    for (let r = r0; r <= r1; r++) {
      near.fill(1, r * cols + c0, r * cols + c1 + 1);
    }
  }
  /** How far texel i (its middle at x, y) is from the outline: less than 0 inside. */
  const reach = (i: number, x: number, y: number) => {
    if (!near[i]) {
      return within[i] ? -Infinity : Infinity;
    }
    let best = Infinity;
    for (let k = 0; k < sides.length; k += 4) {
      const [ax, ay, ex, ey] = [sides[k], sides[k + 1], sides[k + 2], sides[k + 3]];
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
      best = Math.min(best, (ax + ex * t - x) ** 2 + (ay + ey * t - y) ** 2);
    }
    return within[i] ? -Math.sqrt(best) : Math.sqrt(best);
  };
  let bytes: Uint8ClampedArray;
  try {
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = [cols, rows];
    const ctx = canvas.getContext("2d")!;
    const [kx, ky] = [map.canvas.width / map.w, map.canvas.height / map.h];
    ctx.drawImage(map.canvas, (x0 - map.x0) * kx, (y0 - map.y0) * ky, cols * step * kx, rows * step * ky, 0, 0, cols, rows);
    bytes = ctx.getImageData(0, 0, cols, rows).data;
  } catch (error) {
    console.error("Rising Ranges: 3D Glance couldn't read the map under a slab, leaving its drawing", error);
    return null;
  }
  // Level 0: each texel's colour (weighted) and how much it counts: the map's, away from the outline; none near it.
  const inside = new Float32Array(cols * rows);
  let level = { cols, rows, rgbw: new Float32Array(cols * rows * 4) };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const d = reach(i, x0 + (c + 0.5) * step, y0 + (r + 0.5) * step) - grow;
      inside[i] = Math.max(0, Math.min(1, 0.5 - d / step));
      const w = d > step * 1.5 && bytes[i * 4 + 3] >= 128 ? 1 : 0;
      level.rgbw.set([bytes[i * 4] * w, bytes[i * 4 + 1] * w, bytes[i * 4 + 2] * w, w], i * 4);
    }
  }
  // Pull: halved grids, each texel the weighted average of the (up to) four under it, counting at most fully.
  const levels = [level];
  while (level.cols > 1 || level.rows > 1) {
    const next = { cols: Math.ceil(level.cols / 2), rows: Math.ceil(level.rows / 2), rgbw: new Float32Array(Math.ceil(level.cols / 2) * Math.ceil(level.rows / 2) * 4) };
    for (let r = 0; r < level.rows; r++) {
      for (let c = 0; c < level.cols; c++) {
        const [from, to] = [(r * level.cols + c) * 4, ((r >> 1) * next.cols + (c >> 1)) * 4];
        for (let k = 0; k < 4; k++) {
          next.rgbw[to + k] += level.rgbw[from + k];
        }
      }
    }
    for (let i = 0; i < next.rgbw.length; i += 4) {
      const w = next.rgbw[i + 3];
      if (w > 1) {
        for (let k = 0; k < 4; k++) {
          next.rgbw[i + k] /= w;
        }
      }
    }
    levels.push(next);
    level = next;
  }
  // Push: what each level lacks taken from the coarser one, read between its texels (no blocks).
  for (let l = levels.length - 2; l >= 0; l--) {
    const [fine, coarse] = [levels[l], levels[l + 1]];
    const read = (x: number, y: number, k: number) => {
      const cx = Math.max(0, Math.min(coarse.cols - 1, x));
      const cy = Math.max(0, Math.min(coarse.rows - 1, y));
      const [ix, iy] = [Math.floor(cx), Math.floor(cy)];
      const [jx, jy] = [Math.min(coarse.cols - 1, ix + 1), Math.min(coarse.rows - 1, iy + 1)];
      const [fx, fy] = [cx - ix, cy - iy];
      const v = (x: number, y: number) => {
        const i = (y * coarse.cols + x) * 4;
        // Colour as a share of what counted there (the coarsest have counted fully after their push).
        return coarse.rgbw[i + 3] > 0 ? coarse.rgbw[i + k] / coarse.rgbw[i + 3] : 0;
      };
      return (v(ix, iy) * (1 - fx) + v(jx, iy) * fx) * (1 - fy) + (v(ix, jy) * (1 - fx) + v(jx, jy) * fx) * fy;
    };
    for (let r = 0; r < fine.rows; r++) {
      for (let c = 0; c < fine.cols; c++) {
        const i = (r * fine.cols + c) * 4;
        const w = fine.rgbw[i + 3];
        if (w >= 1) {
          continue;
        }
        const [x, y] = [(c + 0.5) / 2 - 0.5, (r + 0.5) / 2 - 0.5];
        for (let k = 0; k < 3; k++) {
          fine.rgbw[i + k] += (1 - w) * read(x, y, k);
        }
        fine.rgbw[i + 3] = 1;
      }
    }
  }
  const pixels = new Uint8Array(cols * rows * 4);
  for (let i = 0; i < cols * rows; i++) {
    for (let k = 0; k < 3; k++) {
      pixels[i * 4 + k] = Math.round(levels[0].rgbw[i * 4 + k]);
    }
    pixels[i * 4 + 3] = Math.round(inside[i] * 255);
  }
  return { pixels, cols, rows, box: [x0, y0, cols * step, rows * step] };
}

/** A material with a blended wall's grain (see WALL_GRAIN) over its colour, where it is in the view. */
function grained<M extends THREE.MeshBasicMaterial>(material: M): M {
  // Over what the material's shader had already (the fog's cut, put on before it: see fogCut).
  const before = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGrainAt;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGrainAt = (modelMatrix * vec4(position, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vGrainAt;\n${NOISE_2D}\n${WALL_GRAIN}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\ndiffuseColor.rgb *= wallGrain(vGrainAt, ${VIEW_CELL.toFixed(1)});`);
  };
  material.customProgramCacheKey = () => `${key()}+rising-ranges/grained`;
  return material;
}

/** The longest side of the ground's texture while a video map is played on it (drawn again every frame), px. */
const VIDEO_TEXTURE_MAX = 2048;
/** The same at medium or low quality. */
const VIDEO_TEXTURE_LIGHT = 1536;

/**
 * A lone video map as the ground's texture: the video itself, placed by the
 * texture's transform where the map is in the texture's box (the ground's
 * uv: 0 to 1 across the box, up from its bottom). Turned, scaled, flipped:
 * the map's own transform undone, then over its size.
 */
/** A surface's arrays as a three.js geometry (see surfaces.ts). */
function geometryOf(surface: Surface): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(surface.position, 3));
  if (surface.index) {
    geometry.setIndex(new THREE.BufferAttribute(surface.index, 1));
  }
  return geometry;
}

function videoTexture(video: HTMLVideoElement, map: MapImage, box: Texture): THREE.VideoTexture {
  const texture = new THREE.VideoTexture(video);
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return placed(texture, map, box);
}

/**
 * A map's own picture (a video's, a lone image's) placed on the scene's box by its texture's transform:
 * the uvs worked out over the box (see uvs) taken to the picture's. `upright`: the picture sent as it
 * is (an ImageBitmap isn't turned over on its way to the graphics card), so its rows are read the other
 * way up.
 */
function placed<T extends THREE.Texture>(texture: T, map: MapImage, box: Texture, upright = false): T {
  const l = new DOMMatrix(map.transform).inverse();
  const [x0, y1, w, h] = [box.x0, box.y0 + box.h, box.w, box.h];
  // Scene (x, y) = (x0 + u·w, y1 − v·h); the map's own point = l·(x, y); the video's uv = (lx / W, 1 − ly / H).
  const [W, H] = [map.width, map.height];
  texture.matrixAutoUpdate = false;
  texture.matrix.set(
    (l.a * w) / W, (-l.c * h) / W, (l.a * x0 + l.c * y1 + l.e) / W,
    (-l.b * w) / H, (l.d * h) / H, 1 - (l.b * x0 + l.d * y1 + l.f) / H,
    0, 0, 1
  );
  if (upright) {
    texture.flipY = false;
    texture.matrix.premultiply(new THREE.Matrix3().set(1, 0, 0, 0, -1, 1, 0, 0, 1));
  }
  return texture;
}

/**
 * The grid's cells drawn over a ground material, worked out at each pixel
 * from where it is (scene px: the view units over uGridU): sharp at any
 * zoom, a line about a fiftieth of a cell wide (a pixel at least), darker
 * as the map's grid was; fading out where the cells get too small to tell
 * apart. Square: lines every cell (dpi). Hex, as Owlbear lays them out from
 * a cell's center, a cell (dpi) between neighbours: flat-topped (2) in
 * columns, every other one half a cell down; pointy (3) in rows, every
 * other one half a cell along. The same cells the hex rings follow.
 */
function gridded(material: THREE.MeshBasicMaterial, uniforms: Record<string, { value: unknown }>) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vGridAt;\nuniform float uGridU;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGridAt = (modelMatrix * vec4(position, 1.0)).xy / uGridU;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec2 vGridAt;\n${GRID_GLSL}`)
      .replace("#include <map_fragment>", "#include <map_fragment>\ndiffuseColor.rgb *= 1.0 - 0.35 * gridLine(vGridAt);");
  };
  material.customProgramCacheKey = () => "rising-ranges/gridded";
}

/**
 * The tokens' (and props') bases painted on a top or a wall of the terrain (on a wall, see BASE_WALL), worked out at each pixel from where
 * it is (view units): within a base's radius, darker (35%); its last two units (two pixels at least),
 * a light ring (a token's). On a slab's top (`deck`), only those standing on it, not those under it
 * (the terrain's own tops don't lie over one another: on them, wherever it is, steep ground too).
 * Over what's drawn there, the grid too, as the picture of them laid over it was. With gridded's (or
 * any) changes to the shader, kept.
 */
/** The bases' texture (see binBases): `rows` rows of BASE_TEX_WIDTH float texels, read texel by texel. */
function baseTexture(data: Float32Array, rows: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, BASE_TEX_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  return texture;
}

function based(material: THREE.MeshBasicMaterial, uniforms: Record<string, { value: unknown }>, on: "top" | "deck" | "wall") {
  const define = on === "deck" ? "#define BASE_DECK\n" : on === "wall" ? "#define BASE_WALL\n" : "";
  layer(material, `based${on === "top" ? "" : `-${on}`}`, uniforms, `${define}${BASE_GLSL}`, "outgoingLight = paintBases(outgoingLight, vLayerAt);");
}

/**
 * The Bandas worked out at each pixel of a top or wall (see BAND_GLSL), as the map's rings: the ring
 * of each, and on a top (`tint`) the ground inside it tinted, if the options ask.
 */
function tinted(material: THREE.MeshBasicMaterial, uniforms: Record<string, { value: unknown }>, tint: boolean) {
  layer(material, `tinted${tint ? "" : "-rings"}`, uniforms, BAND_GLSL, `#ifdef RR_BANDS\noutgoingLight = paintBands(outgoingLight, vLayerAt.xy / uFillU, ${tint});\n#endif`);
}

/** The clouds' shadows over a top or wall (see CLOUD_GLSL), when there are any. */
function clouded(material: THREE.MeshBasicMaterial, uniforms: Record<string, { value: unknown }>) {
  layer(material, "clouded", uniforms, CLOUD_GLSL, "#ifdef RR_CLOUDS\noutgoingLight = shadeClouds(outgoingLight, vLayerAt.xy);\n#endif");
}

/**
 * The player view's fog over a top or wall, from its picture laid from above (see drawFog): under
 * it, not drawn (the fog's floor and curtains stand in for it, see buildFogFloor: its heights would
 * give it away); by its edge, tinted.
 */
function fogged(material: THREE.MeshBasicMaterial, uniforms: Record<string, { value: unknown }>) {
  layer(material, "fogged", uniforms, FOG_GLSL, "#ifdef RR_FOG\nif (fogHidden(vLayerAt.xy)) discard;\noutgoingLight = paintFog(outgoingLight, vLayerAt.xy);\n#endif");
}

/**
 * As fogged, always (not only with RR_FOG on, as the terrain's own materials are, see layers): not drawn
 * where the fog hides, darkened where it covers; the material given back (a slab's sides, its belly; a
 * door's leaf).
 */
function foggedToo<M extends THREE.MeshBasicMaterial>(material: M, uniforms: Record<string, { value: unknown }>): M {
  layer(material, "foggedtoo", uniforms, FOG_GLSL, "if (fogHidden(vLayerAt.xy)) discard;\noutgoingLight = paintFog(outgoingLight, vLayerAt.xy);");
  return material;
}

/** Not drawn under the player view's fog (lines). */
function fogCut<M extends THREE.MeshBasicMaterial | THREE.LineBasicMaterial>(material: M, uniforms: Record<string, { value: unknown }>): M {
  layer(material, "fogcut", uniforms, FOG_GLSL, "if (fogHidden(vLayerAt.xy)) discard;");
  return material;
}

/** As fogCut, for a shader of its own: `at`, its pixel's place (view units, a vec2 it has). */
function fogCutShader(material: THREE.ShaderMaterial, uniforms: Record<string, { value: unknown }>, at: string): THREE.ShaderMaterial {
  Object.assign(material.uniforms, uniforms);
  material.fragmentShader = `${FOG_GLSL}\n${material.fragmentShader.replace("void main() {", `void main() {\n    if (fogHidden(${at})) discard;`)}`;
  return material;
}

/**
 * Something worked out at each pixel of a material, over what it draws: its uniforms; its functions;
 * what it does to the colour (before it's written), from the pixel's place in the world (vLayerAt,
 * view units: one for every layer, worked out once a vertex). Over what the material's shader had
 * already (the grid, another layer), in that order.
 */
function layer(material: THREE.Material, name: string, uniforms: Record<string, { value: unknown }>, head: string, body: string) {
  const before = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    if (!shader.vertexShader.includes("vLayerAt")) {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vLayerAt;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLayerAt = (modelMatrix * vec4(position, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vLayerAt;");
    }
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${head}`)
      .replace("#include <opaque_fragment>", `${body}\n#include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => `${key()}+rising-ranges/${name}`;
}

/**
 * A token's labels, under its picture: its name as Owlbear's map shows it, then (as `shown` has it) its
 * height and where it stands, in a pill of its own under that.
 */
function labelsIn(disc: HTMLElement, shown: string): { name: HTMLElement; title: HTMLElement; detail?: HTMLElement } {
  const labels = document.createElement("div");
  labels.className = "lbls";
  const name = document.createElement("div");
  name.className = "obr-lbl";
  const info = document.createElement("div");
  info.className = "lbl";
  const title = document.createElement("span");
  info.append(title);
  let detail: HTMLElement | undefined;
  if (shown === "full" || shown === "heightFull") {
    detail = document.createElement("small");
    info.append(detail);
  }
  labels.append(name, info);
  disc.prepend(labels);
  return { name, title, detail };
}

const BASE_GLSL = /* glsl */ `
  uniform highp sampler2D uBaseTex;
  uniform int uBaseCount;
  uniform vec4 uBaseBins;
  uniform float uBaseDown;
  uniform float uBaseReach;
  vec4 baseTexel(int i) {
    return texelFetch(uBaseTex, ivec2(i % ${BASE_TEX_WIDTH}, i / ${BASE_TEX_WIDTH}), 0);
  }
  vec3 paintBases(vec3 color, vec3 at) {
    // Half a pixel either side of each edge (smooth at any zoom), worked out once (before anything that
    // differs from one pixel to the next: a derivative needs its neighbours to have got here too).
    float aa = max(length(fwidth(at.xy)), 1e-4) * 0.5;
    if (uBaseCount == 0) return color;
    // Only the bases in this pixel's bin (see binBases): however many there are, a few at most each.
    vec2 bin = floor((at.xy - uBaseBins.xy) / uBaseBins.z);
    if (bin.x < 0.0 || bin.y < 0.0 || bin.x >= uBaseBins.w || bin.y >= uBaseDown) return color;
    vec4 list = baseTexel(uBaseCount + int(bin.y * uBaseBins.w + bin.x));
    int start = int(list.x);
    int count = int(list.y);
    for (int n = 0; n < count; n++) {
      vec4 b = baseTexel(int(baseTexel(start + n).x));
      vec2 off = at.xy - b.xy;
      float r = abs(b.z);
      if (dot(off, off) > (r + aa) * (r + aa)) continue;
      #ifdef BASE_DECK
        if (abs(at.z - b.w) > uBaseReach) continue;
      #endif
      // On a wall: down from its feet as far as the wall goes (as on the tops under it), up half a cell
      // at most, fading (not up a tall wall beside it, nor a bridge's sides over it).
      float lift = 1.0;
      #ifdef BASE_WALL
        lift = 1.0 - smoothstep(0.0, uBaseReach, at.z - b.w);
        if (lift <= 0.0) continue;
      #endif
      float d = length(off);
      float inside = (1.0 - smoothstep(r - aa, r + aa, d)) * lift;
      color *= 1.0 - 0.35 * inside;
      if (b.z > 0.0) {
        // As the measuring rings (see BAND_GLSL): about two pixels wide at any zoom, smooth; just inside
        // its edge (its middle a pixel in), not spilling out of the base.
        float px = (r - d) / (2.0 * aa);
        color = mix(color, vec3(1.0), 0.95 * lift * (1.0 - smoothstep(0.5, 1.5, abs(px - 1.0))));
      }
    }
    return color;
  }
`;

const GRID_GLSL = /* glsl */ `
  uniform float uGridKind;
  uniform float uGridDpi;
  uniform vec2 uGridCenter;
  // A flat-topped hex's distance from its middle, in the way its edges go (its apothem at the edge).
  float hexFlat(vec2 q) {
    q = abs(q);
    return max(q.y, 0.8660254 * q.x + 0.5 * q.y);
  }
  // How far a point is inside its cell's edge (scene px): the nearest of two offset lattices' centers.
  float hexEdge(vec2 p, bool flatTop) {
    float d = uGridDpi;
    float s = 0.8660254 * d;
    vec2 q = p - uGridCenter;
    if (!flatTop) q = q.yx;
    vec2 period = vec2(2.0 * s, d);
    vec2 a = q - period * floor(q / period + 0.5);
    vec2 qb = q - vec2(s, 0.5 * d);
    vec2 b = qb - period * floor(qb / period + 0.5);
    return 0.5 * d - min(hexFlat(a), hexFlat(b));
  }
  float gridLine(vec2 p) {
    if (uGridKind < 0.5) return 0.0;
    float d = uGridDpi;
    float dist;
    if (uGridKind < 1.5) {
      vec2 f = abs(fract(p / d + 0.5) - 0.5) * d;
      dist = min(f.x, f.y);
    } else {
      dist = hexEdge(p, uGridKind < 2.5);
    }
    float px = length(fwidth(p));
    // A pixel wide at least; thinner than that, as much fainter as it's thinner (as a picture of it
    // made smaller would be), not wider.
    float halfWidth = max(d * 0.01, px * 0.5);
    float cover = min(1.0, d * 0.02 / (2.0 * halfWidth));
    float line = (1.0 - smoothstep(halfWidth - px * 0.5, halfWidth + px * 0.5, dist)) * cover;
    // Too far to tell the cells apart: gone, not a grey haze.
    return line * (1.0 - smoothstep(d * 0.12, d * 0.35, px));
  }
`;

/** How many Bandas, and how many cells an Origen takes, the ground works out (see BAND_GLSL). */
const FILL_BANDS = 12;
const FILL_CELLS = 16;

/**
 * The Banda tint at a ground point (scene px), as buildReach measured it on
 * the CPU before: how far across it is (a circle, a square, or on hex cells
 * the whole steps of the cell it's in from the Origen's cells, as
 * cellStepsFrom), the first Banda whose edge it's within, and its color
 * fading in across the Banda (5% at its inner edge, 25% at its ring; on hex
 * cells by the point's own distance, not whole steps). Sharp at any zoom.
 */
const BAND_GLSL = /* glsl */ `
  uniform float uFillU;
  uniform float uFillShape;
  uniform vec2 uFillOrigin;
  uniform float uFillDpi;
  uniform vec2 uFillCells[${FILL_CELLS}];
  uniform int uFillCellCount;
  uniform float uFillEdges[${FILL_BANDS}];
  uniform vec3 uFillColors[${FILL_BANDS}];
  uniform int uFillBands;
  uniform float uFillTint;
  uniform float uFillRings;
  const float C30 = 0.8660254;
  // hexSteps: how many hex steps an offset (cells) is, continuously.
  float hexStepsG(vec2 d, bool horizontal) {
    float first = horizontal ? 0.0 : 0.5235988;
    float most = 0.0;
    for (int k = 0; k < 3; k++) {
      float angle = first + float(k) * 1.0471976;
      most = max(most, abs(d.x * cos(angle) + d.y * sin(angle)));
    }
    return most / C30;
  }
  // nearestCell: the center of the cell an offset (cells, from a cell's center) falls in.
  vec2 nearestCellG(vec2 d, bool horizontal) {
    float r = horizontal ? d.x / C30 : d.y / C30;
    float q = horizontal ? d.y - 0.5 * r : d.x - 0.5 * r;
    float s = -q - r;
    float rq = floor(q + 0.5);
    float rr = floor(r + 0.5);
    float rs = floor(s + 0.5);
    float dq = abs(rq - q);
    float dr = abs(rr - r);
    float ds = abs(rs - s);
    if (dq > dr && dq > ds) {
      rq = -rr - rs;
    } else if (dr > ds) {
      rr = -rq - rs;
    }
    return horizontal ? vec2(rr * C30, rq + rr * 0.5) : vec2(rq + rr * 0.5, rr * C30);
  }
  vec3 paintBands(vec3 color, vec2 at, bool tint) {
    if (uFillBands == 0) return color;
    vec2 d = (at - uFillOrigin) / uFillDpi;
    float across;
    float far = length(d);
    if (uFillShape < 0.5) {
      across = far;
    } else if (uFillShape < 1.5) {
      across = max(abs(d.x), abs(d.y));
      far = across;
    } else {
      bool horizontal = uFillShape < 2.5;
      vec2 base = uFillCells[0];
      vec2 cell = base + nearestCellG(d - base, horizontal);
      float best = 1e9;
      for (int k = 0; k < ${FILL_CELLS}; k++) {
        if (k >= uFillCellCount) break;
        best = min(best, hexStepsG(cell - uFillCells[k], horizontal));
      }
      if (uFillCellCount > 1) best += 1.0;
      across = floor(best + 0.5);
    }
    int index = -1;
    float inner = 0.0;
    float outer = 0.0;
    for (int k = 0; k < ${FILL_BANDS}; k++) {
      if (k >= uFillBands) break;
      if (across <= uFillEdges[k]) {
        index = k;
        outer = uFillEdges[k];
        break;
      }
      inner = uFillEdges[k];
    }
    // How fast across and the Banda change from one pixel to the next (worked out here, where every
    // pixel gets: the rings' width from them).
    float step = max(fwidth(across), 1e-6);
    float banded = fwidth(float(index < 0 ? uFillBands : index));
    if (tint && uFillTint > 0.5 && index >= 0) {
      float t = clamp((far - inner) / max(outer - inner, 1e-6), 0.0, 1.0);
      color = mix(color, uFillColors[index], 0.05 + 0.2 * t * t);
    }
    if (uFillRings > 0.5) {
      float line = 0.0;
      vec3 ink = vec3(1.0);
      if (uFillShape < 1.5) {
        // A circle's or a square's: about two pixels wide on its edge, smooth.
        for (int k = 0; k < ${FILL_BANDS}; k++) {
          if (k >= uFillBands) break;
          float a = 1.0 - smoothstep(0.5, 1.5, abs(across - uFillEdges[k]) / step);
          if (a > line) {
            line = a;
            ink = uFillColors[k];
          }
        }
      } else if (banded > 0.0) {
        // Hex cells: where the Banda changes, between cells.
        line = 1.0;
        ink = uFillColors[index < 0 ? uFillBands - 1 : index];
      }
      color = mix(color, ink, 0.95 * line);
    }
    return color;
  }
`;

/** The fog's picture over a scene point (view units; see drawFog): its colour, as much as it covers there. */
const FOG_GLSL = /* glsl */ `
  uniform sampler2D uFog;
  uniform sampler2D uFogHard;
  uniform vec4 uFogBox;
  uniform float uFogOn;
  // Whether the fog hides a point (view units): its sharp picture, past half (its outline, where the
  // curtains stand). A light's soft edge only darkens (see paintFog).
  bool fogHidden(vec2 at) {
    if (uFogOn < 0.5) return false;
    vec2 uv = (at - uFogBox.xy) / uFogBox.zw;
    return texture2D(uFogHard, vec2(uv.x, 1.0 - uv.y)).a > 0.5;
  }
  vec3 paintFog(vec3 color, vec2 at) {
    if (uFogOn < 0.5) return color;
    vec2 uv = (at - uFogBox.xy) / uFogBox.zw;
    vec4 fog = texture2D(uFog, vec2(uv.x, 1.0 - uv.y));
    return mix(color, fog.rgb, fog.a);
  }
`;

/** How much a light clears at the very edge of its reach, at least: the fog's tint there is 96%, the terrain still seen. */
const LIT_EDGE = 0.04;

/** No picture: a clear pixel, for the fog's and the clouds' uniforms till there's one (see fogUniforms, cloudUniforms). */
const NO_FOG = (() => {
  const texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  texture.needsUpdate = true;
  return texture;
})();


/** The walls' look where their shape has none of its own (see buildWalls). */
