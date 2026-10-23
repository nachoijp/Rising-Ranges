import type * as THREE from "three";
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
  /** The Weather extension's rain, snow, sand, embers, petals and clouds, drawn here (see weather.ts). */
  weather: boolean;
  /** Its clouds as a mist over the map, or their shadows on it. */
  clouds: CloudStyle;
  /** Zones' water moving (ripples, glints); still otherwise. */
  waterMotion: boolean;
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
// "stone" is brick courses (its name from before "rubble", irregular stones, was added; kept for what's saved).
export type Quality = "low" | "medium" | "high";

/** Each quality's sharpness (most device pixels to a screen pixel), weather (share, ms a frame) and motion. */
export const QUALITY: Record<Quality, { pixels: number; amount: number; frameMs: number; motion: boolean }> = {
  high: { pixels: 2, amount: 1, frameMs: 33, motion: true },
  medium: { pixels: 1.5, amount: 0.65, frameMs: 40, motion: true },
  low: { pixels: 1, amount: 0.35, frameMs: 66, motion: false },
};

export type WallStyle = "flat" | "stretch" | "fold" | "stone" | "rubble" | "earth" | "wood";

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
  /** Its base among the others of its size (see BaseBatch), a token's or a standing prop's. */
  seat?: BaseSeat;
  title?: HTMLElement;
  detail?: HTMLElement;
  screen: { x: number; y: number };
  hidden: boolean;
  /** A prop: standing (always on its base) or lying flat (its picture a mesh, the element only its label). */
  prop?: PropView;
};

export type PropView = { data: Prop; flat: boolean; mesh: THREE.Mesh | null; shadow: THREE.Mesh | null };

export type Texture = { canvas: HTMLCanvasElement; x0: number; y0: number; w: number; h: number };


/** Light from the north-west, for the walls' shading. */
export const LIGHT: [number, number] = [-0.6, -0.8];

/** A neutral stone, for walls (and pieces) when the map can't be read. */
export const STONE: [number, number, number] = [138, 128, 112];

/** The texture's longest side at most, in px. */
export const TEXTURE_MAX = 4096;

export const tintOf = (height: number) => `hsl(${200 - height * 34} 75% 50%)`;
