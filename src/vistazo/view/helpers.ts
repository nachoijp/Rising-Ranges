import type { TerrainSkin } from "../../terrain/terrain";
import type { Prop, Token, VistazoScene } from "../scene";
import type { VisibleBox } from "../visibleBox";

// Small pieces of the Vistazo's view (see render.ts) that need nothing of it.

/**
 * Where along a wall (0 to 1) the height n is on its face: its bottom runs
 * b0 to b1 and its top t0 to t1, both straight, so it's where b ≤ n ≤ t.
 */
export function within(b0: number, b1: number, t0: number, t1: number, n: number): [number, number] | null {
  let lo = 0;
  let hi = 1;
  // f(s) = f0 + (f1 − f0)·s ≥ 0, narrowing [lo, hi].
  const atLeast = (f0: number, f1: number) => {
    if (Math.abs(f1 - f0) < 1e-9) {
      if (f0 < 0) {
        hi = -1;
      }
      return;
    }
    const s = -f0 / (f1 - f0);
    if (f1 > f0) {
      lo = Math.max(lo, s);
    } else {
      hi = Math.min(hi, s);
    }
  };
  atLeast(n - b0, n - b1);
  atLeast(t0 - n, t1 - n);
  return hi - lo > 1e-6 ? [lo, hi] : null;
}

/** What of the props needs them drawn again when it changes (where they are, turned and raised, is moved in place). */
export function propsKey(props: VistazoScene["props"]): string {
  return JSON.stringify(props.map((prop) => [prop.id, prop.size, prop.radius, prop.width, prop.height, prop.url, Math.sign(prop.own), prop.name]));
}

/**
 * An image's element: an <img>, or for a video (webm), a muted looping
 * <video> playing like Owlbear plays it. Readable by a canvas either way (CORS).
 */
export function mediaElement(url: string, video: boolean): HTMLImageElement | HTMLVideoElement {
  if (!video) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.draggable = false;
    return img;
  }
  const element = document.createElement("video");
  element.crossOrigin = "anonymous";
  element.muted = true;
  element.loop = true;
  element.autoplay = true;
  element.playsInline = true;
  element.src = url;
  void element.play().catch(() => {});
  return element;
}

/**
 * A video let go: stopped and emptied, so the browser stops decoding it. One that's never been on the
 * page (a texture's) isn't paused by the browser when it's dropped: it would play on, unseen, for good.
 */
export function stopVideo(video: HTMLVideoElement) {
  video.onloadeddata = null;
  video.pause();
  video.removeAttribute("src");
  video.load();
}

/** A prop as the token-like parts of its view read it (place, size, label). */
export function propToken(prop: Prop): Token {
  return { id: prop.id, name: prop.name, url: prop.url, video: prop.video, item: prop.item, base: prop.base, radius: prop.radius, x: prop.x, y: prop.y, size: prop.size, terrain: prop.terrain, own: prop.own, rotation: prop.rotation, flipX: false, flipY: false, hidden: false } as Token;
}

/**
 * Where the part of a picture that shows is, from the middle of its square
 * of side `d` (px): fitted in it as the image is (contain), and turned and
 * flipped as it's drawn (rotate, then scale, in CSS).
 */
export function visibleOnScreen(box: VisibleBox, d: number, token: Token) {
  const w = box.aspect >= 1 ? d : d * box.aspect;
  const h = box.aspect >= 1 ? d / box.aspect : d;
  const angle = (token.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const place = (bx: number, by: number) => {
    const px = (bx - 0.5) * w * (token.flipX ? -1 : 1);
    const py = (by - 0.5) * h * (token.flipY ? -1 : 1);
    return { x: px * cos - py * sin, y: px * sin + py * cos };
  };
  const shown = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, base: place(box.base, box.y1).x };
  for (const [bx, by] of [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x1, box.y1],
    [box.x0, box.y1],
  ]) {
    const { x, y } = place(bx, by);
    shown.x0 = Math.min(shown.x0, x);
    shown.x1 = Math.max(shown.x1, x);
    shown.y0 = Math.min(shown.y0, y);
    shown.y1 = Math.max(shown.y1, y);
  }
  return shown;
}

/** What a token stands on, grid units: a bridge's top, or the terrain under it. */
export function floorOf(token: Token): number {
  return token.bridge ?? token.terrain;
}

/** Whether a token is off what it stands on (flying, or sunk): then its line down (or up) is drawn. */
export function raised(token: Token): boolean {
  return token.terrain + token.own !== floorOf(token);
}

/**
 * Where round a zone a point is, as a way across its picture (0 to 1): by
 * its angle about the zone's middle, there and back (a picture painted from
 * one side shows the front; going round, the back is its mirror, so the
 * seam doesn't show).
 */
export function skinAcross(skin: TerrainSkin, x: number, y: number): number {
  const turn = (Math.atan2(y - skin.center.y, x - skin.center.x) / (2 * Math.PI) + 1) % 1;
  return 1 - Math.abs(2 * turn - 1);
}

/** The scene point (px) of a skin's picture `across` (0–1) and `up` (0 at its foot, 1 at its far end). */
export function skinPoint(skin: TerrainSkin, across: number, up: number): [number, number] {
  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const foot = lerp(skin.base[0], skin.base[1], across);
  const head = lerp(skin.top[0], skin.top[1], across);
  const p = lerp(foot, head, up);
  return [p.x, p.y];
}
