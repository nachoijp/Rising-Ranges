import { isImage, type Item } from "@owlbear-rodeo/sdk";
import * as THREE from "three";
import { anchorOf, cellToScene } from "../relief/anchor";
import type { Relief } from "../relief/relief";
import { fogDoorOpen } from "../relief/trace/fogPlan";
import { DOOR_H } from "../relief/trace/doors";
import { patternTexture } from "./view/patterns";
import type { DoorLink, DoorLook, DoorOpens } from "../relief/types";

// The reliefs' doors' leaves in the Vistazo (see relief/types.ts Door): the
// doorway itself is cut through the wall with the terrain (see
// relief/doorCut.ts); here, the leaf in it, open or shut as its fog door is
// (read from the fog, Owlbear's or Smoke & Spectre!'s, every time it
// changes), so what's drawn is what blocks sight. Rebuilt whole when
// anything changes: there are few.

type XY = { x: number; y: number };

/** A door where it is in the scene (px), how it opens, how tall its doorway (grid units) and its leaf thick (px), and open or shut. */
export type DoorView = {
  key: string;
  a: XY;
  b: XY;
  side: 1 | -1;
  swing: number;
  h: number;
  thick: number;
  look: DoorLook;
  /** Its face's picture (look "picture"): the map's rectangle's top corners (over its hinge's end, and its other's) and its bottom one under the hinge's (scene px). */
  picture?: { tl: XY; tr: XY; bl: XY };
  opens: DoorOpens;
  secret: boolean;
  open: boolean;
  link?: DoorLink;
  /** A cell across (scene px). */
  cell: number;
  /**
   * Left as wall (see scene.ts Reliefs.shutDoors): its leaf a board against the wall's face on its clear
   * side, this far from its line (scene px, along its normal (−dy, dx): signed), shut whatever it is.
   */
  panel?: number;
};

/** A door's leaf's thickness (cells) when it hasn't its own. */
const DOOR_THICK = 0.12;

const LOOK_NAMES: DoorLook[] = ["wood", "stone", "rubble", "earth", "flat", "blend", "stretch", "picture", "metal", "bars", "glass"];

/** The doors of every map image's relief, in the scene. */
export function sceneDoors(items: Item[], reliefs: Map<string, Relief>, dpi: number): DoorView[] {
  const out: DoorView[] = [];
  for (const item of items) {
    if (!isImage(item) || item.layer !== "MAP" || !item.visible) continue;
    const doors = reliefs.get(item.id)?.data.doors;
    if (!doors?.length) continue;
    const anchor = anchorOf(item);
    const at = (x: number, y: number) => cellToScene(anchor, dpi, x, y);
    const o = at(0, 0), e = at(1, 0);
    const cell = Math.hypot(e.x - o.x, e.y - o.y);
    doors.forEach((door, i) => {
      // One of an earlier try's looks ("wall"), or a picture with none taken: wood.
      let look: DoorLook = door.look && LOOK_NAMES.includes(door.look) ? door.look : "wood";
      if (look === "picture" && !door.picture) look = "wood";
      const p = door.picture;
      // The rectangle's left over the hinge's end when the door runs left to right on the map (its x up the cells), else mirrored.
      const ltr = door.b[0] - door.a[0] >= 0;
      out.push({
        key: `${item.id}:${i}`,
        a: at(door.a[0], door.a[1]),
        b: at(door.b[0], door.b[1]),
        // Its side as drawn: a mirrored image swings it the other way.
        side: (door.side * Math.sign(anchor.scaleX * anchor.scaleY || 1)) as 1 | -1,
        swing: door.swing,
        h: door.h ?? DOOR_H,
        thick: (door.thick ?? DOOR_THICK) * cell,
        look,
        ...(look === "picture" && p ? { picture: { tl: at(ltr ? p[0] : p[2], p[1]), tr: at(ltr ? p[2] : p[0], p[1]), bl: at(ltr ? p[0] : p[2], p[3]) } } : {}),
        opens: door.opens ?? "swing",
        secret: door.secret === true,
        open: door.link ? (fogDoorOpen(door.link, items) ?? false) : false,
        link: door.link,
        cell,
      });
    });
  }
  return out;
}

/** What a leaf takes from the map: its texture, where on it a scene point is, its colour there, the walls' grain (for a blended look). */
export type DoorMap = {
  texture: THREE.Texture | null;
  uv: (x: number, y: number) => [number, number];
  color: ((x: number, y: number) => [number, number, number]) | null;
  grain: (material: THREE.MeshBasicMaterial) => THREE.MeshBasicMaterial;
  /** A material showing the map's picture as the walls do (sharpest where it can, its colours straight). */
  picture: (material: THREE.MeshBasicMaterial) => THREE.MeshBasicMaterial;
};

