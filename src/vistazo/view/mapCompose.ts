import * as THREE from "three";
import type { MapImage } from "../scene";
import { animationOf } from "./animated";
import { record, time } from "../../timing";

/**
 * The map images put together on the graphics card: each image cut in blocks (a texture each), drawn as
 * quads where the item has it, in z order, on a render target. What a 2D canvas used to do, without its
 * cost (seconds, on the page's own work, for big maps) nor its ceiling (one scene px a texel at most).
 *
 * Each block is kept small (all of them within a budget: see sourceDensity), for the ground's texture
 * and what's far; and, while it's where the camera looks (see sharpen), as its file has it too (within
 * another budget, those looked at longest ago let go first). So a map of many big files is as sharp as
 * they are where it's seen, not as they all fit at once.
 *
 * A box of the scene is drawn at any size: the whole map for the ground's texture (see compose), the
 * part the camera shows for the detail (see detail), a small one for the walls' colours and what's
 * under a bridge (see read). The images are read premultiplied (so a soft edge, filtered, doesn't
 * darken) and drawn over one another so, straight on the target: what's drawn stays premultiplied (its
 * mipmaps right that way too), turned back to straight where it's read (see DETAIL_GLSL; read, here).
 */

/** A map's picture: an image's, a video's, or an animation's canvas (see AnimatedImage). */
export type MapMedia = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;

/** A scene box, scene px (x0, y0: its top left). */
export type MapBox = { x0: number; y0: number; w: number; h: number };

/** Source px a block's side (before it's made smaller): within any graphics card's texture size. */
const BLOCK = 2048;
/** Texels of the next block's picture each block takes in at its edges, so no seam shows between them. */
const GUTTER = 2;

/** A block's picture as its file has it, while it's near where the camera looks (see sharpen). */
type Full = {
  img: HTMLImageElement;
  /** Its file (where it could be read): the block made from it off the page's work (see blockTexture). */
  file: Blob | null;
  /** Its part of the file (the small one's, gutter and all: the quad's uv fit both). */
  crop: [number, number, number, number];
  /** Where it is on the scene (scene px). */
  box: MapBox;
  texels: number;
  texture: THREE.Texture | null;
  bitmap: ImageBitmap | null;
  loading: boolean;
  /** When it was last wanted (see sharpen's count). */
  used: number;
};

/** A quad: its mesh, its small texture (or a video's), and its full one if it has one bigger. */
type Quad = { mesh: THREE.Mesh; texture: THREE.Texture; bitmap: ImageBitmap | null; full: Full | null };

/** What a composer's made of (see MapComposer.make). */
export type ComposerSizes = {
  /** The small blocks' texels a scene px (see sourceDensity). */
  px: number;
  /** The ground's texture's texels a scene px. */
  basePx: number;
  /** The detail's texture's side, texels. */
  detailSize: number;
  /** The full blocks' texels at most, loaded at once. */
  fullBudget: number;
};

export class MapComposer {
  /** The ground's texture: the whole box, at `width` x `height` (see compose). */
  readonly box: MapBox;
  readonly width: number;
  readonly height: number;
  /** The files' texels a scene px at most (as sharp as a box can be drawn: see detail). */
  readonly sharpest: number;
  /** The detail's texture's side, texels (see detail). */
  readonly detailSize: number;
  private quads: Quad[] = [];
  private stage = new THREE.Scene();
  private target: THREE.WebGLRenderTarget;
  /** The detail's texture (a square of `detailSize` texels) and the box it shows, once asked (see detail). */
  private detailTarget: THREE.WebGLRenderTarget | null = null;
  private shownBox: MapBox | null = null;
  /** Where the videos are (scene px): all that's drawn again at a new frame of theirs (see compose). */
  private videoBox: MapBox | null;
  /** The animations (GIFs: see AnimatedImage): where each is, and its frame last sent to the card. */
  private animated: { texture: THREE.Texture; canvas: HTMLCanvasElement; box: MapBox; sent: number }[];
  private fullBudget: number;
  /** Counts the times the full blocks are asked for (see Full.used). */
  private asked = 0;
  /** The renderer last drawn with (the full blocks, once loaded, sent to its card and drawn with it). */
  private renderer: THREE.WebGLRenderer | null = null;
  /** Full blocks loaded, waiting to be sent to the card a couple a frame (see sendSoon). */
  private sending: { full: Full; texture: THREE.Texture; bitmap: ImageBitmap | null }[] = [];
  private sendFrame = 0;
  private disposed = false;
  /** The target the map's read through (see read): kept for the next read, as big as the biggest yet. */
  private reader: THREE.WebGLRenderTarget | null = null;
  /** Told when the detail's drawn sharper on its own (its full blocks loaded). */
  private onSharper: () => void;
  private anisotropy: number;
  /** Whether the camera's moving: the full blocks wait to be sent to the card till it's still (see sendSoon). */
  busy: () => boolean = () => false;

