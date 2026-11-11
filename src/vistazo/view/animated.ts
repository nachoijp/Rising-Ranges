import { decompressFrame, parseGIF } from "gifuct-js";

/**
 * Animated images (GIF, animated WebP): an <img> on a texture shows their first frame only. Read here
 * frame by frame (not all of them held at once), onto a canvas of their size that's sent again as a
 * texture at each new frame, on the frames' own times, looping as Owlbear shows them.
 *
 * Read with the browser's ImageDecoder where there is one (it needs a secure page: not a dev server's
 * http one, nor every browser has it); a GIF without it, in JS (gifuct-js), each frame put over the last
 * as the file says. An animated WebP without it, or a file neither can read, stays still, as before.
 */

/** Whether the browser reads animated images itself (see AnimatedImage.open). */
const hasDecoder = () => typeof ImageDecoder !== "undefined";

/** Whether an image of this type may be animated (worth reading its frames: see AnimatedImage.open). */
export function mayAnimate(mime: string | undefined): boolean {
  return mime === "image/gif" || (mime === "image/webp" && hasDecoder());
}

/** The animation drawing on a canvas (see AnimatedImage.canvas), if it's one's. */
const animations = new WeakMap<HTMLCanvasElement, AnimatedImage>();

export function animationOf(source: unknown): AnimatedImage | null {
  return source instanceof HTMLCanvasElement ? (animations.get(source) ?? null) : null;
}

/** Browsers show a GIF frame of 10 ms or less (or none) for 100 ms. */
const SHORTEST_FRAME_MS = 10;
const DEFAULT_FRAME_MS = 100;

/** An animation's frames, however they're read: each drawn on the canvas whole, and how long it stays (ms). */
type Frames = {
  count: number;
  width: number;
  height: number;
  /** Whether a frame reads the canvas back (its canvas kept off the graphics card then: see gifFrames). */
  readsBack: boolean;
  /** Drawn in order (0 after the last): a GIF's frame is put over the one before it. */
  draw(index: number, context: CanvasRenderingContext2D): Promise<number>;
  close(): void;
};

export class AnimatedImage {
  /** Its frame now, at the file's size. */
  readonly canvas: HTMLCanvasElement;
  /** Told after each new frame's drawn on the canvas (while it plays). */
  onFrame: (() => void) | null = null;
  /** Counts the frames drawn (a texture of it sent again only when it's gone on: see MapComposer.compose). */
  version = 0;
  private context: CanvasRenderingContext2D;
  private frames: Frames;
  private index = 0;
  /** How long the frame shown now stays, ms. */
  private duration = DEFAULT_FRAME_MS;
  private timer = 0;
  private playing = false;
  private closed = false;

  private constructor(frames: Frames) {
    this.frames = frames;
    this.canvas = document.createElement("canvas");
    this.canvas.width = Math.max(1, frames.width);
    this.canvas.height = Math.max(1, frames.height);
    // On the graphics card (drawn there, sent to a texture there), unless a frame reads it back (see gifFrames).
    this.context = this.canvas.getContext("2d", { willReadFrequently: frames.readsBack })!;
    animations.set(this.canvas, this);
  }

  /**
   * The file at `url` read as an animation, its first frame drawn; null if it isn't one (a single frame),
   * or it can't be read (no way to here, CORS): then shown still, as an image.
   */
  static async open(url: string, mime: string): Promise<AnimatedImage | null> {
    if (!mayAnimate(mime)) {
      return null;
    }
    let frames: Frames | null = null;
    try {
      const native = hasDecoder() && (await ImageDecoder.isTypeSupported(mime));
      if (!native && mime !== "image/gif") {
        return null;
      }
      // Most likely from the cache (the <img> read it the same way, anonymous).
      const response = await fetch(url, { mode: "cors", credentials: "omit" });
      if (!response.ok || !response.body) {
        return null;
      }
      const data = await readIfAnimated(response.body, mime);
      if (!data) {
        return null;
      }
      // The browser's reader; a GIF it finds no frames in, read in JS all the same.
      frames = native ? await decoderFrames(data, mime) : null;
      if (!frames && mime === "image/gif") {
        frames = gifFrames(data);
      }
      if (!frames) {
        return null;
      }
      const made = new AnimatedImage(frames);
      await made.drawFrame(0);
      return made;
    } catch {
      frames?.close();
      return null;
    }
  }

  /** On from the frame it's at (looping). */
  play() {
    if (this.playing || this.closed) {
      return;
    }
    this.playing = true;
    this.schedule();
  }

  /** Still at the frame it's at. */
  pause() {
    this.playing = false;
    window.clearTimeout(this.timer);
    this.timer = 0;
  }

  /** Let go for good (its decoder's memory). */
  close() {
    this.pause();
    this.closed = true;
    this.onFrame = null;
    animations.delete(this.canvas);
    this.frames.close();
  }