/** The looks of their own: their colours (front and back, ends and bottom, top), tinting their pattern (if they have one). */
const OWN: Partial<Record<DoorLook, { face: number; edge: number; top: number; pattern?: "wood" | "stone" }>> = {
  wood: { face: 0xc58c55, edge: 0x7d5230, top: 0xd9a066, pattern: "wood" },
  metal: { face: 0x7c838c, edge: 0x50555c, top: 0x949ba3 },
  bars: { face: 0x4a4e55, edge: 0x34373c, top: 0x5a5f66 },
};
/** The colour a look from the map takes with none known (the walls' stone). */
const STONE: [number, number, number] = [138, 128, 112];
/** Faces' shades (front and back, ends and bottom, top), as the walls' sides are darker than their tops. */
const SHADES = { face: 0.85, edge: 0.6, top: 1 };
/** A board against a wall: its thickness, and its gap off the wall (cells). */
const BOARD = 0.04;
const BOARD_GAP = 0.01;
/** An iron door's straps; the gap between bars (cells); a glass door's frame (cells), and its glass; the gap left over a leaf, under its lintel (grid units). */
const STRAP = 0x3e4248;
const BAR_GAP = 0.22;
const FRAME = 0.07;
const FRAME_COLOR = 0x4f5a63;
const GLASS = 0xbfe4ff;
const HEAD_GAP = 0.03;

/** A box's faces' texture coordinates set so its pattern (a tile `tile` view units across) keeps its size on each. */
function tileUvs(geometry: THREE.BoxGeometry, sx: number, sy: number, sz: number, tile: number) {
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  // Faces in order (+x, −x, +y, −y, +z, −z), 4 vertices each: their width and height.
  const sizes: [number, number][] = [[sy, sz], [sy, sz], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  sizes.forEach(([w, h], f) => {
    for (let v = f * 4; v < f * 4 + 4; v++) uv.setXY(v, (uv.getX(v) * w) / tile, (uv.getY(v) * h) / tile);
  });
  uv.needsUpdate = true;
}

/** A box `sx` × `sy` × `sz` from (x0, 0, z0) along x, centred on y; its faces' materials in order (+x, −x, +y, −y, +z, −z). */
function box(sx: number, sy: number, sz: number, x0: number, z0: number, tile: number, materials: THREE.Material[] | THREE.Material): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(sx, sy, sz);
  tileUvs(geometry, sx, sy, sz, tile);
  geometry.translate(x0 + sx / 2, 0, z0 + sz / 2);
  return new THREE.Mesh(geometry, materials);
}

/** A colour (0–255) shaded, as three.js has it. */
const shaded = ([r, g, b]: [number, number, number], s: number) => new THREE.Color((r / 255) * s, (g / 255) * s, (b / 255) * s);

/**
 * A door's leaf, in view units (`u` a scene px, `k` a grid unit up, `cell`
 * a cell across), standing on `ground` (its doorway's floor, grid units)
 * and filling its doorway: shut, or open as it opens (turned round its
 * hinge, slid back into the wall past it, lifted into it, or gone). Its
 * look its own, or the map's (`map`). Both faces of everything drawn: the
 * view's y runs down, so a box's faces look inward to three.js.
 */