  private constructor(
    box: MapBox,
    sizes: ComposerSizes,
    sharpest: number,
    quads: Quad[],
    videoBox: MapBox | null,
    animated: MapComposer["animated"],
    anisotropy: number,
    onSharper: () => void
  ) {
    this.box = box;
    this.width = Math.max(1, Math.ceil(box.w * sizes.basePx));
    this.height = Math.max(1, Math.ceil(box.h * sizes.basePx));
    this.sharpest = sharpest;
    this.detailSize = sizes.detailSize;
    this.fullBudget = sizes.fullBudget;
    this.quads = quads;
    this.videoBox = videoBox;
    this.animated = animated;
    this.onSharper = onSharper;
    quads.forEach((quad, i) => {
      quad.mesh.renderOrder = i;
      this.stage.add(quad.mesh);
    });
    this.anisotropy = anisotropy;
    this.target = shownTarget(this.width, this.height, anisotropy);
  }

  /**
   * The images (each map's element, loaded: an <img>, or a <video> at a frame) cut in blocks, small at
   * `sizes.px` texels a scene px (no more than each file has); the ground's texture over `box`.
   * `onSharper`: told when the detail's drawn sharper on its own (see sharpen). Null if they can't be read.
   */
  static async make(
    maps: MapImage[],
    media: MapMedia[],
    box: MapBox,
    sizes: ComposerSizes,
    anisotropy: number,
    onSharper: () => void
  ): Promise<MapComposer | null> {
    // All at once (the browser makes the blocks off the page's work), in the maps' order.
    const made = await Promise.allSettled(
      maps.map((map, i) => {
        const element = media[i];
        return element instanceof HTMLImageElement ? imageQuads(map, element, sizes.px) : Promise.resolve([videoQuad(map, element)]);
      })
    );
    const failed = made.find((result): result is PromiseRejectedResult => result.status === "rejected");
    const quads = made.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    // One that can't be cut (its own quads dropped already, see imageQuads): left out, the rest drawn.
    if (failed) {
      if (quads.length === 0) {
        console.error("Rising Ranges: Vistazo couldn't cut the map images in blocks", failed.reason);
        return null;
      }
      console.warn("Rising Ranges: Vistazo couldn't cut a map image in blocks, leaving it out", failed.reason);
    }
    // Where the videos are, and each animation (drawn again at their new frames).
    const videos = maps.map((map, i) => (media[i] instanceof HTMLVideoElement ? boxOf(map.corners) : null)).filter((b): b is MapBox => b !== null);
    const videoBox = videos.length > 0 ? videos.reduce(union) : null;
    const animated: MapComposer["animated"] = [];
    maps.forEach((map, i) => {
      const canvas = media[i];
      const result = made[i];
      if (canvas instanceof HTMLCanvasElement && result.status === "fulfilled" && result.value[0]) {
        animated.push({ texture: result.value[0].texture, canvas, box: boxOf(map.corners), sent: -1 });
      }
    });
    return new MapComposer(box, sizes, sourceDensity(maps, media, Infinity) || sizes.px, quads, videoBox, animated, anisotropy, onSharper);
  }

