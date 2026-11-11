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
import type { BridgeFill } from "./view/bridgeFill";
import { FillJobs, type FillFrame } from "./fillJob";
import { TerrainJobs, type TerrainAnswer } from "./terrainJob";
import { unpackWalls, type PackedWalls } from "./view/wallPack";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { MultiPolygon } from "polygon-clipping";
import { bridgeHighest, bridgeTop, inShape, pieceHeight, type Bridge, type MapImage, type Piece, type Prop, type Token, type VistazoScene } from "./scene";
import { isHexShape, ringSteps } from "../engine/hex";
import { foggedOf, type Fog } from "./fog";
import { visibleBox } from "./visibleBox";
import { CLOUD_ZONES, buildWeather, cloudNoise, cloudShadowOf, setWeatherTime } from "./weather";
import { buildTemplate, templateTip, type Template } from "./templates";
import { doorMesh, type DoorMap, type DoorView } from "./doors";

import { BASE_TEXTURE_MAX, DETAIL_SIZE, FULL_BUDGET, LIGHT, QUALITY, SOURCE_BUDGET, STONE, TEXTURE_MAX, VIEW_CELL, type Camera, type DistanceLine, type Options, type Reach, type Texture, type TokenText, type TokenView, type Wall, tintOf } from "./view/types";
import { isShared, patternTexture } from "./view/patterns";
import { floorOf, mediaElement, propsKey, stopVideo, propToken, raised, skinAcross, skinPoint, visibleOnScreen } from "./view/helpers";
import { AnimatedImage, animationOf, mayAnimate, stopAnimation } from "./view/animated";
import { computeWalls, type Region } from "./view/walls";
import { BaseBatch, moveBase, ringMaterial, type BaseSeat } from "./view/bases";
import { UNDER_FRAGMENT, UNDER_VERTEX } from "./view/shaders";
import { FILL_BANDS, FILL_CELLS, FOG_GLSL, baseTexture, based, clouded, detailed, fogCut, fogCutShader, fogged, foggedToo, grained, gridded, layer, tinted } from "./view/layers";
import { reachMask, waterMaterial, waterReach, waterShape, type WaterReach } from "./view/water";
import { MapComposer, sourceDensity, type MapBox, type MapMedia } from "./view/mapCompose";
import { record, since, stamp, time, timingOn } from "../timing";

export type { Camera, DistanceLine, Options } from "./view/types";
export { tintOf };

/** Who may open or shut a door from the Vistazo (`can`), its button's name (`label`), and doing it (`toggle`). */
export type DoorControls = { can: (door: DoorView) => boolean; label: (door: DoorView) => string; toggle: (door: DoorView) => void };

/**
 * A door's button: the door, its element and what it shows (`look`), where it is (scene px, grid units
 * up), on screen, how big a cell looks there, shown, and past a wall (undefined: not worked out, it
 * couldn't show).
 */
type DoorButton = { door: DoorView; el: HTMLButtonElement; look: string; x: number; y: number; z: number; screen: { x: number; y: number }; cellPx: number; shown: boolean; behind?: boolean };

/** How near the pointer (px) a door's button shows whole. */
const DOOR_NEAR_PX = 70;
/** A box of the view (view units), where some of the picture changed (see VistazoView.touch). */
type PartBox = { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number };
/** How long the picture's kept to draw parts of it again (see VistazoView.draw) after the last part. */
const PART_KEEP_MS = 800;

/** Kept on this device once it's found slow (see trackMotion): edges not smoothed (see wantsSmooth). */
const SLOW_DEVICE = "rising-ranges/slow-device";
/** A device whose frames take longer than this (ms) on average, moving, over this many of them, is slow. */
const SLOW_FRAME_MS = 40;
const SLOW_FRAMES = 30;

/** Frames closer than this (ms): moving (see trackMotion). Still this long: drawn sharp again. */
const MOTION_GAP_MS = 250;
const MOTION_SETTLE_MS = 300;
/** Frames slower than this (ms) lose sharpness while moving; faster than that, they get it back. */
const MOTION_SLOW_MS = 28;
const MOTION_FAST_MS = 18;

/** How far (cells) a dropped token slides to its place; farther, it's just there (a jump across the map). */
const SLIDE_MAX_CELLS = 40;
/** A cell's size on screen (px) where door buttons start to show, and where they're whole. */
const DOOR_FADE: [number, number] = [26, 46];

