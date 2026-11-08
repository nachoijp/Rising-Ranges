import type { MultiPolygon, Pair } from "polygon-clipping";
import clip from "../terrain/clip";
import { frameOf } from "../terrain/terrain";
import type { Bridge, Piece, StandEdge } from "../vistazo/scene";
import { cellToScene, sceneToCell, type Anchor } from "./anchor";
import { bbox, centroid, closed, inBox, inShape, open } from "./geom";
import { ReliefMesh } from "./mesh";
import { time } from "../timing";
import type { Layer, Piece as ReliefPiece, Relief } from "./relief";
import type { Pt, Skin } from "./types";

// A relief as the Vistazo 3D draws terrain: pieces (each shape's visible part,
// a step of a stair each, and the bare ground round them), every one at the
// relief's own heights (its surface asks the relief), so the Vistazo's walls,
// wall looks, water, tint, fog and rings work on it as they do on zones; its
// slabs as bridges; its standing shapes with the relief's own pictures. In the
// scene's pixels, through the map image the relief follows.

export type ReliefTerrain = {
  pieces: Piece[];
  bridges: Bridge[];
  /** The outlines of the shapes that keep their look under slabs (scene px). */
  unfilled: MultiPolygon[];
  /** Where the relief is: its map image's outline (scene px). */
  area: MultiPolygon;
  /** The height at a scene point, as drawn and measured (undefined off its image; 0 under the fog). */
  heightAt: (x: number, y: number) => number | undefined;
};

/**
 * (The player view's fog isn't cut out here: the view leaves out what's under it as it draws.)
 * `surfaced`: every piece with its surface, flat ones too (while it's being
 * edited: a brush's heights then move its corners where they are, see
 * VistazoView.reheight). `skip`: shapes left out; `within`: only what's
 * inside that (cells) — with both, what's under shapes being dragged (see
 * VistazoView.fillUnder), quick: the shapes away from it aren't cut at all.
 */