  /** The ground's texture (drawn by compose), premultiplied. */
  get texture(): THREE.Texture {
    return this.target.texture;
  }

  /** The ground's texels a scene px. */
  get baseDensity(): number {
    return this.width / this.box.w;
  }

  /** The detail's texture and the box it shows (scene px), if there's one (see detail). */
  get shown(): { texture: THREE.Texture; box: MapBox } | null {
    return this.detailTarget && this.shownBox ? { texture: this.detailTarget.texture, box: this.shownBox } : null;
  }

  /** Whether `texture` is this one's (let go with it, not on its own: see dispose). */
  owns(texture: THREE.Texture | null): boolean {
    return texture === this.target.texture;
  }

  /**
   * The ground's texture drawn, and the detail's if there's one: all of them (a new renderer, whose card
   * had none of it); or, at new frames (`frames`), only where they are: the videos' (if `videos`, a new
   * frame of theirs) and each animation's that's gone on since (its canvas sent again only then). Each
   * such part drawn on its own (not the box round them all, maybe most of the map); the smaller copies
   * made once, after the last. Whether anything was drawn.
   */
  compose(renderer: THREE.WebGLRenderer, frames?: { videos: boolean }): boolean {
    this.renderer = renderer;
    const parts: (MapBox | null)[] = frames ? [] : [null];
    if (frames?.videos && this.videoBox) {
      parts.push(this.videoBox);
    }
    for (const animation of this.animated) {
      const version = animationOf(animation.canvas)?.version ?? 0;
      if (!frames || version !== animation.sent) {
        animation.sent = version;
        animation.texture.needsUpdate = true;
        if (frames) {
          parts.push(animation.box);
        }
      }
    }
    if (parts.length === 0) {
      return false;
    }
    this.drawParts(renderer, this.box, this.target, parts, true);
    if (this.detailTarget && this.shownBox) {
      // Its smaller copies made again with each frame too: seen a bit far off or slanting, they're what
      // shows (made less often, a video there would jump).
      const shown = this.shownBox;
      this.drawParts(renderer, shown, this.detailTarget, parts.filter((part) => !part || meets(part, shown)), true);
    }
    return true;
  }

  /** A box of the map drawn on `into` within each of `parts` (null: all of it), its smaller copies made after the last (if `mip`). */
  private drawParts(renderer: THREE.WebGLRenderer, box: MapBox, into: THREE.WebGLRenderTarget, parts: (MapBox | null)[], mip: boolean) {
    const texture = into.texture;
    try {
      parts.forEach((part, i) => {
        texture.generateMipmaps = mip && i === parts.length - 1;
        this.draw(renderer, box, into, part);
      });
    } finally {
      texture.generateMipmaps = true;
    }
  }

  /**
   * The detail drawn over `box` (a square, scene px; null: none, the ground's texture alone): now with
   * the blocks there are, again once those near it are loaded as their files have them (see sharpen),
   * if `sharp` (the camera still: moving, it asks for them once it stops, see sharpenShown).
   */
  detail(renderer: THREE.WebGLRenderer, box: MapBox | null, sharp = true) {
    this.renderer = renderer;
    this.shownBox = box;
    if (!box) {
      return;
    }
    this.detailTarget ??= time("3d.detail.target", () => shownTarget(this.detailSize, this.detailSize, this.anisotropy));
    time("3d.detail.draw", () => this.draw(renderer, box, this.detailTarget!, null));
    if (sharp) {
      void this.sharpen(box);
    }
  }

  /** The full blocks of the detail there is asked for (drawn while the camera moved, without them). */
  sharpenShown() {
    if (this.shownBox && this.renderer) {
      void this.sharpen(this.shownBox);
    }
  }

