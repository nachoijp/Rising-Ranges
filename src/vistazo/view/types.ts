import type * as THREE from "three";
import type { BandShape } from "../../engine/types";
import type { TerrainSkin } from "../../terrain/terrain";
import type { Prop, Token } from "../scene";
import type { CloudStyle } from "../weather";
import type { BaseSeat } from "./bases";

// The Vistazo's view (see render.ts): its options, and the shapes and
// constants its parts share.

/** View px a cell: everything is drawn in view units, whatever the scene's dpi. */
export const VIEW_CELL = 50;

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
  /**
   * A token's labels: its name (Owlbear's label), its height, and where it stands ("full": all three;
   * "nameHeight": no where; "heightFull": no name; "height": the height alone; "name": the name alone).
   */
  tokenLabels: "full" | "nameHeight" | "heightFull" | "height" | "name" | "none";
  /** What a distance line says. */
  distanceLabels: "full" | "distance" | "none";
  /** The labels' size, 1 as designed. */
  labelSize: number;
  /** 0..1: higher ground a little lighter, and a soft shadow at the foot of the walls. */
  relief: number;
  /** The Props layer: lying on the ground as on the map, standing up like the tokens, or left out. */
  props: "flat" | "stand" | "none";
  /** The Weather extension's rain, snow, sand, embers, petals and clouds, drawn here (see weather.ts). */
  weather: boolean;
  /** Its clouds as a mist over the map, or their shadows on it. */
  clouds: CloudStyle;
  /** Zones' water moving (ripples, glints); still otherwise. */
  waterMotion: boolean;
  /** A video map played on the ground (its first frame, otherwise). */
  videoMaps: boolean;
  /**
   * How much the view asks of the device: high as designed; medium a little
   * less sharp on dense screens and lighter weather; low sharp only to the
   * screen's pixels, a third of the weather at fewer frames, water and
   * templates still and videos paused.
   */
  quality: Quality;
  /** Whether the props show at all ("none" above is how it was stored before this option). */
  showProps: boolean;
  /** The selected token's distance lines go to the props too (main.ts works them out). */
  propDistances: boolean;
  /** A prop's shadow (on the ground under it), its dashed line down when it's raised, and its label. */
  propShadows: boolean;
  propLines: boolean;
  propLabels: boolean;
  /** Each Banda's limit around the selected token, drawn on the terrain. */
  rings: boolean;
  /** And the ground in each Banda tinted its colour. */
  ringFill: boolean;
  /** As a player sees it: the fog over the scene, hidden tokens and what the fog covers left out. */
  playerView: boolean;
};

/**
 * The Bandas' rings around a token, as on the map (bandRings.ts): each
 * Banda's radius plus the Tolerancia (`reach`) and the token's excess bulk,
 * across only, in the Bandas' shape (Forma: a circle, a square, or whole hex
 * cells counted from the Origen's `cells`, offsets in cells). `z` (its
 * body's middle) isn't used by the rings, which leave height out.
 */
export type Reach = {
  x: number;
  y: number;
  z: number;
  excess: number;
  shape: BandShape;
  cells: { x: number; y: number }[];
  bands: { reach: number; color: string }[];
};

/**
 * A wall's face: one colour; the map's pixels at its top edge stretched
 * down; a strip of the map inside the edge folded down (mirrored where the
 * wall is taller); or a pattern drawn here (stone courses, earth strata,
 * planks) tinted with the map's colour at the edge.
 */
// "stone" is brick courses (its name from before "rubble", irregular stones, was added; kept for what's saved).
export type Quality = "low" | "medium" | "high";

/**
 * Each quality's sharpness (most device pixels to a screen pixel), weather (share), ms a frame for all that
 * moves by itself (weather, videos: see Renderer.animate), motion,
 * and its edges smoothed (multisampled). What gives up some of the picture to keep up, by quality (high
 * none: as chosen, however the device copes): `least`, the share of its sharpness kept at least while
 * the camera moves on a slow card (1: never less); `slow`, whether a device found slow loses its
 * smoothed edges.
 */
export const QUALITY: Record<Quality, { pixels: number; amount: number; frameMs: number; motion: boolean; smooth: boolean; least: number; slow: boolean }> = {
  high: { pixels: 2, amount: 1, frameMs: 33, motion: true, smooth: true, least: 1, slow: false },
  medium: { pixels: 1.5, amount: 0.65, frameMs: 50, motion: true, smooth: true, least: 0.75, slow: true },
  low: { pixels: 1, amount: 0.35, frameMs: 66, motion: false, smooth: false, least: 0.5, slow: false },
};

