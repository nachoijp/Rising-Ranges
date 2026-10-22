import type { Image, Item, Vector2 } from "@owlbear-rodeo/sdk";
import {
  getTerrainStand,
  getTerrainWall,
  getTerrainWater,
  terrainBridges,
  terrainShapes,
  terrainSkin,
  type TerrainSkin,
} from "../terrain/terrain";
import { anchorOf, reliefSize, sceneToCell } from "./anchor";
import { area, centroid, inRing, open } from "./geom";
import type { Pt, ReliefData, Shape, Skin } from "./types";

// The old terrain zones (shapes of the scene tagged with a height, see
// terrain/terrain.ts) as shapes of a map image's relief, so a map made
// before keeps its terrain: each zone on the image a shape at its height
// (fixed: they were measured from the ground), a ramp with its arrow, a
// bridge a slab, with its standing, walls, picture and water. Stacked as
// they were measured: the bigger under the smaller (which won). A cloth
// has no counterpart (it isn't kept).

/** A relief with the image's zones added under its own shapes, and how many came. */
export function withZones(items: Item[], image: Image, dpi: number, data: ReliefData): { data: ReliefData; count: number } {
  const anchor = anchorOf(image);
  const [w, h] = reliefSize(anchor);
  const cell = (p: Vector2 | [number, number]): Pt => (Array.isArray(p) ? sceneToCell(anchor, dpi, p[0], p[1]) : sceneToCell(anchor, dpi, p.x, p.y));
  const onImage = ([x, y]: Pt) => x >= 0 && y >= 0 && x <= w && y <= h;
  const byId = new Map(items.map((item) => [item.id, item]));
  const verts = [...data.verts];
  const shapes: Shape[] = [];

  /** A zone's outlines in cells: each outer one with the ones inside it as holes. */
  const loopsOf = (rings: [number, number][][]): { ring: Pt[]; holes: Pt[][] }[] => {
    const loops = rings
      .map((ring) => open(ring.map(cell)))
      .filter((ring) => ring.length >= 3)
      .sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
    const out: { ring: Pt[]; holes: Pt[][] }[] = [];
    for (const loop of loops) {
      const around = out.find((o) => inRing(...centroid(loop), o.ring));
      if (around) {
        around.holes.push(loop);
      } else {
        out.push({ ring: loop, holes: [] });
      }
    }
    return out;
  };
  const indices = (loop: Pt[]) => loop.map(([x, y]) => verts.push({ x, y, h: 0 }) - 1);
  const skinOf = (skin: TerrainSkin | undefined): Skin | undefined =>
    skin && { base: [cell(skin.base[0]), cell(skin.base[1])], top: [cell(skin.top[0]), cell(skin.top[1])], center: cell(skin.center) };
  const add = (rings: [number, number][][], item: Item | undefined, own: Omit<Shape, "ring" | "holes">) => {
    for (const { ring, holes } of loopsOf(rings)) {
      if (!onImage(centroid(ring))) {
        continue;
      }
      const shape: Shape = { ...own, ring: indices(ring), name: item?.name || undefined };
      if (holes.length > 0) {
        shape.holes = holes.map(indices);
      }
      if (item) {
        const stand = getTerrainStand(item);
        const wall = getTerrainWall(item);
        const skin = skinOf(terrainSkin(item, items));
        const water = getTerrainWater(item);
        Object.assign(shape, stand && { stand }, wall && { wall }, skin && { skin }, water && { water });
      }
      shapes.push(shape);
    }
  };

  // The one that won first in the list: the last laid, on top.
  for (const zone of [...terrainShapes(items)].reverse()) {
    if (zone.surface) {
      continue;
    }
    const item = byId.get(zone.id);
    if (zone.slope) {
      const { low, origin, axis } = zone.slope;
      const ramp = { a: cell(origin), b: cell({ x: origin.x + axis.x, y: origin.y + axis.y }), from: low, to: zone.height, steps: 0 };
      add(zone.rings, item, { kind: "ramp", h: zone.height, rel: false, ramp });
    } else {
      add(zone.rings, item, { kind: "flat", h: zone.height, rel: false });
    }
  }
  for (const bridge of terrainBridges(items)) {
    const item = byId.get(bridge.id);
    add(bridge.rings, item, { kind: "flat", h: bridge.top, rel: false, slab: bridge.top - bridge.bottom });
  }
  return { data: { ...data, verts, shapes: [...shapes, ...data.shapes] }, count: shapes.length };
}