  /**
   * The blocks in `box` as their files have them: those nearest its middle first, as many as the budget
   * holds (those not wanted, looked at longest ago, let go to make room). Once they're in (sent to the
   * card a couple a frame, see sendSoon), the detail's drawn again and onSharper told.
   */
  private async sharpen(box: MapBox) {
    const asked = ++this.asked;
    const [mx, my] = [box.x0 + box.w / 2, box.y0 + box.h / 2];
    // Those loaded already a bit nearer: not let go for one hardly nearer, to be asked back a moment later.
    const away = (full: Full) => Math.hypot(full.box.x0 + full.box.w / 2 - mx, full.box.y0 + full.box.h / 2 - my) * (full.texture ? 0.75 : 1);
    const wanted = this.quads
      .map((quad) => quad.full)
      .filter((full): full is Full => full !== null && meets(full.box, box))
      .sort((a, b) => away(a) - away(b));
    // As many as fit, nearest first.
    const chosen = new Set<Full>();
    let room = this.fullBudget;
    for (const full of wanted) {
      if (full.texels <= room) {
        chosen.add(full);
        room -= full.texels;
        full.used = asked;
      }
    }
    // Room for them: those not chosen let go, looked at longest ago first; those loading and not chosen
    // now, dropped once they're in (see loadFull, sendSoon).
    const all = this.quads.map((quad) => quad.full).filter((full): full is Full => full !== null);
    for (const full of all) {
      if (full.loading && !chosen.has(full)) {
        full.loading = false;
      }
    }
    let held = all.filter((full) => full.texture || full.loading).reduce((sum, full) => sum + full.texels, 0);
    const coming = [...chosen].filter((full) => !full.texture && !full.loading).reduce((sum, full) => sum + full.texels, 0);
    for (const full of all.filter((f) => f.texture && !chosen.has(f)).sort((a, b) => a.used - b.used)) {
      if (held + coming <= this.fullBudget) {
        break;
      }
      held -= full.texels;
      this.letGo(full);
    }
    const load = [...chosen].filter((full) => !full.texture && !full.loading);
    if (load.length === 0) {
      return;
    }
    for (const full of load) {
      full.loading = true;
    }
    // Those of one file cut from its picture decoded once (see withWhole), not each decoding it whole.
    const byFile = new Map<Blob | null, Full[]>();
    for (const full of load) {
      byFile.set(full.file, [...(byFile.get(full.file) ?? []), full]);
    }
    await Promise.all(
      [...byFile].map(([file, fulls]) =>
        file ? withWhole(file, (whole) => Promise.all(fulls.map((full) => this.loadFull(full, whole ?? full.img)))) : Promise.all(fulls.map((full) => this.loadFull(full, full.img)))
      )
    );
  }

  /** A block's full picture made (off the page's work, from `source`), to be sent to the card (see sendSoon). */
  private async loadFull(full: Full, source: HTMLImageElement | ImageBitmap) {
    // Let go while it waited its turn: not made.
    if (this.disposed || !full.loading) {
      full.loading = false;
      return;
    }
    try {
      const [cx, cy, cw, ch] = full.crop;
      const { texture, bitmap } = await blockTexture(source, full.img, cx, cy, cw, ch, cw, ch);
      if (this.disposed || !full.loading) {
        texture.dispose();
        bitmap?.close();
        full.loading = false;
        return;
      }
      // Still loading till it's on the card (let go meanwhile: dropped there, see sendSoon).
      this.sending.push({ full, texture, bitmap });
      this.sendSoon();
    } catch {
      full.loading = false;
    }
  }

  /**
   * The full blocks loaded sent to the card one a frame, and none while the camera moves (sending one,
   * its mipmaps made, is several milliseconds: a moving camera would stutter), each put on its quad once
   * it's there; when they're all sent, the detail drawn again with them and onSharper told.
   */
  private sendSoon() {
    if (this.sendFrame || this.disposed) {
      return;
    }
    this.sendFrame = requestAnimationFrame(() => {
      this.sendFrame = 0;
      const renderer = this.renderer;
      if (this.disposed || !renderer) {
        return;
      }
      if (this.busy()) {
        this.sendSoon();
        return;
      }
      for (const { full, texture, bitmap } of this.sending.splice(0, 1)) {
        // Let go while it was loading: not wanted now.
        if (!full.loading) {
          texture.dispose();
          bitmap?.close();
          continue;
        }
        renderer.initTexture(texture);
        full.texture = texture;
        full.bitmap = bitmap;
        full.loading = false;
        const quad = this.quads.find((q) => q.full === full);
        if (quad) {
          (quad.mesh.material as THREE.MeshBasicMaterial).map = texture;
        }
      }
      if (this.sending.length > 0) {
        this.sendSoon();
        return;
      }
      // All in: the detail drawn again with them, if it's still there to.
      if (this.detailTarget && this.shownBox) {
        this.draw(renderer, this.shownBox, this.detailTarget, null);
        this.onSharper();
      }
    });
  }

