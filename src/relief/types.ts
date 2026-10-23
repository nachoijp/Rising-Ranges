// The terrain made with the relief editor (the mockup's editor F, "Capas"):
// a painted ground at the bottom and, over it, shapes kept as objects, worked
// out bottom to top. All in cells of the map it follows (x right, y down),
// heights in grid units. See relief.ts for how a height is worked out.

export type Pt = [number, number];

/** A vertex of the shapes' outlines (shared between them); its height counts on inclined shapes. */
export type Vert = { x: number; y: number; h: number };

/** A height point inside an inclined shape. */
export type HeightPoint = { x: number; y: number; h: number };

/** A ramp's arrow: from `a` (at `from`) to `b` (at `to`); in steps if `steps` is 2 or more. */
export type Ramp = { a: Pt; b: Pt; from: number; to: number; steps: number };

/** The edge a standing shape stands on ("auto": the one facing the map's middle). */
export type StandEdge = "auto" | "bottom" | "top" | "left" | "right";

/** How a shape's walls look in 3D (the Vistazo's own looks). */
export type WallLook = "flat" | "stretch" | "fold" | "stone" | "rubble" | "earth" | "wood";

/**
 * A picture for a shape's walls from four points of the map: `base` its foot
 * (the end nearest the shape), `top` its far end, both from the same long
 * side; `center` the shape's middle, which it goes round.
 */
export type Skin = { base: [Pt, Pt]; top: [Pt, Pt]; center: Pt };

/** An affine map [a, b, c, d, e, f]: (u, v) → (a·u + c·v + e, b·u + d·v + f). */
export type Affine = [number, number, number, number, number, number];

/** A shape's painted relief: its own grid (steps of G in its frame `m`), only the points painted. */
export type Detail = { m: Affine; v: Map<number, number>; inv?: Affine; invOf?: Affine };

export type ShapeKind = "flat" | "ramp" | "slope";

/**
 * A shape: its outline (and holes) as indices into the vertices; its surface
 * (flat at `h`, a ramp, or inclined by its vertices' heights); its height over
 * what's under it (`rel`) or fixed. A slab (`slab`: its thickness) isn't
 * terrain: it lies over it. A standing one is drawn upright in 3D.
 */
export type Shape = {
  ring: number[];
  holes?: number[][];
  kind: ShapeKind;
  h: number;
  rel?: boolean;
  ramp?: Ramp;
  /** A soft edge: its height fades into what's round it over this width (cells). */
  soft?: number;
  slab?: number;
  stand?: StandEdge;
  /** A standing shape's picture on its sides too. */
  wrap?: boolean;
  /** Cut from one shape: the halves don't stand on one another. */
  kin?: string;
  name?: string;
  detail?: Detail;
  wall?: WallLook;
  skin?: Skin;
  /** Water over its lowest floor, this deep (cells); only drawn. */
  water?: number;
  /** The editor's own (not the Vistazo's, nor what's measured): not drawn on its map, not to be picked there. */
  hidden?: boolean;
  /** The editor's own: drawn, but not to be picked, moved or cut on its map. */
  locked?: boolean;
};

/** A whole terrain: the map's size in cells, its shapes, and the painted ground (gw × gh points, G apart). */
export type ReliefData = {
  w: number;
  h: number;
  verts: Vert[];
  shapes: Shape[];
  points: HeightPoint[];
  ground: Float32Array;
};