export function doorMesh(door: DoorView, u: number, k: number, ground: number, cell: number, map?: DoorMap): THREE.Object3D {
  const out = new THREE.Group();
  out.userData.door = door.key;
  if (door.open && door.opens === "vanish") {
    return out;
  }
  const len = Math.hypot(door.b.x - door.a.x, door.b.y - door.a.y) * u;
  const thick = door.panel !== undefined ? Math.max(1, BOARD * door.cell * u) : Math.max(1, door.thick * u);
  const leaf = Math.max(0.1, door.h - HEAD_GAP) * k;
  const tile = 2 * cell;
  const shut = Math.atan2(door.b.y - door.a.y, door.b.x - door.a.x);
  const pivot = new THREE.Group();
  pivot.position.set(door.a.x * u, door.a.y * u, ground * k);
  pivot.rotation.z = shut;
  const board = door.panel !== undefined;
  if (board) {
    // Against the wall's face, a thin board, shut: across it is along its normal (the pivot's y).
    const sign = Math.sign(door.panel!) || 1;
    const t = Math.max(1, BOARD * door.cell * u);
    const [nx, ny] = [-Math.sin(shut), Math.cos(shut)];
    const off = door.panel! * u + sign * (BOARD_GAP * door.cell * u + t / 2);
    pivot.position.x += nx * off;
    pivot.position.y += ny * off;
  } else if (door.open && door.opens === "swing") {
    pivot.rotation.z += (door.side * door.swing * Math.PI) / 180;
  } else if (door.open && door.opens === "slide") {
    // Back along the wall, past its hinge.
    pivot.position.x -= Math.cos(shut) * len;
    pivot.position.y -= Math.sin(shut) * len;
  } else if (door.open && door.opens === "lift") {
    pivot.position.z += leaf;
  }
  out.add(pivot);
  const along = (f: number): XY => ({ x: door.a.x + (door.b.x - door.a.x) * f, y: door.a.y + (door.b.y - door.a.y) * f });
  const middle = along(0.5);
  const mapColor = map?.color?.(middle.x, middle.y) ?? STONE;
  const side = (m: THREE.Material[]) => [m[1], m[1], m[0], m[0], m[2], m[1]];
  const three = (f: (shade: number) => THREE.MeshBasicMaterial) => side([f(SHADES.face), f(SHADES.edge), f(SHADES.top)]);
  const look = door.look;

  if (look === "bars") {
    const own = OWN.bars!;
    const faces = side([own.face, own.edge, own.top].map((color) => new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })));
    // Upright bars between a rail at the bottom and one at the top.
    const bar = Math.max(1, Math.min(thick, 0.06 * cell));
    const rail = Math.max(1, 0.08 * cell);
    const n = Math.max(2, Math.round(len / (BAR_GAP * cell)));
    for (let i = 0; i <= n; i++) {
      const x = Math.min(len - bar, Math.max(0, (i / n) * len - bar / 2));
      pivot.add(box(bar, bar, leaf, x, 0, tile, faces));
    }
    pivot.add(box(len, bar * 1.4, rail, 0, 0, tile, faces), box(len, bar * 1.4, rail, 0, leaf - rail, tile, faces));
    return out;
  }
  if (look === "glass") {
    // A frame round a pane.
    const frame = new THREE.MeshBasicMaterial({ color: FRAME_COLOR, side: THREE.DoubleSide });
    const fw = Math.min(FRAME * cell, len / 4, leaf / 4);
    pivot.add(box(fw, thick, leaf, 0, 0, tile, frame), box(fw, thick, leaf, len - fw, 0, tile, frame));
    pivot.add(box(len - 2 * fw, thick, fw, fw, 0, tile, frame), box(len - 2 * fw, thick, fw, fw, leaf - fw, tile, frame));
    const glass = new THREE.MeshBasicMaterial({ color: GLASS, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide });
    pivot.add(box(len - 2 * fw, Math.max(1, thick * 0.3), leaf - 2 * fw, fw, fw, tile, glass));
    return out;
  }

  let faces: THREE.Material[];
  let uvOf: ((x: number, z: number) => [number, number]) | null = null;
  const own = OWN[look];
  if (own) {
    const pattern = own.pattern ? patternTexture(own.pattern) : null;
    faces = side([own.face, own.edge, own.top].map((color) => new THREE.MeshBasicMaterial({ map: pattern, color, side: THREE.DoubleSide })));
  } else if ((look === "stretch" || look === "picture") && map?.texture) {
    // The map's picture: its pixels on the door's line, stretched up it; or its rectangle, as its face.
    const texture = map.texture;
    faces = three((s) => map.picture(new THREE.MeshBasicMaterial({ map: texture, color: new THREE.Color(s, s, s), side: THREE.DoubleSide })));
    const pic = door.picture;
    uvOf =
      look === "picture" && pic
        ? (x, z) => {
            const [t, up] = [x / len, 1 - z / leaf];
            return map.uv(pic.tl.x + (pic.tr.x - pic.tl.x) * t + (pic.bl.x - pic.tl.x) * up, pic.tl.y + (pic.tr.y - pic.tl.y) * t + (pic.bl.y - pic.tl.y) * up);
          }
        : (x) => {
            const p = along(x / len);
            return map.uv(p.x, p.y);
          };
  } else if (look === "stone" || look === "rubble" || look === "earth") {
    // The walls' patterns, tinted with the map's colour there as theirs are.
    const pattern = patternTexture(look);
    faces = three((s) => new THREE.MeshBasicMaterial({ map: pattern, color: shaded(mapColor, s), side: THREE.DoubleSide }));
  } else {
    // The map's colour there, plainly or blended (with the walls' grain).
    faces = three((s) => {
      const material = new THREE.MeshBasicMaterial({ color: shaded(mapColor, s), side: THREE.DoubleSide });
      return look === "blend" && map ? map.grain(material) : material;
    });
  }
  const mesh = box(len, thick, leaf, 0, 0, tile, faces);
  if (uvOf) {
    const position = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const uv = mesh.geometry.getAttribute("uv") as THREE.BufferAttribute;
    for (let v = 0; v < position.count; v++) uv.setXY(v, ...uvOf(position.getX(v), position.getZ(v)));
    uv.needsUpdate = true;
  }
  pivot.add(mesh);
  if (look === "metal") {
    // Two straps across it, standing out from both faces.
    const strap = new THREE.MeshBasicMaterial({ color: STRAP, side: THREE.DoubleSide });
    const sh = Math.max(1, leaf * 0.07);
    for (const z of [leaf * 0.22, leaf * 0.72]) pivot.add(box(len, thick * 1.35, sh, 0, z, tile, strap));
  }
  return out;
}