  /** A block's full picture let go: its quad back on its small one. */
  private letGo(full: Full) {
    const quad = this.quads.find((q) => q.full === full);
    if (quad) {
      (quad.mesh.material as THREE.MeshBasicMaterial).map = quad.texture;
    }
    full.texture?.dispose();
    full.bitmap?.close();
    full.texture = null;
    full.bitmap = null;
    full.loading = false;
  }

  /** A box of the map at `cols` x `rows`, its pixels (RGBA, straight, rows from the box's top down). */
  read(renderer: THREE.WebGLRenderer, box: MapBox, cols: number, rows: number): Uint8ClampedArray {
    // One target for every read (made bigger as needed), drawn in its bottom left corner.
    let out = this.reader;
    if (!out || out.width < cols || out.height < rows) {
      out?.dispose();
      out = new THREE.WebGLRenderTarget(Math.max(cols, out?.width ?? 0), Math.max(rows, out?.height ?? 0), {
        generateMipmaps: false,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
      });
      this.reader = out;
    }
    {
      this.draw(renderer, box, out, null, [cols, rows]);
      const bottomUp = new Uint8Array(cols * rows * 4);
      renderer.readRenderTargetPixels(out, 0, 0, cols, rows, bottomUp);
      // Read from the bottom row up: turned over, as a canvas's; and straight (a texel partly covered its own colour, not darkened).
      const pixels = new Uint8ClampedArray(cols * rows * 4);
      const row = cols * 4;
      for (let j = 0; j < rows; j++) {
        pixels.set(bottomUp.subarray((rows - 1 - j) * row, (rows - j) * row), j * row);
      }
      for (let i = 0; i < pixels.length; i += 4) {
        const a = pixels[i + 3];
        if (a > 0 && a < 255) {
          pixels[i] = (pixels[i] * 255) / a;
          pixels[i + 1] = (pixels[i + 1] * 255) / a;
          pixels[i + 2] = (pixels[i + 2] * 255) / a;
        }
      }
      return pixels;
    }
  }

  /**
   * A box of the map drawn on `into` (premultiplied); only within `only` (scene px) if given, the rest
   * kept as it was; or over `size` texels from its bottom left only (a read, see read). The renderer
   * left as it was.
   */
  private draw(renderer: THREE.WebGLRenderer, box: MapBox, into: THREE.WebGLRenderTarget, only: MapBox | null, size?: [number, number]) {
    // Within `only`, in the targets' texels (from their bottom left), a texel more round it for the filtering.
    let scissor: THREE.Vector4 | null = null;
    if (only) {
      const kx = into.width / box.w;
      const ky = into.height / box.h;
      const x0 = Math.max(0, Math.floor((only.x0 - box.x0) * kx) - 1);
      const x1 = Math.min(into.width, Math.ceil((only.x0 + only.w - box.x0) * kx) + 1);
      const top = Math.max(0, Math.floor((only.y0 - box.y0) * ky) - 1);
      const bottom = Math.min(into.height, Math.ceil((only.y0 + only.h - box.y0) * ky) + 1);
      if (x1 <= x0 || bottom <= top) {
        return;
      }
      scissor = new THREE.Vector4(x0, into.height - bottom, x1 - x0, bottom - top);
    }
    const before = renderer.getRenderTarget();
    const clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    // Scene y down; the box's top at the target's top (as a canvas's first row: the ground's uv, see uvBox).
    const camera = new THREE.OrthographicCamera(box.x0, box.x0 + box.w, -box.y0, -(box.y0 + box.h), -1, 1);
    if (size) {
      into.viewport.set(0, 0, size[0], size[1]);
    }
    into.scissorTest = scissor !== null;
    if (scissor) {
      into.scissor.copy(scissor);
    }
    try {
      renderer.autoClear = false;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(into);
      renderer.clear(true, false, false);
      renderer.render(this.stage, camera);
    } finally {
      into.scissorTest = false;
      into.viewport.set(0, 0, into.width, into.height);
      renderer.setRenderTarget(before);
      renderer.setClearColor(clearColor, clearAlpha);
      renderer.autoClear = autoClear;
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.sendFrame);
    this.sendFrame = 0;
    for (const { texture, bitmap } of this.sending.splice(0)) {
      texture.dispose();
      bitmap?.close();
    }
    for (const quad of this.quads) {
      if (quad.full) {
        this.letGo(quad.full);
      }
      dropQuad(quad);
    }
    this.quads = [];
    this.target.dispose();
    this.detailTarget?.dispose();
    this.detailTarget = null;
    this.reader?.dispose();
    this.reader = null;
    this.shownBox = null;
  }
}

