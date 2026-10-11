import { buildPath, buildShape, Command, Math2, type Item, type Vector2 } from "@owlbear-rodeo/sdk";
import { floorExtent } from "../engine/axonometry";
import { BandShape } from "../engine/types";

// A circle or square lying on the floor — a Banda's ring, a Lectura's ring
// or circle under its token — drawn as Owlbear's grid shows the floor: as
// is on a flat grid, squashed into an ellipse or a rhombus on an
// axonometric one (see axonometry.ts).

export type FloorShapeStyle = Partial<{
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  strokeOpacity: number;
  strokeWidth: number;
  strokeDash: number[];
}>;

/**
 * The floor shape of `radius` px around `center`, and its offset: the item
 * sits at `center − offset` (a rectangle is placed by its corner, the rest
 * by their center), so it can be moved with its center.
 */
export function buildFloorShape(
  center: Vector2,
  radius: number,
  shape: BandShape,
  axonometry: number,
  style: FloorShapeStyle
): { item: Item; offset: Vector2 } {
  const { halfWidth, halfHeight } = floorExtent(radius, shape, axonometry);
  let item: Item;
  let offset: Vector2;
  if (shape === "square" && axonometry) {
    // The grid's own cell shape: Owlbear has no rhombus Shape.
    offset = { x: 0, y: 0 };
    item = buildPath()
      .commands([
        [Command.MOVE, 0, -halfHeight],
        [Command.LINE, halfWidth, 0],
        [Command.LINE, 0, halfHeight],
        [Command.LINE, -halfWidth, 0],
        [Command.CLOSE],
      ])
      .position(center)
      .build();
  } else {
    offset = shape === "square" ? { x: halfWidth, y: halfHeight } : { x: 0, y: 0 };
    item = buildShape()
      .shapeType(shape === "square" ? "RECTANGLE" : "CIRCLE")
      .position(Math2.subtract(center, offset))
      .width(halfWidth * 2)
      .height(halfHeight * 2)
      .build();
  }
  Object.assign((item as Item & { style: FloorShapeStyle }).style, style);
  item.disableHit = true;
  item.layer = "POPOVER";
  return { item, offset };
}