export function reliefTerrain(
  relief: Relief,
  anchor: Anchor,
  dpi: number,
  surfaced = false,
  skip: Set<number> | null = null,
  within: Pt[][][] | null = null
): ReliefTerrain {
  const { w, h } = relief.data;
  const toScene = ([x, y]: Pt): Pair => {
    const p = cellToScene(anchor, dpi, x, y);
    return [p.x, p.y];
  };
  const sceneOf = (multi: Pt[][][]): MultiPolygon => multi.map((polygon) => polygon.map((ring) => closed(open(ring).map(toScene))));
  const rect: Pt[] = [[0, 0], [w, 0], [w, h], [0, h]];
  const area = sceneOf([[rect]]);
  /** What it's cut to: the map, or the part asked for. */
  const bounds: Pt[][][] = within ?? [[closed(rect)]];
  const box = within ? bbox(within.flatMap((polygon) => polygon[0])) : null;
  const near = (b: { x0: number; y0: number; x1: number; y1: number }) => !box || (b.x0 <= box.x1 && b.x1 >= box.x0 && b.y0 <= box.y1 && b.y1 >= box.y0);
  // Over another image's relief with no ground of its own (see stack.ts): only its shapes are its own.
  const see = relief.seeThrough;
  const heightAt = (x: number, y: number): number | undefined => {
    const [cx, cy] = sceneToCell(anchor, dpi, x, y);
    if (cx < 0 || cy < 0 || cx > w || cy > h || (see && !relief.covered(cx, cy))) {
      return undefined;
    }
    return relief.evaluate(cx, cy);
  };
  /**
   * A layer and its piece as the relief has them now: worked out again since (a brush: Relief.derive),
   * the same shape's, the same piece of it (only heights change so: a relative shape's, over what the
   * brush painted). What's drawn reads them so, kept till it's built again (see vistazo/settle.ts).
   */
  const born = relief.version;
  let layersAt = born;
  let bySi = new Map<number, Layer>();
  const live = (own: Layer, piece?: ReliefPiece): [Layer, ReliefPiece | undefined] => {
    if (relief.version === born) {
      return [own, piece];
    }
    if (layersAt !== relief.version) {
      bySi = new Map(relief.layers.map((layer) => [layer.si, layer]));
      layersAt = relief.version;
    }
    const now = bySi.get(own.si);
    if (!now) {
      return [own, piece];
    }
    const k = piece ? own.pieces.indexOf(piece) : -1;
    return [now, k >= 0 ? (now.pieces[k] ?? piece) : piece];
  };
  /** A piece's own surface (see Relief.evaluateOn): its edge's points at its height, not the next one's. */
  const surfaceOf = (own: Layer | null, piece?: ReliefPiece) => (p: { x: number; y: number }) => {
    const [cx, cy] = sceneToCell(anchor, dpi, p.x, p.y);
    const [layer, now] = own ? live(own, piece) : [null, piece];
    return relief.evaluateOn(layer, cx, cy, now);
  };
  const mesh = new ReliefMesh(relief);
  const pieces: Piece[] = [];
  // From the top down: each layer's pieces less what's over them (only those whose box reaches theirs:
  // not one growing union of all of them), within the map.
  const above: { polygon: Pt[][]; box: { x0: number; y0: number; x1: number; y1: number }; sig: string }[] = [];
  // Each piece's part as last cut, by the piece and what was over it (see cutKept): a drag moves one
  // shape, and only what's under it is cut again.
  const kept = cutsOf(relief.source);
  const reach = within ? JSON.stringify(within) : `${w}x${h}`;
  for (let li = relief.layers.length - 1; li >= 0; li--) {
    const layer = relief.layers[li];
    if (skip?.has(layer.si) || !near(layer.outer)) {
      continue;
    }
    const shape = relief.data.shapes[layer.si];
    // Its heights the same everywhere: flat, nothing painted on it, no soft edge over it from above.
    const flat =
      shape.kind === "flat" &&
      !(layer.detail && layer.detail.v.size > 0) &&
      !relief.layers.slice(li + 1).some((o) => o.soft > 0 && o.outer.x0 <= layer.box.x1 && o.outer.x1 >= layer.box.x0 && o.outer.y0 <= layer.box.y1 && o.outer.y1 >= layer.box.y0);
    const side = layer.stand ? mesh.side(layer) : null;
    const card = layer.stand ? mesh.standingCard(layer).map(([x, y, z, mx, my]): [number, number, number, number, number] => [...toScene([x, y]), z, ...toScene([mx, my])]) : undefined;
    for (const piece of layer.pieces) {
      let parts: Pt[][][] = [[closed(piece.ring), ...piece.holes.map(closed)]];
      const pb = bbox(piece.ring);
      const overing = above.filter(({ box: b }) => b.x0 < pb.x1 && b.x1 > pb.x0 && b.y0 < pb.y1 && b.y1 > pb.y0);
      const key = `${loopsSig([piece.ring, ...piece.holes])}|${reach}|${overing.map((o) => o.sig).join(";")}`;
      const known = kept.get(key);
      if (known) {
        known.used = kept.round;
        parts = known.parts;
      } else {
        try {
          // Within the map already (most): not cut to it.
          const inside = !within && pb.x0 >= 0 && pb.y0 >= 0 && pb.x1 <= w && pb.y1 <= h;
          if (!inside) {
            parts = clip.intersection(parts, bounds) as Pt[][][];
          }
          if (overing.length > 0) {
            parts = clip.difference(parts, ...overing.map((o) => [o.polygon])) as Pt[][][];
          }
        } catch (error) {
          console.error("Rising Ranges: 3D Glance left out a part of the relief", error);
          continue;
        }
        kept.set(key, { parts, used: kept.round });
      }
      if (parts.length === 0) {
        continue;
      }
      const sceneShape = sceneOf(parts);
      const [cx, cy] = centroid(piece.ring);
      const at = piece.h ?? relief.surface(layer, cx, cy);
      const flatNow = flat && piece.h !== undefined;
      const drawn: Piece = {
        height: 0,
        shape: sceneShape,
        surface: flatNow && !surfaced ? undefined : surfaceOf(layer, piece),
        walls: shape.wall,
        skin: shape.skin ? skinOf(shape.skin, toScene) : undefined,
        water: shape.water,
        si: layer.si,
      };
      // An inclined shape's height points: corners of its surface as drawn (else, between a fine surface's
      // corners, a point's peak is cut off: drawn lower than it is).
      if (shape.kind === "slope" || (shape.kind === "ramp" && !shape.ramp)) {
        const peaks = relief.data.points.filter((p, k) => relief.pointOwners[k] === layer.si && inShape(p.x, p.y, piece.ring, piece.holes)).map((p) => toScene([p.x, p.y]));
        if (peaks.length > 0) {
          drawn.peaks = peaks;
        }
      }
      if (flatNow && surfaced) {
        // Flat while it's edited: its outline is enough, until something makes its heights vary inside it.
        const si = layer.si;
        drawn.coarse = true;
        drawn.fine = () => {
          const own = relief.data.shapes[si];
          const box = relief.layers.find((l) => l.si === si)?.box;
          return (
            !!(own?.detail && own.detail.v.size > 0) ||
            (!!box && relief.layers.some((o) => o.si > si && o.soft > 0 && o.outer.x0 <= box.x1 && o.outer.x1 >= box.x0 && o.outer.y0 <= box.y1 && o.outer.y1 >= box.y0))
          );
        };
      }
      if (shape.water) {
        // The water's floor: its lowest point (the Vistazo fills from there up to the level).
        drawn.height = Math.min(at, ...piece.ring.map(([x, y]) => (inBox(layer.box, x, y) ? relief.surface(layer, x, y) : at)));
      } else {
        // As the relief has it now (a relative shape's follows what a brush paints under it).
        Object.defineProperty(drawn, "height", {
          enumerable: true,
          get: () => {
            const [l, p] = live(layer, piece);
            return flatNow ? p!.h! : (p?.h ?? relief.surface(l, cx, cy));
          },
        });
      }
      if (side && card) {
        drawn.stand = (side.edge ?? standFacing(side.out)) as StandEdge;
        drawn.card = card;
      }
      pieces.push(drawn);
    }
    above.push({ polygon: [closed(layer.ring), ...layer.holes.map(closed)], box: bbox(layer.ring), sig: loopsSig([layer.ring, ...layer.holes]) });
  }
  kept.done();
  pieces.reverse();
  const plainGround = relief.data.ground.every((v) => v === 0) && !relief.layers.some((layer) => layer.soft > 0);
  // The ground: what no shape covers, at the painted ground's heights. Cut a tile at a time (each less
  // only the shapes over it, kept while they stay: a dragged shape cuts again only the tiles it's on),
  // the tiles side by side as its parts (their sides between them at one height: no walls there). A
  // ground that isn't flat is cut whole (kept too, while no shape over it changes).
  let ground: Pt[][][] = [];
  time("relief.ground", () => {
    const tiles: Pt[][][] = [];
    // Not on a ground that isn't flat: tiles cut fine apart might not meet corner to corner (cracks).
    if (within || !plainGround) {
      tiles.push(...bounds);
    } else {
      for (let ty = 0; ty < h; ty += GROUND_TILE) {
        for (let tx = 0; tx < w; tx += GROUND_TILE) {
          const [x1, y1] = [Math.min(w, tx + GROUND_TILE), Math.min(h, ty + GROUND_TILE)];
          tiles.push([closed([[tx, ty], [x1, ty], [x1, y1], [tx, y1]])]);
        }
      }
    }
    for (const tile of tiles) {
      const tb = bbox(tile[0]);
      const over = above.filter(({ box: b }) => b.x0 < tb.x1 && b.x1 > tb.x0 && b.y0 < tb.y1 && b.y1 > tb.y0);
      if (over.length === 0) {
        ground.push(tile);
        continue;
      }
      const key = `ground|${loopsSig(tile)}|${over.map((o) => o.sig).join(";")}`;
      const known = kept.get(key);
      if (known) {
        known.used = kept.round;
        ground.push(...known.parts);
        continue;
      }
      try {
        const parts = clip.difference([tile], ...over.map((o) => [o.polygon])) as Pt[][][];
        kept.set(key, { parts, used: kept.round });
        ground.push(...parts);
      } catch (error) {
        console.error("Rising Ranges: 3D Glance couldn't cut the relief's ground", error);
        ground.push(tile);
      }
    }
  });
  const groundScene = sceneOf(ground);
  if (groundScene.length > 0 && !see) {
    pieces.unshift({ height: 0, shape: groundScene, surface: plainGround && !surfaced ? undefined : surfaceOf(null) });
  }
  // Slabs: bridges over the terrain (a slab's top as its middle has it; one that isn't flat, at each point too).
  const bridges: Bridge[] = (within ? [] : relief.slabLayers.filter((layer) => !skip?.has(layer.si))).flatMap((layer) => {
    const shape = relief.data.shapes[layer.si];
    const [cx, cy] = centroid(layer.ring);
    const top = relief.surface(layer, cx, cy);
    const outline = sceneOf([[closed(layer.ring), ...layer.holes.map(closed)]]);
    const flat = shape.kind === "flat" && layer.pieces.length === 1 && !(shape.detail && shape.detail.v.size > 0);
    return [{
      id: `relief-${layer.si}`,
      shape: outline,
      top,
      bottom: top - layer.thick,
      surface: flat
        ? undefined
        : (p: { x: number; y: number }) => {
            const [x, y] = sceneToCell(anchor, dpi, p.x, p.y);
            return relief.surface(layer, x, y);
          },
      walls: shape.wall,
      skin: shape.skin ? skinOf(shape.skin, toScene) : undefined,
      frame: frameOf(layer.ring.map(toScene).map(([x, y]) => ({ x, y }))),
      si: layer.si,
      under: shape.under,
    }];
  });
  const unfilled = relief.data.shapes.flatMap((s) => {
    if (!s.keepLook) {
      return [];
    }
    const [ring, holes] = relief.coordsOf(s);
    return [sceneOf([[closed(ring), ...holes.map(closed)]])];
  });
  // See-through: what it has of the scene is its shapes (the ground there's the image's under it).
  let own = area;
  if (see) {
    try {
      const shapes = above.map((o): Pt[][][] => [o.polygon]);
      own = shapes.length > 0 ? sceneOf(clip.intersection(bounds, clip.union(shapes[0], ...shapes.slice(1))) as Pt[][][]) : [];
    } catch (error) {
      console.error("Rising Ranges: 3D Glance couldn't work out a relief's shapes' outline", error);
    }
  }
  return { pieces, bridges, area: own, heightAt, unfilled };
}