/** A door's button's icons: shut, and open (its leaf swung out of its frame). */
const DOOR_SHUT_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3 21h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="15" cy="12.5" r="1.3" fill="currentColor"/></svg>';
const DOOR_OPEN_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" opacity=".45"/><path d="M6 3.5l7 2.5v15.5l-7-1.5z" fill="currentColor" fill-opacity=".25" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3 21h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="11" cy="13" r="1.2" fill="currentColor"/></svg>';

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
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null;
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
  /**
   * The flat props' videos (webm), one per file however many props show it (see propVideo): its element,
   * its texture once it has a frame, and the props' materials waiting for that. Drawn again on each new
   * frame of theirs (see watchVideo).
   */
  private propVideos = new Map<string, PropVideo>();
  /**
   * The flat props' GIFs (and animated WebPs), one per file as the videos (see propAnimation): read as an
   * animation, its texture; or still (not one, or unreadable so), drawn as an image.
   */
  private propAnimations = new Map<string, PropAnimation>();
  /** The frame last drawn in (its time, see drawSoon). */
  private drawnAt = -1;
  /**
   * What's changed in the picture since it was drawn (see draw): everything, only what's in a box
   * (view units: a dragged token's base, the Bandas round it), or nothing (null).
   */
  private dirty: PartBox | "all" | null = "all";
  /** The camera drawn last (its camVersion): another, everything's drawn again. */
  private drawnCam = -1;
  /**
   * While parts alone change (a token dragged): the picture kept in a target of its own, drawn again
   * only within those parts' place on screen, then copied to the canvas (see draw). Let go a moment
   * after the last such part.
   */
  private kept: { target: THREE.WebGLRenderTarget; renderer: THREE.WebGLRenderer; copy: THREE.Mesh; scene: THREE.Scene; w: number; h: number } | null = null;
  private partAt = -Infinity;
  /** The Bandas' box last drawn (see buildReach): where their rings were, drawn again once they move. */
  private reachBox: PartBox | null = null;
  private reachLook = "";
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
  /** What the doors were last built from (see setDoors). */
  private doorsKey = "";
  /** The camera's matrix as last worked out, and what from (see camMatrix); counted each time it changes. */
  private camKept: { panX: number; panY: number; s: number; tilt: number; yaw: number; cx: number; cy: number; cz: number; persp: number; m: DOMMatrix; eye: DOMPoint } | null = null;
  private camVersion = 0;
  private readonly projected = { x: 0, y: 0, z: 0 };
  /** Lines of sight between tokens worked out (see inSight), by where both are and the terrain. */
  private readonly sights = new Map<string, boolean>();
  /** Each distance line's elements, by its token, and what they were last given (see drawLines). */
  private readonly lineEls = new Map<string, { group: SVGGElement; back: SVGLineElement; front: SVGLineElement; text: SVGTextElement; written: string }>();
  /** What each marker's element was last given (see placeOne): written again only when it changes. */
  private readonly written = new WeakMap<TokenView, { transform: string; z: string; visible: string; css: string; turn: string; hiddenFor: string; hidden: boolean }>();
  /** Drawn again frame after frame (see trackMotion): moving, how much of the sharpness it keeps, its frames' gaps. */
  private motion = { on: false, scale: 1, last: 0, since: 0, settle: 0, gaps: [] as number[], cam: -1 };
  /** Whether the renderer smooths edges (see wantsSmooth); a long run of moving frames' gaps, to tell a slow device. */
  private smooth = true;
  private longGaps: number[] = [];
  /** Tokens sliding to where they've been dropped (see moveTokens), and the frame that moves them on. */
  private slides = new Map<TokenView, { from: Token; to: Token; t0: number; ms: number }>();
  private slideFrame = 0;
  /** Who may open or shut which door, and how (see setDoorControls); null: no buttons. */
  private doorControls: DoorControls | null = null;
  /** Each door's button, over its doorway's middle (see placeDoorButtons). */
  private doorButtons: DoorButton[] = [];
  /** The eye where the door buttons were last placed (see placeDoorButtons): to tell one's past a wall when the pointer nears it. */
  private doorEye: DOMPoint | null = null;
  /** The door buttons' own layer (the tokens' is rebuilt whole). */
  private readonly doorOverlay: HTMLElement;
  /** Where the pointer is over the stage (px), for the door buttons near it; null: off it. */
  private pointerAt: { x: number; y: number } | null = null;
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
  /** The one animation loop (videos, weather, water, templates): its frame, and whether a video has a new frame to show (see animate). */
  private animFrame = 0;
  private animDue = false;
  /** When the loop last drew (rAF time): kept across its stops, so a video restarting it still waits its pace. */
  private animLast = -Infinity;
  /** The player view's fog: its picture (see drawFog), laid on the terrain by its materials (see fogged). */
  private fogTexture: THREE.CanvasTexture | null = null;
  /** The fog's floor and curtains (see buildFogFloor). */
  private fogFloor: THREE.Group | null = null;
  /** The fog's materials (see fogMaterials). */
  private fogMaterialSet: { floor: THREE.MeshBasicMaterial; curtain: THREE.MeshBasicMaterial; lid: THREE.MeshBasicMaterial } | null = null;
  /** Each fog edge's curtain and lid (positions), by the edge, for the terrain they were worked out on (see buildFogFloor). */
  private curtains: { owner: string; edges: Map<string, [number[], number[]]> } = { owner: "", edges: new Map() };
  /** Counts the terrain's changes (built, reheighted, shapes moved): what was worked out from it is stale. */
  private terrainEdits = 0;
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
  /** The maps put together on the graphics card (see MapComposer): the ground's texture, unless a lone map is its own. */
  private composer: MapComposer | null = null;
  /**
   * The last one, while the next is made: its texture still on the meshes (shown till the new one's
   * there, as a canvas's was), let go once they're all built again (see build).
   */
  private retiredComposer: MapComposer | null = null;
  /** The detail's texture, its box in the ground's and whether there's one: shared by every material that reads the map (see DETAIL_GLSL). */
  private readonly detailUniforms = {
    uDetail: { value: null as THREE.Texture | null },
    uDetailUv: { value: new THREE.Vector4(0, 0, 1, 1) },
    uDetailOn: { value: 0 },
    uMapPremultiplied: { value: 0 },
  };
  /** The detail made again once the camera's still (see scheduleDetail): its timer, since when it's waited, the camera it's for. */
  private detailTimer = 0;
  private detailSince = 0;
  private detailCam = -1;
  /** When the camera last moved (the detail's full blocks asked for once it's still: see updateDetail), and the check then. */
  private camMovedAt = 0;
  private sharpTimer = 0;
  /** The flat props' shaders compiled ahead (see compileProps): its timer. */
  private propsCompile = 0;
  /** The grid drawn over the ground (see gridded): shared by its materials, so a change needs no rebuild. */
  private readonly gridUniforms = {
    uGridKind: { value: 0 },
    uGridDpi: { value: 1 },
    uGridCenter: { value: new THREE.Vector2() },
    uGridU: { value: 1 },
  };
  /** Bumped when the video maps start or stop (their frame callbacks see they're stale). */
  private mapsPlaying = 0;
  /** The maps' new frames waiting to be put together (see composeFrames): any, and a video's among them. */
  private mapFrameDue = false;
  private mapVideoDue = false;
  /** A lone video map played as the ground's texture itself (see useTexture): none of it drawn again. */
  private directVideo: HTMLVideoElement | null = null;
  /** Then, its first frame still: for what reads the map by its own reckoning (water, mirrored fills). */
  private stillTexture: THREE.Texture | null = null;
  /** The materials of the pieces, to dim or see through without rebuilding. */
  private pieceMaterials: THREE.MeshBasicMaterial[] = [];
  /** The same, as a set (a pooled one's in the list once). */
  private pieceMaterialSet = new Set<THREE.MeshBasicMaterial>();
  /** Pieces' materials shared and kept from build to build, by what they're made with (see pieceMaterial). */
  private materialPool = new Map<string, { material: THREE.MeshBasicMaterial; used: number }>();
  /**
   * What the terrain's materials work out now, besides the bases (see layers): the Bandas, the clouds'
   * shadows, the fog.
   * Left out of their shaders when off (a slow graphics card pays for them even then).
   */
  private layersOn = { bands: false, clouds: false, fog: false };
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
  /** Bridges' fills worked out away from the page (see fillJob); which call of buildUnderBridges is the last. */
  private readonly fills = new FillJobs();
  private underRound = 0;
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
    this.smooth = this.wantsSmooth();
    this.renderer = this.makeRenderer(this.canvas, this.smooth);
    this.glCamera.matrixAutoUpdate = false;
    this.movingGroup.matrixAutoUpdate = false;
    this.world.add(this.terrainGroup, this.underGroup, this.movingGroup, this.pickGroup, this.edgeGroup, this.tokenGroup, this.weatherGroup, this.underBridgeGroup, this.waterGroup, this.templateGroup, this.doorGroup);
    this.overlay = document.createElement("div");
    this.overlay.className = "ov";
    this.lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.lines.classList.add("lines");
    this.tokenOverlay = document.createElement("div");
    this.doorOverlay = document.createElement("div");
    this.overlay.append(this.lines, this.tokenOverlay, this.doorOverlay);
    stage.prepend(this.canvas, this.overlay);
    // The door buttons near the pointer show (see showDoorButtons): no drawing for it.
    stage.addEventListener("pointermove", (event) => {
      const r = this.overlay.getBoundingClientRect();
      this.pointerAt = { x: event.clientX - r.left, y: event.clientY - r.top };
      this.showDoorButtons();
    });
    stage.addEventListener("pointerleave", () => {
      this.pointerAt = null;
      this.showDoorButtons();
    });
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
    this.terrainEdits++;
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
      // Drawn by its outline alone, and now its heights vary inside it (painted on, a soft edge over it),
      // or drawn lean (few triangles, none where the brush may paint): cut small, there and then.
      if (!mesh.userData.fine && !(near.max.x < x0 || near.min.x > x1 || near.max.y < y0 || near.min.y > y1) && (mesh.userData.lean || piece.fine?.())) {
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
        mesh.userData.lean = false;
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
    this.terrainEdits++;
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
    this.terrainEdits++;
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

  /**
   * `slide`: the tokens moved in it slide there from where they were (a drop on the map, which Owlbear
   * only tells once it's done), all but those in `except` (shown where they are as they're dragged).
   */
  setScene(scene: VistazoScene, slide?: { except: Set<string> }) {
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
      if (!time("3d.moveTokens", () => this.moveTokens(scene, slide?.except))) {
        time("3d.tokens", () => this.buildTokens());
        this.dirty = "all";
      }
      // The grid changed in Owlbear (square to hex, the hex cells moved): the ground's lines follow.
      this.syncGrid();
      this.updateWeather();
      // Only what moved drawn again (see touch), unless something else changed.
      this.requestApply(true);
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
    const look = `${this.options.ringFill}|${this.options.rings}|${r?.shape}`;
    if (look !== this.reachLook) {
      // Drawn otherwise everywhere they are: all of it again.
      this.reachLook = look;
      this.dirty = "all";
    }
    f.uFillTint.value = this.options.ringFill ? 1 : 0;
    f.uFillRings.value = this.options.rings ? 1 : 0;
    // Where they were drawn: drawn again there (and where they go, below).
    if (this.reachBox) {
      this.touch(this.reachBox);
      this.reachBox = null;
    }
    if (!r || !scene || !show) {
      f.uFillBands.value = 0;
      this.setLayers({ bands: false });
      this.requestApply(true);
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
    if (list.length > 0) {
      // As far as the last Banda reaches (cells; hexes a little farther), from the farthest of its cells.
      const u = this.u;
      const spread = Math.max(0, ...cells.map((cell) => Math.hypot(cell.x, cell.y)));
      const far = ((Math.max(...list.map((band) => band.across)) + 2) * 1.2 + spread) * dpi * u;
      this.reachBox = { x0: r.x * u - far, y0: r.y * u - far, x1: r.x * u + far, y1: r.y * u + far, z0: (this.minH - 1) * this.k, z1: (this.maxH + 1) * this.k };
      this.touch(this.reachBox);
    }
    this.requestApply(true);
  }

  /** The terrain's materials with the Bandas or the fog in their shaders or not (see layersOn): only when that changes. */
  private setLayers(on: Partial<VistazoView["layersOn"]>) {
    const next = { ...this.layersOn, ...on };
    if (next.bands === this.layersOn.bands && next.clouds === this.layersOn.clouds && next.fog === this.layersOn.fog) {
      return;
    }
    this.layersOn = next;
    this.dirty = "all";
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
        time("3d.fog", () => this.drawFog());
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
    const materials = this.fogMaterials();
    for (const material of Object.values(materials)) {
      material.color.set(fog.color);
    }
    const group = new THREE.Group();
    const { x0, y0, x1, y1 } = scene.bounds;
    // Only where the terrain isn't drawn (a pit by the fog, or under a light's soft edge, shows); the
    // curtains reach well below it, so at a fog shape's sharp edge (its texels blur it) no gap shows.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry((x1 - x0) * u, (y1 - y0) * u), materials.floor);
    floor.position.set(((x0 + x1) / 2) * u, ((y0 + y1) / 2) * u, 0);
    group.add(floor);
    const fogged = time("3d.fog.fogged", () => foggedOf(fog, scene.world));
    // Each edge's curtain kept for the next time: a light moving changes its own outline, not the rooms'.
    // Good while the terrain is the same (see terrainEdits; not the scene object: a token dragged makes a
    // new one each frame): an edge the same, its fog on the same side, has the same ground beside it
    // (anything new near it would have cut it).
    const owner = `${this.terrainEdits},${u},${k},${this.minH}`;
    if (this.curtains.owner !== owner) {
      this.curtains = { owner, edges: new Map() };
    }
    const kept = this.curtains.edges;
    const edges = new Map<string, [number[], number[]]>();
    // With the stopwatch on (see timing.ts): where the curtains' time goes, and how much there is.
    const watch = { t0: timingOn ? performance.now() : 0, fresh: 0, heights: 0, heightMs: 0 };
    if (fogged && fogged.length > 0) {
      const step = scene.dpi * 0.25;
      const near = scene.dpi * 0.05;
      // The fog cuts what's drawn by its picture, a few texels a square (see drawFog): along the curtain's
      // top that cut wanders a little either side of the edge, and where it falls short, the cut top of a
      // wall leaves a hole into its hollow. A lid of the fog's colour over the curtain's clear side, drawn
      // only where the picture hides (so never over what shows), closes it.
      const texel = 1 / Math.min(1024 / Math.max(x1 - x0 || 1, y1 - y0 || 1), 16 / scene.dpi);
      const lid = Math.max(scene.dpi * 0.1, texel * 2);
      // The ground's height just off the edge on its clear side (0 off the map; null: neither side
      // clear), that side asked first.
      const clearHeight = (x: number, y: number, nx: number, ny: number, first: number): number | null => {
        if (timingOn) {
          watch.heights++;
          const t = performance.now();
          const h = clearHeightNow(x, y, nx, ny, first);
          watch.heightMs += performance.now() - t;
          return h;
        }
        return clearHeightNow(x, y, nx, ny, first);
      };
      const clearHeightNow = (x: number, y: number, nx: number, ny: number, first: number): number | null => {
        for (const side of [first, -first]) {
          const [qx, qy] = [x + nx * near * side, y + ny * near * side];
          if (!fog.at(qx, qy)) {
            // Over a doorway, as high as its wall: the doorway's cut isn't seen through into the fog.
            return Math.max(scene.heightAt(qx, qy) ?? 0, scene.doorwayTop?.(qx, qy) ?? -Infinity);
          }
        }
        return null;
      };
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
            // Its clear side (its lid's too).
            const clear = fog.at((ax + bx) / 2 + nx * near, (ay + by) / 2 + ny * near) ? -1 : 1;
            const key = `${ax},${ay},${bx},${by},${clear}`;
            const known = kept.get(key) ?? edges.get(key);
            if (known) {
              edges.set(key, known);
              continue;
            }
            const positions: number[] = [];
            const lids: number[] = [];
            edges.set(key, [positions, lids]);
            watch.fresh++;
            const [cx, cy] = [nx * lid * clear, ny * lid * clear];
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
              if (h > 0) {
                const [x2, y2, x3, y3] = [x1 + cx, y1 + cy, x0 + cx, y0 + cy];
                lids.push(x0 * u, y0 * u, hi, x1 * u, y1 * u, hi, x2 * u, y2 * u, hi, x0 * u, y0 * u, hi, x2 * u, y2 * u, hi, x3 * u, y3 * u, hi);
              }
            };
            let last: [number, number, number | null] | null = null;
            // At a corner, read a little inside the edge: straight off its end lies on the next edge,
            // fog on both sides, and the curtain's last stretch would be missing (a gap into the wall).
            const inset = Math.min(near, length / 2) / length;
            for (let j = 0; j <= n; j++) {
              const [x, y] = [ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n];
              const f = Math.min(Math.max(j / n, inset), 1 - inset);
              const h = clearHeight(ax + (bx - ax) * f, ay + (by - ay) * f, nx, ny, clear);
              if (last) {
                const [lx, ly, lh] = last;
                let [t0, t1] = [0, 1];
                if (h !== null && lh !== null && Math.abs(h - lh) > 1e-3) {
                  for (let it = 0; it < 7; it++) {
                    const t = (t0 + t1) / 2;
                    const mh = clearHeight(lx + (x - lx) * t, ly + (y - ly) * t, nx, ny, clear) ?? 0;
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
    }
    this.curtains.edges = edges;
    if (timingOn) {
      record("3d.fog.edges", performance.now() - watch.t0);
      record("3d.fog.edges.heights", watch.heightMs);
      record("3d.fog.n edges (avg = count)", edges.size);
      record("3d.fog.n new edges (avg = count)", watch.fresh);
      record("3d.fog.n heights read (avg = count)", watch.heights);
      watch.t0 = performance.now();
    }
    let floats = 0;
    for (const [which, material] of [[0, materials.curtain], [1, materials.lid]] as const) {
      let size = 0;
      for (const edge of edges.values()) {
        size += edge[which].length;
      }
      if (size === 0) {
        continue;
      }
      floats += size;
      const all = new Float32Array(size);
      let at = 0;
      for (const edge of edges.values()) {
        all.set(edge[which], at);
        at += edge[which].length;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(all, 3));
      group.add(new THREE.Mesh(geometry, material));
    }
    this.fogFloor = group;
    this.world.add(group);
    if (timingOn) {
      record("3d.fog.merge", performance.now() - watch.t0);
      record("3d.fog.n floats (avg = count)", floats);
    }
  }

  /** The fog floor's, curtains' and lids' materials: made once (the floor is redone as lights move). */
  private fogMaterials() {
    if (!this.fogMaterialSet) {
      const make = (cut: boolean) => {
        const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
        if (cut) {
          layer(material, "fogfloor", this.fogUniforms, FOG_GLSL, "if (!fogHidden(vLayerAt.xy)) discard;");
        }
        return material;
      };
      this.fogMaterialSet = { floor: make(true), curtain: make(false), lid: make(true) };
    }
    return this.fogMaterialSet;
  }

  private dropFogFloor() {
    if (!this.fogFloor) {
      return;
    }
    this.world.remove(this.fogFloor);
    this.fogFloor.traverse((child) => {
      (child as THREE.Mesh).geometry?.dispose();
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
    // Played or still: the ground's texture drawn again, at its size for that. Put together on the card:
    // again at the quality's sizes (see SOURCE_BUDGET, FULL_BUDGET, DETAIL_SIZE).
    if ((replay && this.scene?.maps.some((map) => map.video)) || (resharpen && (this.composer || this.retiredComposer))) {
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
      this.drawSoon();
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
  private paintBases(part = false) {
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
    this.requestApply(part);
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
    // The old maps' videos stopped (played, they'd go on decoding unseen).
    this.mapMedia?.images.forEach(stopMedia);
    this.mapMedia = null;
    this.mapsPlaying++;
    this.texture = null;
    this.dropMapTextures();
    // The one shown kept till the meshes are built again (one still loading: the one shown is the retired one, kept).
    if (this.composer) {
      this.retiredComposer?.dispose();
      this.retiredComposer = this.composer;
      this.composer = null;
    }
    if (scene.maps.length === 0) {
      return;
    }
    const { x0, y0, x1, y1 } = scene.bounds;
    const w = x1 - x0;
    const h = y1 - y0;
    const draw = (images: CanvasImageSource[], maps: MapImage[], px: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(w * px));
      canvas.height = Math.max(1, Math.ceil(h * px));
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.imageSmoothingQuality = "high";
      images.forEach((img, index) => {
        const map = maps[index];
        context.setTransform(new DOMMatrix().scale(px).translate(-x0, -y0).multiply(new DOMMatrix(map.transform)));
        // At the size the item says (the file may be another size).
        context.drawImage(img, 0, 0, map.width, map.height);
      });
      return { canvas, context };
    };
    // The videos, animations and composer made below, till they're handed over (or let go): let go
    // if anything fails on the way, not left playing.
    let pendingMedia: CanvasImageSource[] = [];
    const loadStart = stamp();
    let pendingComposer: MapComposer | null = null;
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
          }).catch((error) => {
            // One that can't be read (CORS, gone): left out, the rest drawn.
            console.warn(`Rising Ranges: Vistazo couldn't read a map image, leaving it out (${map.url})`, error);
            return null;
          })
      )
    )
      .then(async (loaded) => {
        // Those read, with their maps (in order).
        const maps = scene.maps.filter((_, i) => loaded[i] !== null);
        const read = loaded.filter((img): img is CanvasImageSource => img !== null);
        pendingMedia = read;
        since("map.1 images read", loadStart);
        if (read.length === 0) {
          throw new Error("none of the map images could be read");
        }
        // Animated ones (GIF, WebP): their frames on a canvas each, in their place (see AnimatedImage).
        const images: CanvasImageSource[] = await Promise.all(
          read.map(async (img, i) => (img instanceof HTMLImageElement && mayAnimate(maps[i].mime) ? ((await AnimatedImage.open(maps[i].url, maps[i].mime))?.canvas ?? img) : img))
        );
        pendingMedia = images;
        since("map.2 animations read", loadStart);
        // In steps, the page let go between them (each is long on a slow machine): another map's
        // meanwhile, this one's dropped.
        const pause = () => new Promise((resolve) => setTimeout(resolve));
        // Another map's meanwhile: these videos and animations let go.
        const stale = () => {
          if (key === this.colorsFor) return false;
          images.forEach(stopMedia);
          return true;
        };
        if (stale()) {
          return;
        }
        // A video map played (or an animated one): a smaller texture, drawn again every frame.
        const played = this.options.videoMaps && (maps.some((map) => map.video) || images.some((img) => animationOf(img) !== null));
        const cap = played ? (this.options.quality === "high" ? VIDEO_TEXTURE_MAX : VIDEO_TEXTURE_LIGHT) : TEXTURE_MAX;
        const most = Math.min(cap, this.renderer?.capabilities.maxTextureSize ?? TEXTURE_MAX);
        // A lone map (an image, or a video's first frame): its picture itself, made the graphics card's
        // size by the browser (off the page's own work), placed by its texture's transform; not drawn again
        // on a canvas as big (see placed).
        const lone = images.length === 1 && (images[0] instanceof HTMLImageElement || images[0] instanceof HTMLVideoElement) ? images[0] : null;
        // More than one: put together on the graphics card, each at its file's density (as much as the
        // texture's size lets for the whole box), not one scene px a texel at most as on a canvas.
        // A lone image too: its detail where the camera is (see updateDetail). Not a lone video played:
        // its frames go straight to the card (see useTexture).
        let composer: MapComposer | null = null;
        if (!(lone instanceof HTMLVideoElement && played) && this.renderer) {
          const media = images as MapMedia[];
          // The small blocks within the quality's budget (their files' where the camera looks: see
          // MapComposer.sharpen); the ground's texture small (seen past the detail only); the detail as big
          // as a texture over the map was, videos or not (a new frame draws only where they are).
          const quality = this.options.quality;
          const px = sourceDensity(maps, media, SOURCE_BUDGET[quality] ?? SOURCE_BUDGET.high) || 1;
          const basePx = Math.min(px, Math.min(BASE_TEXTURE_MAX, most) / Math.max(w, h));
          const detailSize = Math.min(DETAIL_SIZE[quality] ?? DETAIL_SIZE.high, this.renderer.capabilities.maxTextureSize);
          const fullBudget = FULL_BUDGET[quality] ?? FULL_BUDGET.high;
          let made: MapComposer | null = null;
          const makeStart = stamp();
          made = await MapComposer.make(maps, media, { x0, y0, w, h }, { px, basePx, detailSize, fullBudget }, this.renderer.capabilities.getMaxAnisotropy(), () => this.sharpened(made));
          composer = made;
          pendingComposer = made;
          since("map.3 composer made", makeStart);
          if (stale()) {
            composer?.dispose();
            return;
          }
        }
        const smallPx = Math.min(1, 1024 / Math.max(w, h));
        const small = time("map.4 small", () => (composer && this.renderer ? smallFrom(composer, this.renderer, w, h, smallPx) : draw(images, maps, smallPx)));
        const pixels = { data: small.context.getImageData(0, 0, small.canvas.width, small.canvas.height).data, w: small.canvas.width, h: small.canvas.height };
        const colors: MapColors = { x0, y0, w, h, small: pixels, soft: time("map.5 soft", () => softPixels(small.canvas, w, h, scene.dpi)) };
        this.mapColors = colors;
        this.colors = (x, y) => colorAt(colors, x, y);
        // The doors that take the map's colours, in them now.
        this.buildDoors();
        this.softColors = (x, y) => softColorAt(colors, x, y);
        await pause();
        if (stale()) {
          composer?.dispose();
          return;
        }
        if (composer && this.renderer) {
          const renderer = this.renderer;
          time("map.6 compose", () => composer!.compose(renderer));
          composer.busy = () => performance.now() - this.camMovedAt < STILL_MS;
          this.composer = composer;
          // Its detail for the camera now, before it's first shown.
          this.updateDetail(true);
          since("map.7 all (to detail)", loadStart);
          // The small one for what's read on the page (see fillPixels: the composer's, where there's one).
          this.texture = { canvas: small.canvas, x0, y0, w, h };
          this.mapMedia = { images, maps };
          pendingMedia = [];
          pendingComposer = null;
          this.fillCache.clear();
          this.useTexture();
          // The water, the walls' shadows and what's under bridges a moment later (as below).
          this.deferExtras = true;
          this.build();
          this.playMaps();
          return;
        }
        composer?.dispose();
        pendingComposer = null;
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
        const big = bitmap ? small : draw(images, maps, Math.min(1, most / Math.max(w, h)));
        await pause();
        if (stale()) {
          bitmap?.close();
          return;
        }
        this.texture?.bitmap?.close();
        this.texture = { canvas: big.canvas, x0, y0, w, h, ...(bitmap ? { bitmap } : {}) };
        this.mapMedia = { images, maps };
        pendingMedia = [];
        this.fillCache.clear();
        this.useTexture();
        // The water, the walls' shadows and what's under bridges (its fill, from this map) a moment later.
        // Kept till that build draws (with the worker: once its terrain's back).
        this.deferExtras = true;
        this.build();
        this.playMaps();
      })
      .catch((error) => {
        pendingMedia.forEach(stopMedia);
        if (pendingComposer && pendingComposer !== this.composer) {
          pendingComposer.dispose();
        }
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
    } else if (this.composer) {
      // Drawn on the graphics card (its size, its mipmaps and their sharpness: see MapComposer).
      map = this.composer.texture;
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
    // Drawn again every frame: no smaller copies worked out each time (as costly as sending it). The
    // composer's is set up so already.
    if (played && !this.composer) {
      map.generateMipmaps = false;
      map.minFilter = THREE.LinearFilter;
    }
    for (const material of this.pieceMaterials) {
      if (material.userData.mapTextured) {
        material.map = material.userData.mapTextured === "plain" ? this.plainTexture : map;
        material.needsUpdate = true;
      }
    }

    this.syncDetail();
    // The doors that take the map's picture, with it now.
    this.buildDoors();
    this.dirty = "all";
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
    // The composer's is let go with it (see loadColors).
    if (this.mapTexture && !this.composer?.owns(this.mapTexture)) {
      this.mapTexture.dispose();
    }
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
          // A pooled one's kept for the next build (see pieceMaterial).
          if (m.userData.pooled) {
            return;
          }
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

  /**
   * A top's or wall's material; `top`: the bases are painted on it (see based; a slab's, "deck").
   * `pooled`: shared by every piece it suits and kept from one build to the next (see materialPool), for
   * a caller that doesn't change it after: a new material is worked out by three.js again (its shader
   * rewritten, its program looked up), which over every piece of every build of a drag costs.
   */
  private pieceMaterial(height: number, textured: boolean, fill?: [number, number, number], top: boolean | "deck" = false, pooled = false): THREE.MeshBasicMaterial {
    const poolKey = pooled ? `${height}|${textured}|${fill?.join(",") ?? ""}|${top}|${this.options.tint}|${this.options.relief}|${this.minH}|${this.maxH}|${textured ? (this.mapTexture?.uuid ?? "") : ""}` : "";
    if (pooled) {
      const known = this.materialPool.get(poolKey);
      if (known) {
        known.used = this.builds;
        if (!this.pieceMaterialSet.has(known.material)) {
          this.pieceMaterialSet.add(known.material);
          this.pieceMaterials.push(known.material);
        }
        this.layers(known.material);
        return known.material;
      }
    }
    const span = this.maxH - this.minH || 1;
    // Lower ground a little darker: the highest keeps its own color, the lowest up to relief × 50% darker.
    // The range is the terrain's (minH/maxH, from the pieces): a slab's top over all of it falls past it,
    // a little lighter, up to another span over the highest; no further, which would wash a map texture
    // out to white. That lightening a little stronger from the slider's middle up: +25% at 50%, +65% at 100%.
    const along = Math.min(2, Math.max(0, (height - this.minH) / span));
    const relief = this.options.relief;
    const lit = along <= 1 ? 1 - relief * 0.5 * (1 - along) : 1 + relief * 0.5 * (1 + 0.6 * Math.max(0, relief - 0.5)) * (along - 1);
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
      detailed(material, this.detailUniforms);
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
    this.pieceMaterialSet.add(material);
    if (pooled) {
      material.userData.pooled = true;
      this.materialPool.set(poolKey, { material, used: this.builds });
    }
    return material;
  }

  /** The pooled materials no build has used for a while (see pieceMaterial), let go. */
  private prunePool() {
    for (const [key, entry] of this.materialPool) {
      if (entry.used < this.builds - 2) {
        this.materialPool.delete(key);
        this.retired.push(entry.material);
      }
    }
  }

  /** The grid over the ground as the options and Owlbear's grid have it (none, square, hex flat-topped or pointy). */
  private syncGrid() {
    const scene = this.scene;
    const g = this.gridUniforms;
    const hex = scene?.hexGrid;
    const was = `${g.uGridKind.value}|${g.uGridDpi.value}|${g.uGridCenter.value.x},${g.uGridCenter.value.y}|${g.uGridU.value}`;
    g.uGridKind.value = !scene || !this.options.grid ? 0 : hex ? (hex.shape === "hexHorizontal" ? 2 : 3) : scene.squareGrid ? 1 : 0;
    g.uGridDpi.value = scene?.dpi ?? 1;
    g.uGridCenter.value.set(hex?.center.x ?? 0, hex?.center.y ?? 0);
    g.uGridU.value = this.u;
    this.fillUniforms.uFillU.value = this.u;
    if (was !== `${g.uGridKind.value}|${g.uGridDpi.value}|${g.uGridCenter.value.x},${g.uGridCenter.value.y}|${g.uGridU.value}`) {
      this.dirty = "all";
    }
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
      if (fromMap) {
        detailed(material, this.detailUniforms);
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
    this.terrainEdits++;
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
    this.pieceMaterialSet = new Set();
    this.prunePool();
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
    // No mesh left on the last map texture (all built again here on the one there is now, or put off to
    // be: see firstDraw): let go.
    this.retiredComposer?.dispose();
    this.retiredComposer = null;
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
    // This call's: a fill that comes back after another's begun is kept, not drawn (that one draws it).
    const round = ++this.underRound;
    for (const group of groups) {
      const members = group.members.map((i) => scene.bridges[i]).filter((bridge) => bridge);
      if (members.length === 0) {
        continue;
      }
      const key = JSON.stringify(group.shape);
      const kept = this.fillCache.get(key);
      if (kept) {
        kept.used = this.builds;
        this.drawUnder(group, members, kept, texture);
        continue;
      }
      // Worked out away from the page (the map's pixels read here): drawn when it's back.
      const composer = this.composer;
      const renderer = this.renderer;
      const read = fillPixels(group.shape, texture, scene.dpi * FILL_GROW, composer && renderer ? (box, cols, rows) => composer.read(renderer, box, cols, rows) : undefined);
      if (!read) {
        continue;
      }
      void this.fills.ask(group.shape, read.bytes, read.frame, scene.dpi * FILL_GROW).then((made) => {
        if (!made) {
          return;
        }
        const entry = { ...made, used: this.builds };
        this.fillCache.set(key, entry);
        if (round === this.underRound && this.texture === texture) {
          this.drawUnder(group, members, entry, texture);
          this.requestApply();
        }
      });
    }
  }

  /** A group of bridges' fill under them, drawn (see buildUnderBridges). */
  private drawUnder(group: TerrainBuffers["undersides"][number], members: Bridge[], kept: BridgeFill, texture: Texture) {
    const map = this.stillTexture ?? this.mapTexture;
    if (!map) {
      return;
    }
    {
      // A mirroring one is alone in its group: its own frame.
      const bridge = members[0];
      const { center, along, across, halfAlong, halfAcross } = bridge.frame;
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
          uMap: { value: map },
          uMapMatrix: { value: map.matrix },
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
        return;
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
    const deck = new THREE.Mesh(top, this.pieceMaterial(bridge.top, true, undefined, "deck", true));
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
    // The map's picture on it: read as the ground reads it (sharper where the camera is, straight: see detailed).
    if (skin) {
      detailed(belly.material as THREE.MeshBasicMaterial, this.detailUniforms);
    }
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
            : (() => {
                const material = new THREE.MeshBasicMaterial({
                  map: skin || mapped ? this.plainTexture : plain ? null : patternTexture(kind),
                  color: skin || mapped ? new THREE.Color(0.85, 0.85, 0.85) : tint(0.85),
                  side: THREE.DoubleSide,
                });
                // The map's picture on it: read as the ground reads it (see detailed).
                return skin || mapped ? detailed(material, this.detailUniforms) : material;
              })(),
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
      const mesh = new THREE.Mesh(geometry, this.pieceMaterial(piece.height, true, undefined, true, true));
      mesh.position.z = built.z;
      // Its corners can be moved up or down where they are (see reheight); drawn with fewer triangles
      // (lean), not till it's cut small again there.
      mesh.userData.piece = piece;
      mesh.userData.fine = built.fine && !built.lean;
      mesh.userData.lean = built.lean;
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
    this.slides.clear();
    const scene = this.scene;
    if (!scene) {
      return;
    }
    this.clear(this.tokenGroup);
    // The flat props' videos kept for those that show them still (see propVideo); the materials that
    // waited for one's first frame are gone.
    const videosUsed = new Set<string>();
    for (const entry of this.propVideos.values()) {
      entry.waiting = [];
    }
    const animationsUsed = new Set<string>();
    for (const entry of this.propAnimations.values()) {
      entry.waiting = [];
    }
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
    // The flat props drawn in a set order (transparent, they don't hide one another by depth; left to
    // their distance from the camera, one over another's middle would come and go as it turns): higher
    // ones over lower, and at the same height as Owlbear stacks them (the scene's order).
    const props = shown === "none" ? [] : scene.props;
    const stacked = props.map((prop, i) => ({ prop, i })).sort((a, b) => a.prop.terrain + a.prop.own - (b.prop.terrain + b.prop.own) || a.i - b.i);
    const stackOf = new Map(stacked.map(({ prop }, at) => [prop, at]));
    for (const prop of props) {
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
          // On the card now, its shader compiled ahead: not when it first comes into view (a stutter).
          this.renderer?.initTexture(texture);
          this.compileProps();
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
          videosUsed.add(prop.url);
          this.propVideo(prop.url, show);
        } else if (mayAnimate(prop.mime)) {
          // Playing on the ground if it's animated (a GIF), as on the map; or still, an image.
          animationsUsed.add(prop.url);
          this.propAnimation(prop.url, prop.mime, show, () => loader.load(prop.url, show));
        } else {
          loader.load(prop.url, show);
        }
        mesh = new THREE.Mesh(this.propQuad(prop, zTok + 0.6), material);
        // Between the shadows (1) and what's drawn over the props (3).
        mesh.renderOrder = 2 + (stackOf.get(prop) ?? 0) / (props.length + 1);
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
    // The flat props' videos no prop shows now let go.
    for (const [url, entry] of this.propVideos) {
      if (!videosUsed.has(url)) {
        stopVideo(entry.video);
        entry.texture?.dispose();
        this.propVideos.delete(url);
      }
    }
    for (const [url, entry] of this.propAnimations) {
      if (!animationsUsed.has(url)) {
        entry.animation?.close();
        entry.texture?.dispose();
        this.propAnimations.delete(url);
      }
    }
    // The old standing tokens' and props' videos stopped (off the page they'd pause, but hold on till collected).
    this.tokenOverlay.querySelectorAll("video").forEach(stopVideo);
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
   * The tokens' and props' shaders compiled in the background (a prop's picture given it after it's
   * built): those out of view too, compiled now, not as they come into it.
   */
  private compileProps() {
    if (this.propsCompile) {
      return;
    }
    this.propsCompile = window.setTimeout(() => {
      this.propsCompile = 0;
      void this.renderer?.compileAsync(this.tokenGroup, this.glCamera, this.world).catch(() => {});
    }, PROPS_COMPILE_MS);
  }

  /**
   * A flat prop's video, its texture to `show` once it has a frame: one element and one texture for
   * every prop with the same file (one decoder, not one each), kept from one build to the next.
   */
  private propVideo(url: string, show: (texture: THREE.Texture) => void) {
    let entry = this.propVideos.get(url);
    if (!entry) {
      const video = mediaElement(url, true) as HTMLVideoElement;
      const made: PropVideo = { video, texture: null, waiting: [] };
      entry = made;
      this.propVideos.set(url, made);
      video.onloadeddata = () => {
        if (this.propVideos.get(url) !== made || made.texture) {
          return;
        }
        const texture = new THREE.VideoTexture(video);
        // Shared by the props that show it: not let go with one's material (see clear).
        texture.userData.shared = true;
        made.texture = texture;
        made.waiting.splice(0).forEach((wait) => wait(texture));
        this.watchVideo(url, made);
        if (this.paused) {
          video.pause();
        }
      };
    }
    if (entry.texture) {
      show(entry.texture);
    } else {
      entry.waiting.push(show);
    }
  }

  /**
   * A flat prop's GIF (or WebP), its texture to `show` once it's read as an animation (one canvas and
   * texture for every prop with the same file, kept from one build to the next, as a video's); `still`
   * if it isn't one (or can't be read so): drawn as an image then.
   */
  private propAnimation(url: string, mime: string, show: (texture: THREE.Texture) => void, still: () => void) {
    let entry = this.propAnimations.get(url);
    if (!entry) {
      const made: PropAnimation = { animation: null, texture: null, still: false, waiting: [] };
      entry = made;
      this.propAnimations.set(url, made);
      void AnimatedImage.open(url, mime).then((animation) => {
        if (this.propAnimations.get(url) !== made) {
          animation?.close();
          return;
        }
        const waiting = made.waiting.splice(0);
        if (!animation) {
          made.still = true;
          waiting.forEach((wait) => wait.still());
          return;
        }
        const texture = new THREE.CanvasTexture(animation.canvas);
        // Shared by the props that show it: not let go with one's material (see clear).
        texture.userData.shared = true;
        made.animation = animation;
        made.texture = texture;
        // Drawn again on each new frame (see requestRender: at the quality's pace).
        animation.onFrame = () => {
          texture.needsUpdate = true;
          this.requestRender();
        };
        waiting.forEach((wait) => wait.show(texture));
        // Minimized, or at low quality: still (see pauseVideos).
        if (!this.paused && this.moving) {
          animation.play();
        }
      });
    }
    if (entry.texture) {
      show(entry.texture);
    } else if (entry.still) {
      still();
    } else {
      entry.waiting.push({ show, still });
    }
  }

  /**
   * The view only draws when something changes; a video on the ground
   * changes with each of its frames, so it asks to be drawn again on each
   * new one (see requestRender: at the quality's pace), until it's let go.
   */
  private watchVideo(url: string, entry: { video: HTMLVideoElement }) {
    const onFrame = () => {
      if (this.propVideos.get(url) !== entry) {
        return;
      }
      this.requestRender();
      entry.video.requestVideoFrameCallback(onFrame);
    };
    entry.video.requestVideoFrameCallback(onFrame);
  }

  /**
   * The video maps (and animated ones: GIFs) played on the ground (with the option on, not minimized):
   * at each new frame of theirs, the ground's texture drawn again from all the maps (the grid over them)
   * and sent to the graphics card. Otherwise still, at the frame they're on.
   */
  private playMaps() {
    const media = this.mapMedia;
    const texture = this.texture;
    const run = ++this.mapsPlaying;
    const videos = (media?.images ?? []).filter((img): img is HTMLVideoElement => img instanceof HTMLVideoElement);
    const animations = (media?.images ?? []).map(animationOf).filter((animation): animation is AnimatedImage => animation !== null);
    if (!media || !texture || (videos.length === 0 && animations.length === 0)) {
      return;
    }
    if (!this.options.videoMaps || this.paused) {
      videos.forEach((video) => video.pause());
      animations.forEach((animation) => animation.pause());
      return;
    }
    const context = texture.canvas.getContext("2d")!;
    const px = texture.canvas.width / texture.w;
    let last = 0;
    // A new frame of one (a video's or an animation's): drawn. False once these maps aren't the ground's.
    const frame = (fromVideo: boolean) => {
      if (run !== this.mapsPlaying || !this.mapTexture) {
        return false;
      }
      // Put together on the graphics card: noted, and put together once before the scene's next drawing
      // (see composeFrames), at the animation's pace (see animate). Every video's and animation's new
      // frames in it, none lost to another's.
      if (this.composer && this.renderer && !this.directVideo) {
        this.mapVideoDue ||= fromVideo;
        this.mapFrameDue = true;
        this.requestRender();
        return true;
      }
      // At medium or low quality, 15 frames a second at most (the scene drawn again with each).
      const now = performance.now();
      if (this.options.quality !== "high" && now - last < 1000 / 15 - 2) {
        return true;
      }
      last = now;
      // Straight from the video: only the scene drawn again.
      if (this.directVideo) {
        this.mapTexture.needsUpdate = true;
        this.requestRender();
        return true;
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
      return true;
    };
    for (const video of videos) {
      video.loop = true;
      void video.play().catch(() => {});
    }
    if (videos.length > 0) {
      const onVideo = () => {
        if (frame(true)) {
          videos[0].requestVideoFrameCallback(onVideo);
        }
      };
      videos[0].requestVideoFrameCallback(onVideo);
    }
    for (const animation of animations) {
      animation.onFrame = () => {
        if (!frame(false)) {
          animation.pause();
        }
      };
      animation.play();
    }
  }

  /**
   * The maps' new frames (see playMaps) put together on the graphics card, once for all of them, just
   * before the scene's drawn: only where they are (see MapComposer.compose).
   */
  private composeFrames() {
    if (!this.mapFrameDue) {
      return;
    }
    const videos = this.mapVideoDue;
    this.mapFrameDue = false;
    this.mapVideoDue = false;
    const composer = this.composer;
    const renderer = this.renderer;
    if (composer && renderer && this.mapTexture === composer.texture) {
      time("3d.mapFrames", () => composer.compose(renderer, { videos }));
    }
  }

  /** The picture drawn again on the animation loop's next step (see animate), however many videos ask. */
  private requestRender() {
    this.animDue = true;
    this.animate();
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
    this.dirty = "all";
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

  /** The reliefs' doors, open or shut as their fog doors are. */
  setDoors(doors: DoorView[]) {
    // The same as drawn (most scene refreshes): nothing built again, nothing drawn. Built again too when
    // what they stand on changed (the terrain, its scale).
    const key = `${this.u}|${this.k}|${this.terrainKey}|${this.terrainEdits}|${JSON.stringify(doors)}`;
    if (key === this.doorsKey) {
      return;
    }
    this.doorsKey = key;
    this.doors = doors;
    this.buildDoors();
    this.buildDoorButtons();
    this.requestApply();
  }

  /** Who may open or shut which door, and how: a button over each such door, shown near the pointer. */
  setDoorControls(controls: DoorControls | null) {
    this.doorControls = controls;
    this.buildDoorButtons();
    this.requestApply();
  }

  private buildDoorButtons() {
    const controls = this.doorControls;
    const scene = this.scene;
    const kept = new Map(this.doorButtons.map((b) => [b.door.key, b]));
    this.doorButtons = [];
    if (controls && scene) {
      for (const door of this.doors) {
        if (!controls.can(door)) {
          continue;
        }
        // The same button kept, as it was, where it was (shown; focused: Enter again shuts what it
        // opened), only what changed written: not hidden till the next frame (it'd blink as a click
        // changes its door), nor moved in the page (it'd lose its focus).
        const before = kept.get(door.key);
        kept.delete(door.key);
        const el = before?.el ?? document.createElement("button");
        if (!before) {
          el.type = "button";
          el.className = "doorbtn";
          el.onpointerdown = (event) => event.stopPropagation();
          this.doorOverlay.append(el);
        }
        const label = controls.label(door);
        const look = `${door.open}|${label}`;
        if (before?.look !== look) {
          el.classList.toggle("open", door.open);
          el.innerHTML = door.open ? DOOR_OPEN_ICON : DOOR_SHUT_ICON;
          el.setAttribute("aria-label", label);
          el.title = label;
        }
        el.onclick = (event) => {
          event.stopPropagation();
          controls.toggle(door);
        };
        const [mx, my] = [(door.a.x + door.b.x) / 2, (door.a.y + door.b.y) / 2];
        // On its lintel: its doorway's top over its floor, a little up (clear of the leaf). Its floor read
        // beside it, not in it: a doorway left as wall (the player view's, see DoorView.panel) reads the
        // wall's top there.
        const len = Math.hypot(door.b.x - door.a.x, door.b.y - door.a.y) || 1;
        const [nx, ny] = [(-(door.b.y - door.a.y) / len) * door.cell * 0.6, ((door.b.x - door.a.x) / len) * door.cell * 0.6];
        const sides = [scene.heightAt(mx + nx, my + ny), scene.heightAt(mx - nx, my - ny)].filter((h): h is number => h !== undefined);
        const floor = sides.length > 0 ? Math.min(...sides) : (scene.heightAt(mx, my) ?? 0);
        this.doorButtons.push({ door, el, look, x: mx, y: my, z: floor + door.h + 0.15, screen: before?.screen ?? { x: 0, y: 0 }, cellPx: before?.cellPx ?? 0, shown: before?.shown ?? false, behind: before?.behind });
      }
    }
    for (const gone of kept.values()) {
      gone.el.remove();
    }
  }

  /** The door buttons where their doors are on screen (with the tokens: see apply). */
  private placeDoorButtons(camM: DOMMatrix, eye: DOMPoint) {
    const u = this.u;
    const k = this.k;
    for (const button of this.doorButtons) {
      const { door } = button;
      const p = this.project(camM, button.x * u, button.y * u, button.z * k);
      const f = this.persp / Math.max(1, this.persp - p.z);
      button.screen = { x: this.width / 2 + p.x * f, y: this.height / 2 + p.y * f };
      // How close it's seen, the same for every door: a cell's size on screen where it is (not its
      // doorway's, which a narrow door, or one seen edge on, would make look far).
      button.cellPx = door.cell * u * this.fit * this.camera.zoom * f;
      button.el.style.transform = `translate(${button.screen.x}px,${button.screen.y}px)`;
      // Behind the eye: never. Past a wall: worked out only for one that could show (seen close
      // enough, or the pointer near it: see showDoorButtons), not for every door every frame.
      button.behind = this.persp - p.z <= 1 ? true : button.cellPx > DOOR_FADE[0] ? this.doorBehind(button, eye) : undefined;
    }
    this.doorEye = eye;
    this.showDoorButtons();
  }

  /** Whether a wall stands between a door's button and the eye (not its own: from a cell out on the eye's side). */
  private doorBehind(button: DoorButton, eye: DOMPoint): boolean {
    const { door } = button;
    const u = this.u;
    const len = Math.hypot(door.b.x - door.a.x, door.b.y - door.a.y) || 1;
    const [nx, ny] = [-(door.b.y - door.a.y) / len, (door.b.x - door.a.x) / len];
    const toward = Math.sign((eye.x / u - button.x) * nx + (eye.y / u - button.y) * ny) || 1;
    const out = door.cell * 0.6 * toward;
    return this.blocked((button.x + nx * out) * u, (button.y + ny * out) * u, button.z * this.k, eye);
  }

  /**
   * Each door button as clear as the camera's close (every door alike: fading out between DOOR_FADE's
   * cell sizes on screen), whole near the pointer, out of the way behind a wall (focus still shows one).
   */
  private showDoorButtons() {
    const at = this.pointerAt;
    const [far, close] = DOOR_FADE;
    for (const button of this.doorButtons) {
      const near = !!at && Math.hypot(at.x - button.screen.x, at.y - button.screen.y) < DOOR_NEAR_PX;
      if (near && button.behind === undefined && this.doorEye) {
        button.behind = this.doorBehind(button, this.doorEye);
      }
      const seen = Math.min(1, Math.max(0, (button.cellPx - far) / (close - far)));
      const clear = button.behind !== false ? 0 : near ? 1 : seen;
      const value = clear.toFixed(2);
      if (button.el.style.getPropertyValue("--clear") !== value) {
        button.el.style.setProperty("--clear", value);
      }
      // Out of the keyboard's way behind a wall (a far one, faded, still takes it: focus shows it).
      const tab = button.behind === true ? -1 : 0;
      if (button.el.tabIndex !== tab) {
        button.el.tabIndex = tab;
      }
      // Clicked only once there to see.
      const shown = clear >= 0.5;
      if (shown !== button.shown) {
        button.shown = shown;
        button.el.classList.toggle("shown", shown);
      }
    }
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
      picture: (material) => detailed(material, this.detailUniforms),
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
      const surface = new THREE.Mesh(this.shapeGeometry(kept.shape), fogCutShader(waterMaterial(this.stillTexture ?? this.mapTexture, t, this.u, scene.dpi, kept.reach, this.detailUniforms), this.fogUniforms, "vAt"));
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

  /** The weather (and the water, the templates) moving while the panel shows: see animate. */
  private playWeather() {
    this.animate();
  }

  /**
   * The one loop for all that moves by itself: the weather's time, and the videos' new frames (each
   * asks, see requestRender), drawn together at the quality's pace at most (QUALITY.frameMs), not once
   * per video frame. The weather's particles move on the GPU, so only their time changes. Stops when
   * nothing's left to move.
   */
  private animate() {
    if (this.animFrame) {
      return;
    }
    const tick = (time: number) => {
      const weather = !this.paused && this.hasWeather;
      if (!weather && !this.animDue) {
        this.animFrame = 0;
        return;
      }
      // A couple of ms early is on time (frames don't land exactly on the pace).
      if (time - this.animLast >= this.look.frameMs - 2) {
        this.animLast = time;
        this.animDue = false;
        if (weather) {
          this.weatherUniforms();
        }
        this.drawSoon();
      }
      this.animFrame = requestAnimationFrame(tick);
    };
    this.animFrame = requestAnimationFrame(tick);
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

  // ---------- The map's detail ----------

  /**
   * The detail made again for the camera once it's still a moment (or every half second while it goes
   * on moving): drawing it is a few milliseconds on the card, not worth each frame of a drag.
   */
  private scheduleDetail() {
    this.detailCam = this.camVersion;
    const now = performance.now();
    this.camMovedAt = now;
    if (!this.detailTimer) {
      this.detailSince = now;
    }
    window.clearTimeout(this.detailTimer);
    this.detailTimer = window.setTimeout(() => this.updateDetail(), now - this.detailSince >= 500 ? 0 : 150);
  }

  /**
   * The map's detail for the camera: the part it shows (see viewBox) drawn as sharp as the detail's
   * texture lets (see detailBoxFor), unless the one there covers it as sharp already (`force`: made all
   * the same, a new map's). Then drawn.
   */
  private updateDetail(force = false) {
    window.clearTimeout(this.detailTimer);
    this.detailTimer = 0;
    const composer = this.composer;
    const renderer = this.renderer;
    if (!composer || !renderer || !this.scene || this.width === 0) {
      this.syncDetail();
      return;
    }
    this.detailCam = this.camVersion;
    // Moving: drawn with the blocks there are; their full pictures asked for once it's still a moment
    // (sending them to the card while it moves, it stutters).
    const still = force || performance.now() - this.camMovedAt >= STILL_MS;
    window.clearTimeout(this.sharpTimer);
    if (!still) {
      this.sharpTimer = window.setTimeout(() => {
        if (performance.now() - this.camMovedAt >= STILL_MS) {
          this.updateDetail();
        }
      }, STILL_MS + 10);
    }
    const view = clipBox(this.viewBox(), composer.box);
    // Nothing of the map to read (the camera under the ground, or looking off it): the detail there kept,
    // for when it's back (not one for the ground seen so slanting from below it's all far off).
    if (!view && !force) {
      return;
    }
    const want = view ? detailBoxFor(view, composer) : null;
    const shown = composer.shown?.box ?? null;
    // The one there covers what's seen near (the screen's lower half: slanting, a turn moves its far part
    // a lot, seen small), at least three quarters as sharp as it would be made: kept.
    const near = clipBox(this.viewBox(true), composer.box) ?? view;
    const kept = !!want && !!shown && !!near && inside(near, shown) && shown.w <= want.w / 0.75;
    if (!force && (kept || (!want && !shown))) {
      if (still) {
        composer.sharpenShown();
      }
      return;
    }
    time("3d.detail", () => composer.detail(renderer, want, still));
    this.syncDetail();
    this.dirty = "all";
    this.render();
  }

  /** The detail's uniforms as the composer's detail is (off if the ground's texture isn't its: a lone video's, a canvas's). */
  private syncDetail() {
    const uniforms = this.detailUniforms;
    const composer = this.composer;
    const shown = composer?.shown;
    // The composer's textures are premultiplied (see MapComposer); a lone video's, a canvas's aren't.
    const composed = !!composer && this.mapTexture === composer.texture;
    uniforms.uMapPremultiplied.value = composed ? 1 : 0;
    if (!composer || !shown || !composed) {
      uniforms.uDetailOn.value = 0;
      uniforms.uDetail.value = null;
      return;
    }
    const b = composer.box;
    const d = shown.box;
    uniforms.uDetail.value = shown.texture;
    // The ground's uv: x across its box, y up from its bottom (see uvsOver).
    uniforms.uDetailUv.value.set((d.x0 - b.x0) / b.w, (b.y0 + b.h - (d.y0 + d.h)) / b.h, d.w / b.w, d.h / b.h);
    uniforms.uDetailOn.value = 1;
  }

  /**
   * What the camera shows of the ground (at height 0), scene px: where rays through the screen (a 5 x 5
   * grid of points over it) meet it. Those past the horizon left out; those far off (a slanting view's
   * top) brought in to twice the screen's size where it looks, beyond which the ground's own texture is
   * as sharp as it's seen.
   */
  private viewBox(near = false): MapBox | null {
    const m = this.camMatrix();
    const inv = m.inverse();
    const eye = inv.transformPoint(new DOMPoint(0, 0, this.persp));
    // Under the ground: what it shows of it from below isn't read sharper.
    if (eye.z <= 0) {
      return null;
    }
    const u = this.u;
    // A point on the screen (px from its middle) is where q = (sx, sy, 0) through the camera is.
    const hit = (sx: number, sy: number): [number, number] | null => {
      const s = inv.transformPoint(new DOMPoint(sx, sy, 0));
      const dz = s.z - eye.z;
      if (Math.abs(dz) < 1e-9) {
        return null;
      }
      const t = -eye.z / dz;
      return t > 0 ? [(eye.x + t * (s.x - eye.x)) / u, (eye.y + t * (s.y - eye.y)) / u] : null;
    };
    const [W, H] = [this.width, this.height];
    const c = hit(0, 0);
    const right = hit(W / 2, 0);
    if (!c || !right) {
      return null;
    }
    const reach = 2 * Math.max(1, H / W) * Math.hypot(right[0] - c[0], right[1] - c[1]);
    if (!(reach > 0)) {
      return null;
    }
    let [x0, y0, x1, y1] = [c[0], c[1], c[0], c[1]];
    for (const fx of [-0.5, -0.25, 0, 0.25, 0.5]) {
      for (const fy of near ? [0, 0.25, 0.5] : [-0.5, -0.25, 0, 0.25, 0.5]) {
        const p = hit(fx * W, fy * H);
        if (!p) {
          continue;
        }
        const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
        const k = d > reach ? reach / d : 1;
        const [x, y] = [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k];
        [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      }
    }
    return { x0, y0, w: x1 - x0, h: y1 - y0 };
  }

  /** The detail drawn sharper on its own (its blocks' files loaded, see MapComposer.sharpen): shown, if it's still the map's. */
  private sharpened(composer: MapComposer | null) {
    if (!composer || composer !== this.composer) {
      return;
    }
    this.dirty = "all";
    this.render();
  }

  /** A WebGL renderer on a canvas, its edges smoothed (multisampled) or not. Null without WebGL. */
  private makeRenderer(canvas: HTMLCanvasElement, smooth: boolean): THREE.WebGLRenderer | null {
    try {
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: smooth, alpha: true });
      renderer.setPixelRatio(Math.min(this.look.pixels, window.devicePixelRatio || 1));
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      // The map's edge's walls cut at the ground (see apply).
      renderer.localClippingEnabled = true;
      return renderer;
    } catch (error) {
      console.error("Rising Ranges: Vistazo couldn't start WebGL", error);
      return null;
    }
  }

  /**
   * Whether edges are smoothed (multisampled): as the quality has it, unless this device was found slow
   * (see trackMotion): on a weak graphics card smoothing costs as much as all the rest (twice, on a
   * sharp screen).
   */
  private wantsSmooth(): boolean {
    let slow = false;
    try {
      // Found slow at a quality that gives that up (not high: smoothed as chosen).
      slow = this.look.slow && localStorage.getItem(SLOW_DEVICE) === "1";
    } catch {
      // Not kept: as the quality says.
    }
    return this.look.smooth && !slow;
  }

  /**
   * Edges smoothed or not as wanted now: if that changed, a new canvas and renderer in place of the old
   * (it's chosen when a canvas's WebGL starts: no changing it after); what's drawn goes to the new one
   * by itself (three.js sends each renderer what it lacks), its shaders made again.
   */
  private resmooth() {
    const smooth = this.wantsSmooth();
    if (smooth === this.smooth || !this.renderer) {
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.className = "gl";
    const renderer = this.makeRenderer(canvas, smooth);
    if (!renderer) {
      return;
    }
    this.smooth = smooth;
    const old = this.renderer;
    this.canvas.replaceWith(canvas);
    this.canvas = canvas;
    this.renderer = renderer;
    // What's drawn on the old card's targets isn't on the new one: the map put together again there.
    this.composer?.compose(renderer);
    this.canvasSize = { w: 0, h: 0 };
    this.retired.splice(0).forEach((material) => material.dispose());
    old.dispose();
    old.forceContextLoss();
    this.measure();
  }

  /** The canvas's sharpness for the quality now (redrawn at it). */
  private sharpen() {
    this.resmooth();
    this.renderer?.setPixelRatio(this.pixelRatio());
    this.canvasSize = { w: 0, h: 0 };
    this.pauseVideos();
  }

  /** Device pixels to a screen pixel now: the quality's, less while something moves on a slow card (see trackMotion). */
  private pixelRatio(): number {
    const full = Math.min(this.look.pixels, window.devicePixelRatio || 1);
    // Never under the quality's least (another quality chosen meanwhile: its own).
    return this.motion.on ? Math.max(0.35, full * Math.max(this.look.least, this.motion.scale)) : full;
  }

  /**
   * Drawn again frame after frame (the camera, a drag): moving. Then the picture's drawn with fewer
   * pixels if frames come slow (a weak graphics card: most of its time is each pixel's), as few as it
   * takes to keep up (half each way at least: a quarter of them); still for a moment, it's drawn sharp
   * again. A card that keeps up never loses any. Only the camera's moving counts: something moved over
   * a still picture (a token dragged, a shape) keeps it sharp (blurred all over, it shows; and it's
   * drawn again only where it moved, see draw).
   */
  private trackMotion() {
    const m = this.motion;
    this.camMatrix();
    if (this.camVersion === m.cam) {
      return;
    }
    m.cam = this.camVersion;
    const now = performance.now();
    const gap = now - m.last;
    m.last = now;
    clearTimeout(m.settle);
    m.settle = window.setTimeout(() => {
      m.on = false;
      m.gaps = [];
      this.setRatio();
      this.requestApply();
    }, MOTION_SETTLE_MS);
    if (gap > MOTION_GAP_MS) {
      return;
    }
    if (!m.on) {
      m.on = true;
      m.since = now;
      this.setRatio();
    }
    m.gaps.push(gap);
    if (m.gaps.length > 12) {
      m.gaps.shift();
    }
    // A slow device (frames well over 40 ms, moving, for a while: the opening's tilt in tells it): its edges
    // no longer smoothed, from now on and next time too (see wantsSmooth).
    if (this.smooth && this.look.slow) {
      this.longGaps.push(gap);
      if (this.longGaps.length >= SLOW_FRAMES) {
        const mean = this.longGaps.reduce((a, b) => a + b, 0) / this.longGaps.length;
        this.longGaps = [];
        if (mean > SLOW_FRAME_MS) {
          try {
            localStorage.setItem(SLOW_DEVICE, "1");
          } catch {
            // Not kept: this time only.
          }
          this.resmooth();
        }
      }
    }
    // Judged on a few frames, not too often (each change sizes the canvas again).
    if (m.gaps.length >= 6 && now - m.since > 300) {
      const mean = m.gaps.reduce((a, b) => a + b, 0) / m.gaps.length;
      const next = mean > MOTION_SLOW_MS ? Math.max(this.look.least, m.scale * 0.75) : mean < MOTION_FAST_MS ? Math.min(1, m.scale * 1.2) : m.scale;
      if (next !== m.scale) {
        m.scale = next;
        m.since = now;
        m.gaps = [];
        this.setRatio();
      }
    }
  }

  /** The canvas at the sharpness for now (see pixelRatio), sized again only if that changed. */
  private setRatio() {
    const ratio = this.pixelRatio();
    if (this.renderer && Math.abs(this.renderer.getPixelRatio() - ratio) > 1e-3) {
      this.renderer.setPixelRatio(ratio);
    }
  }

  private pauseVideos() {
    const videos = [...this.stage.querySelectorAll("video"), ...[...this.propVideos.values()].map((entry) => entry.video)];
    for (const video of videos) {
      // Minimized, or at low quality: still.
      if (this.paused || !this.moving) {
        video.pause();
      } else {
        void video.play().catch(() => {});
      }
    }
    for (const { animation } of this.propAnimations.values()) {
      if (this.paused || !this.moving) {
        animation?.pause();
      } else {
        animation?.play();
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
  private moveTokens(scene: VistazoScene, slideExcept?: Set<string>): boolean {
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
        this.dirty = "all";
      }
    }
    const byId = new Map(scene.tokens.map((token) => [token.id, token]));
    // A footprint changed: its base is drawn again at its new size.
    if (views.some((view) => !byId.has(view.token.id) || raised(view.token) !== raised(byId.get(view.token.id)!) || (view.token.own < 0) !== (byId.get(view.token.id)!.own < 0) || view.token.radius !== byId.get(view.token.id)!.radius)) {
      return false;
    }
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const view of views) {
      const token = byId.get(view.token.id)!;
      const moved = token.x !== view.token.x || token.y !== view.token.y || token.own !== view.token.own || token.terrain !== view.token.terrain;
      view.el.classList.toggle("gmhidden", token.hidden);
      // Sliding there already (the scene drawn again meanwhile): left to get there, not started over.
      const sliding = this.slides.get(view);
      if (sliding && sliding.to.x === token.x && sliding.to.y === token.y && sliding.to.own === token.own && sliding.to.terrain === token.terrain) {
        sliding.to = token;
        continue;
      }
      // Sliding elsewhere: on from where it's got to.
      const from = view.token;
      this.slides.delete(view);
      view.token = token;
      if (!moved) {
        continue;
      }
      const far = Math.hypot(token.x - from.x, token.y - from.y) / scene.dpi;
      if (slideExcept && !slideExcept.has(token.id) && !reduced && far > 0.1 && far < SLIDE_MAX_CELLS) {
        // From where it was shown, a moment (longer the farther), easing in.
        this.slides.set(view, { from, to: token, t0: performance.now(), ms: Math.min(450, 160 + far * 40) });
        // Shown where it was till then (its token, read by the rest, as it's shown: see stepSlides).
        view.token = from;
        continue;
      }
      this.placeView(view, from);
    }
    if (this.slides.size > 0) {
      this.slideFrame ||= requestAnimationFrame(() => this.stepSlides());
    }
    if (this.basesMoved) {
      this.paintBases(true);
    }
    return true;
  }

  /** The tokens sliding to where they've been dropped, one frame further (see moveTokens). */
  private stepSlides() {
    this.slideFrame = 0;
    const now = performance.now();
    for (const [view, slide] of this.slides) {
      const t = Math.min(1, (now - slide.t0) / slide.ms);
      // Ease-out: quick off, settling in.
      const e = 1 - (1 - t) ** 3;
      const { from, to } = slide;
      const before = view.token;
      view.token = t >= 1 ? to : { ...to, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, terrain: from.terrain + (to.terrain - from.terrain) * e, own: from.own + (to.own - from.own) * e };
      this.placeView(view, before);
      if (t >= 1) {
        this.slides.delete(view);
      }
    }
    if (this.basesMoved) {
      this.paintBases(true);
    }
    if (this.slides.size > 0) {
      this.slideFrame = requestAnimationFrame(() => this.stepSlides());
    }
    this.requestApply(true);
  }

  /** A token's base, line and label where its token says (see moveTokens), from where it was (`from`): its marks drawn again in both places. */
  private placeView(view: TokenView, from: Token) {
    const u = this.u;
    const k = this.k;
    const token = view.token;
    this.touch(this.tokenBox(from, view.painted));
    this.touch(this.tokenBox(token, view.painted));
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

  /**
   * Everything that wants the picture redrawn in a frame, drawn once in it; `part`: only what's been
   * marked changed (see touch) wants it, the rest of the picture as it was.
   */
  requestApply(part = false) {
    if (!part) {
      this.dirty = "all";
    }
    if (!this.applyFrame) {
      this.applyFrame = requestAnimationFrame(() => {
        this.applyFrame = 0;
        this.applyNow();
      });
    }
  }

  /** A box (view units) of the picture changed: drawn again there, at least, next time. */
  private touch(box: PartBox) {
    const d = this.dirty;
    if (d === "all") {
      return;
    }
    this.dirty = d ? { x0: Math.min(d.x0, box.x0), y0: Math.min(d.y0, box.y0), z0: Math.min(d.z0, box.z0), x1: Math.max(d.x1, box.x1), y1: Math.max(d.y1, box.y1), z1: Math.max(d.z1, box.z1) } : { ...box };
  }

  /** Where a token's marks in 3D can be (view units): its base painted on any top under it, its line, its seat. */
  private tokenBox(token: Token, painted?: { r: number }): PartBox {
    const u = this.u;
    const k = this.k;
    const r = (Math.max(token.size / 2, Math.abs(painted?.r ?? 0)) + (this.scene?.dpi ?? 0) * 0.5) * u;
    return {
      x0: token.x * u - r,
      y0: token.y * u - r,
      x1: token.x * u + r,
      y1: token.y * u + r,
      z0: Math.min(this.minH - 1, floorOf(token)) * k,
      z1: Math.max(this.maxH * k, (token.terrain + token.own) * k + token.size * u),
    };
  }

  /** A box's place on screen (css px, padded), or null if some of it is behind the eye. */
  private onScreen(box: PartBox): { x0: number; y0: number; x1: number; y1: number } | null {
    const m = this.camMatrix();
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const q = this.project(m, c & 1 ? box.x1 : box.x0, c & 2 ? box.y1 : box.y0, c & 4 ? box.z1 : box.z0);
      const ahead = this.persp - q.z;
      if (ahead < 1) {
        return null;
      }
      const f = this.persp / ahead;
      const sx = this.width / 2 + q.x * f;
      const sy = this.height / 2 + q.y * f;
      [x0, y0, x1, y1] = [Math.min(x0, sx), Math.min(y0, sy), Math.max(x1, sx), Math.max(y1, sy)];
    }
    return { x0: x0 - 4, y0: y0 - 4, x1: x1 + 4, y1: y1 + 4 };
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
    // The same camera as last asked (most frames of a drag, and every pointer move): the same matrix,
    // not read again from a transform's text.
    const kept = this.camKept;
    if (kept && kept.panX === c.panX && kept.panY === c.panY && kept.s === s && kept.tilt === c.tilt && kept.yaw === c.yaw && kept.cx === cx && kept.cy === cy && kept.cz === cz && kept.persp === this.persp) {
      return kept.m;
    }
    const m = new DOMMatrix(
      `translate(${c.panX}px,${c.panY}px) scale3d(${s},${s},${s}) rotateX(${c.tilt}deg) rotateZ(${c.yaw}deg) ` +
        `translate3d(${-cx}px,${-cy}px,${-cz}px)`
    );
    const eye = m.inverse().transformPoint(new DOMPoint(0, 0, this.persp));
    this.camKept = { panX: c.panX, panY: c.panY, s, tilt: c.tilt, yaw: c.yaw, cx, cy, cz, persp: this.persp, m, eye };
    this.camVersion++;
    return m;
  }

  /** Where the eye is (view units), for the camera camMatrix last gave. */
  private eyeOf(): DOMPoint {
    this.camMatrix();
    return this.camKept!.eye;
  }

  /** A view point through the camera's matrix (affine: no new point made), into `projected`. */
  private project(m: DOMMatrix, x: number, y: number, z: number) {
    const q = this.projected;
    q.x = m.m11 * x + m.m21 * y + m.m31 * z + m.m41;
    q.y = m.m12 * x + m.m22 * y + m.m32 * z + m.m42;
    q.z = m.m13 * x + m.m23 * y + m.m33 * z + m.m43;
    return q;
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
      this.composeFrames();
      time("3d.render", () => this.draw());
      this.drawnAt = Number(document.timeline.currentTime ?? -1);
      if (this.composer && this.camVersion !== this.detailCam) {
        this.scheduleDetail();
      }
      for (const material of this.retired.splice(0)) {
        material.dispose();
      }
    }
  }

  /**
   * The picture drawn: whole, straight on the canvas; or, while only parts of it change (a token dragged:
   * its base, the Bandas round it; see touch), kept in a target of its own and drawn again there only
   * where they are on screen (old place and new), then copied over. What isn't a marked part (the
   * camera, the fog, anything built, what moves by itself) draws it whole, kept or not: nothing that
   * changed is left as it was. With weather (all over, always moving) it's drawn straight.
   */
  private draw() {
    const renderer = this.renderer!;
    const dirty = this.dirty;
    this.dirty = null;
    const now = performance.now();
    if (dirty && dirty !== "all") {
      this.partAt = now;
    }
    this.camMatrix();
    const camChanged = this.drawnCam !== this.camVersion;
    this.drawnCam = this.camVersion;
    if (now - this.partAt > PART_KEEP_MS || this.hasWeather) {
      this.letGoKept();
      renderer.render(this.world, this.glCamera);
      return;
    }
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    let kept = this.kept;
    let whole = dirty === "all" || camChanged;
    if (!kept || kept.renderer !== renderer || kept.w !== size.x || kept.h !== size.y) {
      this.letGoKept();
      const target = new THREE.WebGLRenderTarget(size.x, size.y, { samples: this.smooth ? 4 : 0, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
      const copy = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.ShaderMaterial({
          uniforms: { uKept: { value: target.texture } },
          vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
          fragmentShader: "uniform sampler2D uKept; varying vec2 vUv; void main() { gl_FragColor = texture2D(uKept, vUv); }",
          depthTest: false,
          depthWrite: false,
          blending: THREE.NoBlending,
        })
      );
      copy.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(copy);
      kept = this.kept = { target, renderer, copy, scene, w: size.x, h: size.y };
      whole = true;
    } else if (dirty === null && !whole) {
      // Nothing of it changed: the canvas shows it as it was.
      return;
    }
    const target = kept.target;
    if (!whole && dirty && dirty !== "all") {
      const box = this.onScreen(dirty);
      if (!box) {
        whole = true;
      } else {
        const pr = size.x / this.width;
        const x0 = Math.max(0, Math.floor(box.x0 * pr));
        const x1 = Math.min(size.x, Math.ceil(box.x1 * pr));
        const y0 = Math.max(0, Math.floor(box.y0 * pr));
        const y1 = Math.min(size.y, Math.ceil(box.y1 * pr));
        if (x1 <= x0 || y1 <= y0) {
          // Off screen: nothing to draw again.
          return;
        }
        // Most of it: all of it (a scissor saves nothing then).
        whole = (x1 - x0) * (y1 - y0) > 0.7 * size.x * size.y;
        // Scissors count from the bottom.
        target.scissor.set(x0, size.y - y1, x1 - x0, y1 - y0);
      }
    }
    target.scissorTest = !whole;
    renderer.setRenderTarget(target);
    renderer.render(this.world, this.glCamera);
    renderer.setRenderTarget(null);
    target.scissorTest = false;
    renderer.render(kept.scene, this.glCamera);
  }

  /** The kept picture (see draw) let go: drawn straight on the canvas again. */
  private letGoKept() {
    const kept = this.kept;
    if (!kept) {
      return;
    }
    this.kept = null;
    kept.target.dispose();
    kept.copy.geometry.dispose();
    (kept.copy.material as THREE.Material).dispose();
  }

  /**
   * For what moves by itself (a video's new frame, the weather, the water): drawn, unless the picture was
   * drawn in this frame already or the camera's about to draw it (see requestApply), which shows the
   * change too. Otherwise each would draw it again, the same frame.
   */
  private drawSoon() {
    // Drawn whole (in the frame's drawing, or now): what moves by itself is anywhere.
    this.dirty = "all";
    if (this.applyFrame || this.drawnAt === Number(document.timeline.currentTime ?? -2)) {
      return;
    }
    this.render();
  }

  /** Drawn now, all of it (from outside: whatever changed, the picture's drawn whole). */
  apply() {
    this.dirty = "all";
    this.applyNow();
  }

  private applyNow() {
    const scene = this.scene;
    const c = this.camera;
    if (!scene || this.width === 0) {
      this.onCamera();
      return;
    }
    this.trackMotion();
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
    const eye = this.eyeOf();
    const placed = stamp();
    for (const view of this.tokenViews) {
      this.placeOne(view, camM, eye, false);
    }
    if (this.point) {
      this.placeOne(this.point, camM, eye, true);
    }
    for (const view of this.handles) {
      this.placeOne(view, camM, eye, true);
    }
    since("3d.apply.tokens", placed);
    this.placeDoorButtons(camM, eye);
    this.drawLines();
    this.onCamera();
  }

  /**
   * A token's (or a marker's) element where it is on screen, its picture's size and its base: only what
   * changed written (each write makes the page work its styles out again). Whether the terrain hides it
   * from the eye: worked out again only when it, the camera or the terrain moved (a drag: the dragged
   * one, every frame; the others, kept).
   */
  private placeOne(view: TokenView, camM: DOMMatrix, eye: DOMPoint, marker: boolean) {
    const u = this.u;
    const s = this.fit * this.camera.zoom;
    const { token, el, disc, img, zTok } = view;
    const p = this.project(camM, token.x * u, token.y * u, zTok);
    const f = this.persp / Math.max(1, this.persp - p.z);
    // Lying flat, only its label is an element, on its middle; the free point's marker, easy to grab.
    const d = view.prop?.flat ? 0 : Math.max(marker ? 12 : 22, token.size * u * s * f);
    const sx = this.width / 2 + p.x * f;
    const sy = this.height / 2 + p.y * f;
    const pz = p.z;
    view.screen = { x: sx, y: sy };
    let w = this.written.get(view);
    if (!w) {
      w = { transform: "", z: "", visible: "?", css: "", turn: "", hiddenFor: "", hidden: false };
      this.written.set(view, w);
    }
    const transform = `translate(${sx}px,${sy}px)`;
    if (w.transform !== transform) {
      el.style.transform = w.transform = transform;
    }
    const z = String(10000 + Math.round(pz));
    if (w.z !== z) {
      el.style.zIndex = w.z = z;
    }
    // Behind the eye: not drawn.
    const visible = this.persp - pz > 1 ? "" : "hidden";
    if (w.visible !== visible) {
      el.style.visibility = w.visible = visible;
    }
    // The free point's marker sits on its point, whatever the anchor (it's no picture).
    const onBase = !marker && ((view.prop && !view.prop.flat) || this.options.anchor === "base");
    // By what of its picture shows (not its box, which may have empty margins or the figure off to
    // one side): what it stands on over the token's point, its bottom there on its base, or the
    // middle of what shows there (up and down) otherwise.
    // Set by hand (the Elevation menu's base), it's that point of its picture instead.
    const manual = view.prop?.flat || marker ? undefined : token.base;
    const measured = view.prop?.flat || marker ? undefined : visibleBox(token.url, token.video, () => this.requestApply());
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
    const css = `width:${d}px;height:${d}px;left:${left}px;top:${top}px;--gap:${gap}px;--u:${d / Math.max(1, token.size)}`;
    if (w.css !== css) {
      disc.style.cssText = w.css = css;
    }
    // Turned as on the map (not with the camera: that reads oddly on a standing token).
    const turn = `rotate(${token.rotation}deg) scale(${token.flipX ? -1 : 1},${token.flipY ? -1 : 1})`;
    if (w.turn !== turn) {
      img.style.transform = w.turn = turn;
    }
    const lift = onBase ? (token.size * u) / 2 : 0;
    const hiddenFor = `${this.camVersion}|${this.terrainEdits}|${token.x},${token.y},${zTok + lift}|${this.options.edges}`;
    if (w.hiddenFor !== hiddenFor) {
      w.hiddenFor = hiddenFor;
      w.hidden = this.blocked(token.x * u, token.y * u, zTok + lift + 4, eye);
      el.classList.toggle("hidden", w.hidden);
    }
    view.hidden = w.hidden;
  }

  /** The distance lines, from the origin token's point on screen to each other's, with their reading halfway. */
  private drawLines() {
    const svg = this.lines;
    const origin = this.distanceOrigin === FREE_POINT ? this.point : this.tokenViews.find((view) => view.token.id === this.distanceOrigin);
    const shown = new Set<string>();
    if (origin && this.options.distances) {
      for (const line of this.distanceLines) {
        const target = this.tokenViews.find((view) => view.token.id === line.id);
        if (!target) {
          continue;
        }
        shown.add(line.id);
        // Each line's elements made once and kept (only what changed written again: a frame moves them).
        let el = this.lineEls.get(line.id);
        if (!el) {
          const ns = "http://www.w3.org/2000/svg";
          const group = document.createElementNS(ns, "g");
          const back = document.createElementNS(ns, "line");
          const front = document.createElementNS(ns, "line");
          const text = document.createElementNS(ns, "text");
          back.setAttribute("class", "casing");
          group.append(back, front, text);
          el = { group, back, front, text, written: "" };
          this.lineEls.set(line.id, el);
        }
        if (el.group.parentNode !== svg) {
          svg.appendChild(el.group);
        }
        const { x: x1, y: y1 } = origin.screen;
        const { x: x2, y: y2 } = target.screen;
        // Hidden from the camera: dashed. Out of the origin's sight (the terrain between them): faint, dotted.
        const sight = this.inSight(origin, target) ? "" : " nosight";
        const label = this.options.distanceLabels === "none" ? "" : this.options.distanceLabels === "full" ? `${line.band} · ${line.distance}` : line.distance;
        const written = `${x1},${y1},${x2},${y2}|${target.hidden}|${sight}|${line.color}|${label}`;
        if (el.written === written) {
          continue;
        }
        el.written = written;
        el.group.setAttribute("class", (target.hidden ? "dline hidden" : "dline") + sight);
        for (const end of [el.back, el.front]) {
          end.setAttribute("x1", String(x1));
          end.setAttribute("y1", String(y1));
          end.setAttribute("x2", String(x2));
          end.setAttribute("y2", String(y2));
        }
        el.front.setAttribute("stroke", line.color);
        el.text.setAttribute("x", String((x1 + x2) / 2));
        el.text.setAttribute("y", String((y1 + y2) / 2));
        el.text.textContent = label;
        el.text.style.display = label ? "" : "none";
      }
    }
    for (const [id, el] of this.lineEls) {
      if (!shown.has(id)) {
        el.group.remove();
        this.lineEls.delete(id);
      }
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
    // Kept while both are where they were and the terrain's the same (not the camera's business).
    const key = `${this.terrainEdits}|${from.token.x},${from.token.y},${from.zTok}|${to.token.x},${to.token.y},${to.zTok}`;
    const known = this.sights.get(key);
    if (known !== undefined) {
      return known;
    }
    const seen = this.sightBetween(from, to);
    if (this.sights.size > 500) {
      this.sights.clear();
    }
    this.sights.set(key, seen);
    return seen;
  }

  /** Whether the terrain (or a slab) is between two tokens' eyes (see inSight). */
  private sightBetween(from: TokenView, to: TokenView): boolean {
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


/**
 * The map's pixels over a bridge's fill's box (see fillFromPixels, which works the fill out from them),
 * and the box's frame. Null if the map can't be read (the drawing is then left as it is).
 */
function fillPixels(
  shape: MultiPolygon,
  map: Texture,
  grow: number,
  reader?: (box: MapBox, cols: number, rows: number) => Uint8ClampedArray
): { bytes: Uint8ClampedArray; frame: FillFrame } | null {
  const frame = fillFrame(shape, grow);
  const { x0, y0, step, cols, rows } = frame;
  try {
    // The maps put together on the graphics card: read there, at the fill's own size.
    if (reader) {
      return { bytes: reader({ x0, y0, w: cols * step, h: rows * step }, cols, rows), frame };
    }
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = [cols, rows];
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const [kx, ky] = [map.canvas.width / map.w, map.canvas.height / map.h];
    ctx.drawImage(map.canvas, (x0 - map.x0) * kx, (y0 - map.y0) * ky, cols * step * kx, rows * step * ky, 0, 0, cols, rows);
    return { bytes: ctx.getImageData(0, 0, cols, rows).data, frame };
  } catch (error) {
    console.error("Rising Ranges: 3D Glance couldn't read the map under a slab, leaving its drawing", error);
    return null;
  }
}

/** How long the camera's been still to count as still, ms (see updateDetail). */
const STILL_MS = 150;

/** The props' shaders compiled once their pictures have come in for this long, ms (all of them at once, see compileProps). */
const PROPS_COMPILE_MS = 300;

/** `a` within `b` (scene px), or null where they don't meet. */
function clipBox(a: MapBox | null, b: MapBox): MapBox | null {
  if (!a) {
    return null;
  }
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x0 + a.w, b.x0 + b.w);
  const y1 = Math.min(a.y0 + a.h, b.y0 + b.h);
  return x1 > x0 && y1 > y0 ? { x0, y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Whether `a` is all within `b`. */
function inside(a: MapBox, b: MapBox): boolean {
  return a.x0 >= b.x0 && a.y0 >= b.y0 && a.x0 + a.w <= b.x0 + b.w && a.y0 + a.h <= b.y0 + b.h;
}

/**
 * The detail's box for what's seen (`view`, within the map's box): a square round it, a tenth more; no
 * smaller than the sources are sharp for (a smaller one shows nothing more), no bigger than the map's
 * box (all of it then: as sharp as one texture over the map was); kept within the map's box. Null when
 * it wouldn't be sharper than the ground's texture.
 */
function detailBoxFor(view: MapBox, composer: MapComposer): MapBox | null {
  const base = composer.box;
  const most = Math.max(base.w, base.h);
  const side = Math.min(most, Math.max(Math.max(view.w, view.h) * 1.1, composer.detailSize / composer.sharpest));
  if (composer.detailSize / side <= composer.baseDensity * 1.15) {
    return null;
  }
  // Along each way: centred on what's seen, moved back within the map's box; or, wider than it, centred on it.
  const place = (middle: number, from: number, length: number) => (side >= length ? from + length / 2 - side / 2 : Math.min(Math.max(middle - side / 2, from), from + length - side));
  return { x0: place(view.x0 + view.w / 2, base.x0, base.w), y0: place(view.y0 + view.h / 2, base.y0, base.h), w: side, h: side };
}

/**
 * The maps' small picture (for the walls' colours: see MapColors) read from the composer: the box from
 * its top left, `px` texels a scene px, on a canvas as a 2D drawing of them would be.
 */
function smallFrom(composer: MapComposer, renderer: THREE.WebGLRenderer, w: number, h: number, px: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w * px));
  canvas.height = Math.max(1, Math.ceil(h * px));
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const { x0, y0 } = composer.box;
  const pixels = composer.read(renderer, { x0, y0, w: canvas.width / px, h: canvas.height / px }, canvas.width, canvas.height);
  context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
  return { canvas, context };
}

/** The longest side of the ground's texture while a video map is played on it (drawn again every frame), px. */
const VIDEO_TEXTURE_MAX = 2048;
/** The same at medium or low quality. */
const VIDEO_TEXTURE_LIGHT = 1536;

/** A flat prop's video, shared by the props that show its file (see Renderer.propVideo). */
type PropVideo = { video: HTMLVideoElement; texture: THREE.VideoTexture | null; waiting: ((texture: THREE.Texture) => void)[] };

/** A flat prop's GIF (see propAnimation): its animation and texture once read, or `still` (an image). */
type PropAnimation = {
  animation: AnimatedImage | null;
  texture: THREE.CanvasTexture | null;
  still: boolean;
  waiting: { show: (texture: THREE.Texture) => void; still: () => void }[];
};

/** A map's media let go: a video stopped and emptied, an animation closed. */
function stopMedia(media: CanvasImageSource) {
  if (media instanceof HTMLVideoElement) {
    stopVideo(media);
  } else {
    stopAnimation(media);
  }
}

/** A surface's arrays as a three.js geometry (see surfaces.ts). */
function geometryOf(surface: Surface): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(surface.position, 3));
  if (surface.index) {
    geometry.setIndex(new THREE.BufferAttribute(surface.index, 1));
  }
  return geometry;
}

/**
 * A lone video map as the ground's texture: the video itself, placed by the
 * texture's transform where the map is in the texture's box (the ground's
 * uv: 0 to 1 across the box, up from its bottom). Turned, scaled, flipped:
 * the map's own transform undone, then over its size.
 */

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

/** How much a light clears at the very edge of its reach, at least: the fog's tint there is 96%, the terrain still seen. */
const LIT_EDGE = 0.04;

/** No picture: a clear pixel, for the fog's and the clouds' uniforms till there's one (see fogUniforms, cloudUniforms). */
const NO_FOG = (() => {
  const texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  texture.needsUpdate = true;
  return texture;
})();


/** The walls' look where their shape has none of its own (see buildWalls). */