/**
 * A texture shown on the terrain, with its mipmaps for far off (made again each time it's drawn, a
 * video's frames too: a fraction of drawing it).
 */
function shownTarget(width: number, height: number, anisotropy: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, {
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  target.texture.anisotropy = anisotropy;
  // Let go with the composer only, not with a material that shows it (see isShared).
  target.texture.userData.shared = true;
  return target;
}

/** Drawn premultiplied over what's there (the images are read premultiplied too). */
function quadMaterial(texture: THREE.Texture): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    // Flipped (a negative scale) seen from behind.
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
}

/** Where a quad's corners are on the scene (scene px, y down), from the item's px through its transform. */
function sceneCorners(map: MapImage, inner: [number, number, number, number]): [number, number][] {
  const m = new DOMMatrix(map.transform);
  const [left, top, right, bottom] = inner;
  return (
    [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ] as [number, number][]
  ).map(([x, y]) => {
    const p = m.transformPoint(new DOMPoint(x, y));
    return [p.x, p.y];
  });
}

/**
 * A quad over a part of a map image: `inner` (the item's px: left, top, right, bottom; a block's edge
 * worked out the same as its neighbour's, so no line between them goes undrawn) where the map has it on
 * the scene (y turned up, see draw), its texture's `crop` (the item's px: x, y, w, h) over it.
 */