/** The ground's tiles (cells across), cut apart (see reliefTerrain): a drag cuts again only those it's on. */
const GROUND_TILE = 8;

/** Outlines as text: the same outlines, the same text. */
function loopsSig(loops: Pt[][]): string {
  return loops.map((loop) => loop.map(([x, y]) => `${x},${y}`).join(" ")).join("/");
}

/** Cut pieces kept for a relief (see reliefTerrain): by their key, with the round they were last used in. */
type Cuts = Map<string, { parts: Pt[][][]; used: number }> & { round: number; done: () => void };
const cutsByRelief = new WeakMap<Relief, Cuts>();

/** A relief's kept cuts, a new round begun: those unused for a few rounds forgotten when it's done. */
function cutsOf(relief: Relief): Cuts {
  let cuts = cutsByRelief.get(relief);
  if (!cuts) {
    const made = new Map() as Cuts;
    made.round = 0;
    made.done = () => {
      if (made.size > 4 * (relief.data.shapes.length + 50)) {
        for (const [key, value] of made) {
          if (value.used < made.round - 3) {
            made.delete(key);
          }
        }
      }
    };
    cutsByRelief.set(relief, made);
    cuts = made;
  }
  cuts.round++;
  return cuts;
}

/** A picture's points in the scene, as the Vistazo has them. */
function skinOf(skin: Skin, toScene: (p: Pt) => Pair) {
  const v = (p: Pt) => {
    const [x, y] = toScene(p);
    return { x, y };
  };
  return { base: [v(skin.base[0]), v(skin.base[1])] as [{ x: number; y: number }, { x: number; y: number }], top: [v(skin.top[0]), v(skin.top[1])] as [{ x: number; y: number }, { x: number; y: number }], center: v(skin.center) };
}

/** The box edge a front faces most (an unfolded standing shape's, slanting). */
function standFacing([x, y]: Pt): StandEdge {
  return Math.abs(y) >= Math.abs(x) ? (y >= 0 ? "bottom" : "top") : x >= 0 ? "right" : "left";
}
