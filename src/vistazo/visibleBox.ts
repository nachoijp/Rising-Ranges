// What of a picture shows (see VisibleBox): read once each, small, so a
// standing image is set on the ground by its figure and not its box (the
// Vistazo), and the Elevation menu's base shows where that is.

/**
 * The part of a picture that shows (not see-through), as fractions of its
 * width and height; `base`, the middle of what it stands on (what shows in
 * its bottom strip: a statue's pedestal, not the spear it holds out); and its
 * width over its height.
 */
export type VisibleBox = { x0: number; y0: number; x1: number; y1: number; base: number; aspect: number };

// By picture, measured once each (null: it couldn't be read, or nothing of it shows).
const visibleBoxes = new Map<string, VisibleBox | null>();
const measuring = new Set<string>();

/**
 * What of a picture shows, once it's been read (undefined until then:
 * `ready` is called when it is). Read small, from its alpha; a video, from
 * its first frame.
 */
export function visibleBox(url: string, video: boolean, ready: () => void): VisibleBox | null | undefined {
  if (visibleBoxes.has(url)) {
    return visibleBoxes.get(url);
  }
  if (measuring.has(url)) {
    return undefined;
  }
  measuring.add(url);
  let source: HTMLImageElement | HTMLVideoElement;
  const done = (box: VisibleBox | null) => {
    visibleBoxes.set(url, box);
    measuring.delete(url);
    if (source instanceof HTMLVideoElement) {
      source.pause();
      source.removeAttribute("src");
      source.load();
    }
    ready();
  };
  const measure = (width: number, height: number) => {
    try {
      const scale = Math.min(1, 128 / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(source, 0, 0, w, h);
      const data = context.getImageData(0, 0, w, h).data;
      let x0 = w;
      let y0 = h;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] > 24) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
          }
        }
      }
      if (x1 < 0) {
        done(null);
        return;
      }
      // The bottom strip: a tenth of what shows, at least a couple of rows.
      const strip = Math.max(2, Math.round((y1 - y0 + 1) * 0.1));
      let sum = 0;
      let count = 0;
      for (let y = Math.max(y0, y1 - strip + 1); y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (data[(y * w + x) * 4 + 3] > 24) {
            sum += x + 0.5;
            count++;
          }
        }
      }
      done({ x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h, base: sum / count / w, aspect: width / height });
    } catch {
      // Not readable (no CORS): drawn by its box, as before.
      done(null);
    }
  };
  if (video) {
    const element = document.createElement("video");
    element.crossOrigin = "anonymous";
    element.muted = true;
    element.preload = "auto";
    element.src = url;
    source = element;
    element.onloadeddata = () => measure(element.videoWidth, element.videoHeight);
    element.onerror = () => done(null);
  } else {
    const img = new Image();
    source = img;
    img.crossOrigin = "anonymous";
    img.onload = () => measure(img.naturalWidth, img.naturalHeight);
    img.onerror = () => done(null);
    img.src = url;
  }
  return undefined;
}