function quadMesh(map: MapImage, inner: [number, number, number, number], crop: [number, number, number, number], texture: THREE.Texture): THREE.Mesh {
  const [left, top, right, bottom] = inner;
  const [cx, cy, cw, ch] = crop;
  const corners = sceneCorners(map, inner);
  const own: [number, number][] = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ];
  const position = new Float32Array(12);
  const uv = new Float32Array(8);
  corners.forEach(([x, y], k) => {
    position.set([x, -y, 0], k * 3);
    // flipY off: v = 0 at the picture's first row.
    uv.set([(own[k][0] - cx) / cw, (own[k][1] - cy) / ch], k * 2);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return new THREE.Mesh(geometry, quadMaterial(texture));
}

/** A video's (or an animation's canvas, see AnimatedImage) quad: one texture over the whole map item. */
function videoQuad(map: MapImage, source: HTMLVideoElement | HTMLCanvasElement): Quad {
  const texture = source instanceof HTMLVideoElement ? new THREE.VideoTexture(source) : new THREE.CanvasTexture(source);
  texture.flipY = false;
  texture.premultiplyAlpha = true;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  // Sent at the frame it's on: a paused one (not played) shows no new frame to say so.
  texture.needsUpdate = true;
  return { mesh: quadMesh(map, [0, 0, map.width, map.height], [0, 0, map.width, map.height], texture), texture, bitmap: null, full: null };
}

/**
 * An image map in blocks of BLOCK file px, each made as small as `px` texels a scene px wants (never
 * bigger than the file), off the page's work (createImageBitmap); with a canvas where that can't. A block
 * made smaller has its full picture to load when the camera's near it (see MapComposer.sharpen).
 */
async function imageQuads(map: MapImage, img: HTMLImageElement, px: number): Promise<Quad[]> {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  if (W === 0 || H === 0 || map.width <= 0 || map.height <= 0) {
    return [];
  }
  // File px an item px, and the file's texels a scene px.
  const file = W / map.width;
  const native = file / Math.max(1e-9, scaleOf(map));
  const f = Math.min(1, px / native);
  const gutter = Math.min(BLOCK / 4, Math.ceil(GUTTER / f));
  // Its file decoded once, off the page's work, and the small blocks cut from that (see withWhole): cut
  // from the <img>, each one decoded the whole picture again on the page's own work (a big map: 400 ms,
  // the page stuck, each). The full blocks are cut from the file again later, the same way (see sharpen).
  const source = await fileOf(img);
  let usable = false;
  const cut = (whole: ImageBitmap | null) => {
    usable = !!whole;
    return Promise.allSettled(blocks(whole ?? img));
  };
  const t0 = performance.now();
  const settled = source ? await withWhole(source, cut) : await cut(null);
  record(usable ? "map.blocks (decoded off the page)" : "map.blocks (cut from the <img>)", performance.now() - t0);
  const quads = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) {
    quads.forEach(dropQuad);
    throw failed.reason;
  }
  return quads;

  // All its blocks asked for at once (the browser makes them side by side), placed in order.
  function blocks(from: HTMLImageElement | ImageBitmap): Promise<Quad>[] {
    const made: Promise<Quad>[] = [];
    for (let by = 0; by < H; by += BLOCK) {
      for (let bx = 0; bx < W; bx += BLOCK) {
        const bw = Math.min(BLOCK, W - bx);
        const bh = Math.min(BLOCK, H - by);
        const cx = Math.max(0, bx - gutter);
        const cy = Math.max(0, by - gutter);
        const cw = Math.min(W, bx + bw + gutter) - cx;
        const ch = Math.min(H, by + bh + gutter) - cy;
        const ow = Math.max(1, Math.round(cw * f));
        const oh = Math.max(1, Math.round(ch * f));
        made.push(
          blockTexture(from, img, cx, cy, cw, ch, ow, oh).then(({ texture, bitmap }) => {
            // In the item's px (the file may be another size).
            const inner: [number, number, number, number] = [bx / file, by / file, (bx + bw) / file, (by + bh) / file];
            const full: Full | null =
              f < 1 ? { img, file: usable ? source : null, crop: [cx, cy, cw, ch], box: boxOf(sceneCorners(map, inner)), texels: cw * ch, texture: null, bitmap: null, loading: false, used: 0 } : null;
            return { mesh: quadMesh(map, inner, [cx / file, cy / file, cw / file, ch / file], texture), texture, bitmap, full };
          })
        );
      }
    }
    return made;
  }
}