export type WallStyle = "blend" | "flat" | "stretch" | "fold" | "stone" | "rubble" | "earth" | "wood";

/** `focus`: the scene point the camera turns around (null: the map's middle), and its height in grid units. */
export type Camera = { tilt: number; yaw: number; zoom: number; panX: number; panY: number; focus: { x: number; y: number; z: number } | null };

/** A line from the origin token to another: its colour and what it says. */
export type DistanceLine = { id: string; color: string; band: string; distance: string };

/** A token's label parts: its name, its height, and where it is (on the ground, flying…). */
export type TokenText = (token: Token) => { name: string; height: string; detail: string };

export type Wall = {
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
  /** Its picture from a rectangle of the map (the zone's, as its style is): then that's its face. */
  skin?: TerrainSkin;
  /** The piece's edge it's of (piece, polygon, ring, side): what's worked out again of a region (see computeWalls). */
  seg: string;
  /** The relief shape its piece is of, if any (what moves it whole, see moveShapes): its own, not by the scene it's read with. */
  si?: number;
  /** How far round its outline it starts (scene px): a pattern runs on along it, round a curve too. */
  along?: number;
};

export type TokenView = {
  token: Token;
  el: HTMLElement;
  disc: HTMLElement;
  img: HTMLElement;
  zTok: number;
  /**
   * Its marks in 3D, and its label's lines: moved and rewritten in place (see setScene). A ring on the
   * ground (the free point's and the templates' handles; a token's base is its seat), and its line down.
   */
  marks?: { ring: THREE.Mesh | null; stem: THREE.Line | null };
  /** Its base among the others of its size (see BaseBatch), a token's or a standing prop's, off the terrain. */
  seat?: BaseSeat;
  /**
   * Its base painted on the terrain under it instead (scene px; see VistazoView.paintBases): `ring`, a
   * token's light ring round it; `z`, the ground it stands on (view units: a slab's top or not).
   */
  painted?: { x: number; y: number; r: number; ring: boolean; z: number };
  /** Its label as Owlbear's map shows it (its text, in its style; none, without one). */
  name?: HTMLElement;
  /** Its height and where it stands, under that (as the options have it). */
  title?: HTMLElement;
  detail?: HTMLElement;
  screen: { x: number; y: number };
  hidden: boolean;
  /** A prop: standing (always on its base) or lying flat (its picture a mesh, the element only its label). */
  prop?: PropView;
};

export type PropView = { data: Prop; flat: boolean; mesh: THREE.Mesh | null; shadow: THREE.Mesh | null };

/**
 * The map's picture over the scene's box (x0, y0, w × h, scene px): drawn on `canvas`; or, a lone map
 * image, `bitmap` (the image itself, sized for the graphics card), `canvas` then only a small copy
 * of it (for what reads its pixels: see bridgeFill).
 */
export type Texture = { canvas: HTMLCanvasElement; x0: number; y0: number; w: number; h: number; bitmap?: ImageBitmap };


/** Light from the north-west, for the walls' shading. */
export const LIGHT: [number, number] = [-0.6, -0.8];

/** A neutral stone, for walls (and pieces) when the map can't be read. */
export const STONE: [number, number, number] = [138, 128, 112];

/** The texture's longest side at most, in px. */
export const TEXTURE_MAX = 4096;

/**
 * The ground's texture's longest side when a detail's drawn over it (see MapComposer): only seen past
 * the detail (far off) or while it's made.
 */
export const BASE_TEXTURE_MAX = 2048;

/**
 * The map images' small blocks' texels at most, all of them, by quality (see sourceDensity): for the
 * ground's texture and what's far. About 4 bytes a texel and a third more for their mipmaps (high ~65 MB).
 */
export const SOURCE_BUDGET: Record<Quality, number> = { high: 12e6, medium: 8e6, low: 6e6 };

/**
 * The blocks' texels at most loaded as their files have them, by quality, where the camera looks (see
 * MapComposer.sharpen): those looked at longest ago let go for others (high ~170 MB).
 */
export const FULL_BUDGET: Record<Quality, number> = { high: 32e6, medium: 20e6, low: 12e6 };

/** The map's detail's texture's side, texels, by quality (see MapComposer.detail): high ~89 MB with its mipmaps, low ~22 MB. */
export const DETAIL_SIZE: Record<Quality, number> = { high: 4096, medium: 3072, low: 2048 };

export const tintOf = (height: number) => `hsl(${200 - height * 34} 75% 50%)`;