  private schedule() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.next(), this.duration);
  }

  /** The next frame drawn, then the one after it waited for. */
  private async next() {
    this.timer = 0;
    if (!this.playing || this.closed) {
      return;
    }
    try {
      await this.drawFrame((this.index + 1) % this.frames.count);
      if (this.closed) {
        return;
      }
      this.onFrame?.();
    } catch {
      // A frame it can't read: stopped there.
      this.pause();
      return;
    }
    if (this.playing) {
      this.schedule();
    }
  }

  private async drawFrame(index: number) {
    const ms = await this.frames.draw(index, this.context);
    this.index = index;
    this.version++;
    this.duration = ms > SHORTEST_FRAME_MS ? ms : DEFAULT_FRAME_MS;
  }
}

/** The browser's own reader's frames (each whole: it puts them together); null if there's one only. */
async function decoderFrames(data: Uint8Array, mime: string): Promise<Frames | null> {
  const decoder = new ImageDecoder({ data, type: mime });
  try {
    // Its tracks known (none till then), and all of it read: its frames counted.
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    if (!track || !track.animated || track.frameCount < 2) {
      decoder.close();
      return null;
    }
    const { image: first } = await decoder.decode({ frameIndex: 0 });
    const [width, height] = [first.displayWidth, first.displayHeight];
    first.close();
    return {
      count: track.frameCount,
      width,
      height,
      readsBack: false,
      async draw(index, context) {
        const { image } = await decoder.decode({ frameIndex: index });
        const ms = (image.duration ?? 0) / 1000;
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        image.close();
        return ms;
      },
      close: () => decoder.close(),
    };
  } catch (error) {
    decoder.close();
    throw error;
  }
}

type GifFrame = Parameters<typeof decompressFrame>[0];

/**
 * A GIF's frames read in JS (gifuct-js), each decoded as it's shown, put over the one before it; that
 * one first undone as it says (its disposal): 2, its box cleared; 3, the picture back as it was before
 * it. Null if there's one frame only.
 */
function gifFrames(data: Uint8Array): Frames | null {
  const gif = parseGIF(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  const frames = gif.frames.filter((frame): frame is GifFrame => "image" in frame);
  const { width, height } = gif.lsd;
  if (frames.length < 2 || width <= 0 || height <= 0) {
    return null;
  }
  // A frame's own pixels, drawn over the picture (putImageData would replace it, transparent ones too).
  const patch = document.createElement("canvas");
  const patchContext = patch.getContext("2d")!;
  let last: { left: number; top: number; width: number; height: number; disposal: number } | null = null;
  let before: ImageData | null = null;
  return {
    count: frames.length,
    width,
    height,
    // A frame undone back to the picture before it keeps that picture (see below).
    readsBack: frames.some((frame) => frame.gce?.extras.disposal === 3),
    async draw(index, context) {
      if (index === 0) {
        context.clearRect(0, 0, width, height);
        last = null;
        before = null;
      } else if (last?.disposal === 2) {
        context.clearRect(last.left, last.top, last.width, last.height);
      } else if (last?.disposal === 3 && before) {
        context.putImageData(before, 0, 0);
      }
      const frame = decompressFrame(frames[index], gif.gct, true);
      const { left, top, width: w, height: h } = frame.dims;
      before = frame.disposalType === 3 ? context.getImageData(0, 0, width, height) : null;
      if (w > 0 && h > 0) {
        patch.width = w;
        patch.height = h;
        patchContext.putImageData(new ImageData(frame.patch, w, h), 0, 0);
        context.drawImage(patch, left, top);
      }
      last = { left, top, width: w, height: h, disposal: frame.disposalType };
      return frame.delay ?? 0;
    },
    close() {},
  };
}

/**
 * The file read whole if its first bytes say it may be animated; null (the rest not read) if they say
 * it's still: a WebP that isn't (most maps are big still ones), told by its header's animation flag.
 */
async function readIfAnimated(body: ReadableStream<Uint8Array>, mime: string): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let checked = mime !== "image/webp";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    length += value.length;
    // A WebP's header: RIFF, size, WEBP, then an extended one (VP8X) with its flags (animation: 0x02).
    if (!checked && length >= 21) {
      checked = true;
      const head = join(chunks, length).subarray(0, 21);
      const text = (from: number) => String.fromCharCode(...head.subarray(from, from + 4));
      if (text(0) !== "RIFF" || text(8) !== "WEBP" || text(12) !== "VP8X" || (head[20] & 0x02) === 0) {
        void reader.cancel();
        return null;
      }
    }
  }
  return checked ? join(chunks, length) : null;
}

function join(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0];
  }
  const all = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  chunks.splice(0, chunks.length, all);
  return all;
}

/** A map's or prop's media let go: an animation closed. */
export function stopAnimation(source: unknown) {
  animationOf(source)?.close();
}