/** An <img>'s file, read again (from the browser's cache: the <img> read it the same way, anonymous); null where it can't be. */
async function fileOf(img: HTMLImageElement): Promise<Blob | null> {
  try {
    const response = await fetch(img.currentSrc || img.src, { mode: "cors", credentials: "omit" });
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

/**
 * One whole picture decoded at a time (each is its width × height × 4 bytes: a big scene's maps, or a
 * map's full blocks, each decoding it at once, would take gigabytes).
 */
let wholeTurn: Promise<unknown> = Promise.resolve();

/**
 * A file's picture decoded whole, off the page's work, in its turn (see wholeTurn), for `use` (null if
 * the browser can't decode it so: `use` cuts from the <img> then), and let go after.
 */
function withWhole<T>(file: Blob, use: (whole: ImageBitmap | null) => Promise<T>): Promise<T> {
  const run = wholeTurn.then(async () => {
    let whole: ImageBitmap | null = null;
    try {
      whole = await createImageBitmap(file, { premultiplyAlpha: "premultiply" });
    } catch {
      whole = null;
    }
    try {
      return await use(whole);
    } finally {
      whole?.close();
    }
  });
  wholeTurn = run.catch(() => {});
  return run;
}

/**
 * A block of an image at `ow` x `oh`, premultiplied, first row first: an ImageBitmap (from `source`: a
 * file or a decoded picture is cut off the page's work, an <img> on it), or a canvas (drawn from `img`).
 */
async function blockTexture(source: HTMLImageElement | ImageBitmap | Blob, img: HTMLImageElement, cx: number, cy: number, cw: number, ch: number, ow: number, oh: number): Promise<{ texture: THREE.Texture; bitmap: ImageBitmap | null }> {
  let texture: THREE.Texture;
  let bitmap: ImageBitmap | null = null;
  try {
    // Premultiplied as it's made (an ImageBitmap's isn't changed on its way to the card).
    bitmap = await createImageBitmap(source, cx, cy, cw, ch, { resizeWidth: ow, resizeHeight: oh, resizeQuality: "high", premultiplyAlpha: "premultiply" });
    texture = new THREE.Texture(bitmap);
  } catch {
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = [ow, oh];
    const context = canvas.getContext("2d")!;
    context.imageSmoothingQuality = "high";
    context.drawImage(img, cx, cy, cw, ch, 0, 0, ow, oh);
    texture = new THREE.CanvasTexture(canvas);
    // Premultiplied on its way to the card.
    texture.premultiplyAlpha = true;
  }
  texture.flipY = false;
  texture.needsUpdate = true;
  return { texture, bitmap };
}

/** The scene px an item px takes (its transform's scale, the longer way if they differ). */
function scaleOf(map: MapImage): number {
  const m = new DOMMatrix(map.transform);
  return Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
}

/** The box round some scene points. */
function boxOf(points: [number, number][]): MapBox {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  return { x0, y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

function union(a: MapBox, b: MapBox): MapBox {
  const x0 = Math.min(a.x0, b.x0);
  const y0 = Math.min(a.y0, b.y0);
  return { x0, y0, w: Math.max(a.x0 + a.w, b.x0 + b.w) - x0, h: Math.max(a.y0 + a.h, b.y0 + b.h) - y0 };
}

/** Whether two boxes overlap. */
function meets(a: MapBox, b: MapBox): boolean {
  return a.x0 < b.x0 + b.w && b.x0 < a.x0 + a.w && a.y0 < b.y0 + b.h && b.y0 < a.y0 + a.h;
}

/**
 * The texels a scene px for the small blocks: the densest file's, as far as `budget` texels for all of
 * them lets (a map's file less dense than that kept whole; videos aren't made smaller, not counted).
 * With no budget (Infinity), the densest file's.
 */
export function sourceDensity(maps: MapImage[], media: MapMedia[], budget: number): number {
  const images = maps
    .map((map, i) => ({ map, element: media[i] }))
    .filter((entry): entry is { map: MapImage; element: HTMLImageElement } => entry.element instanceof HTMLImageElement && entry.element.naturalWidth > 0 && entry.map.width > 0)
    .map(({ map, element }) => ({ texels: element.naturalWidth * element.naturalHeight, native: element.naturalWidth / map.width / Math.max(1e-9, scaleOf(map)) }));
  const top = Math.max(0, ...images.map((image) => image.native));
  const texels = (px: number) => images.reduce((sum, image) => sum + image.texels * Math.min(1, px / image.native) ** 2, 0);
  if (top === 0 || texels(top) <= budget) {
    return top;
  }
  // The most within the budget (more texels the denser: halved till it's found).
  let [low, high] = [0, top];
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2;
    if (texels(mid) <= budget) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

function dropQuad(quad: Quad) {
  quad.mesh.geometry.dispose();
  (quad.mesh.material as THREE.Material).dispose();
  quad.texture.dispose();
  quad.bitmap?.close();
}
