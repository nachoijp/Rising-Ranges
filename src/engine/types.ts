export type DistanceMetric = "spherical" | "cubic" | "cylindrical";

/** Which side of a token's baseline a marker represents. */
export type Direction = "up" | "down";

/**
 * "hex" is what's stored and chosen; where a Medición starts it becomes the
 * grid's own hexHorizontal / hexVertical, or a circle off a hex grid (see hex.ts).
 */
export type BandShape = "circle" | "square" | "hex" | "hexHorizontal" | "hexVertical";

/** What one raise/lower step moves a token by: to the next Banda, or one grid cell. */
export type HeightStep = "band" | "unit";

/** Where a Lectura's icon stack sits relative to its token. */
export type IconPosition = "left" | "right" | "top" | "bottom";

/** How a Lectura is drawn on the measured token. */
export type Visualization = "icon" | "ring" | "circle";

/** The silhouette of the icons in a stack. */
export type IconShape =
  | "triangle"
  | "triangleStepped"
  | "bar"
  | "circle"
  | "diamond"
  | "square"
  | "star"
  | "wingDrill";

export type Band = {
  radius: number;
  name: string;
  id: string;
  /** Overrides the BandSet's default icon shape for just this Banda (e.g. Melee should
   * always be a circle, never a directional shape). Missing = use the BandSet's own. */
  iconShape?: IconShape;
};

export type BandSet = {
  name: string;
  id: string;
  shape: BandShape;
  metric: DistanceMetric;
  bands: Band[];
  /** Extra margin for a token to count as inside a Banda, percent 0-100 of a grid cell (see effectiveDistance). Missing = DEFAULT_TOLERANCE. */
  tolerance?: number;
  /** Missing = "band". */
  heightStep?: HeightStep;
  /**
   * A Banda past all the others, with no end: what's beyond the farthest
   * one counts as in it rather than out of range. No ring. The name is kept
   * while it's switched off. Missing = off.
   */
  finalBand?: { enabled: boolean; name: string };

  // How things look used to be part of each set. It's a room setting now
  // (settings/display.ts); these are only read as its fallbacks, so rooms
  // from before keep their look, and the built-in presets still define them.
  hideLabel?: boolean;
  hideSize?: boolean;
  iconShape?: IconShape;
  iconPosition?: IconPosition;
  /** 0.5-2 */
  iconSize?: number;
  /** 0-0.4, fraction of grid dpi */
  iconDistance?: number;
  /** How the Lectura draws on the token. Missing = "icon". */
  visualization?: Visualization;
  /** Show a text Banda-name pill alongside whichever visualization is active. Missing = false. */
  showLabel?: boolean;
  /** Ring mode's stroke width, fraction of grid dpi. Missing = 0.05. */
  ringWidth?: number;
  /** Circle mode's fill opacity, 0-1. Missing = 0.35. */
  circleOpacity?: number;
  filterEnabled?: boolean;
  filterBandId?: string;
};
