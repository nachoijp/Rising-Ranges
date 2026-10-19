import * as THREE from "three";

// The walls' patterns (see buildWalls), drawn here once each.

/** A small deterministic random, so a pattern is the same every time. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A grey tile (256 px, two cells across) that repeats seamlessly, to tint
 * with the map's colour: brick courses ("stone"), irregular stones
 * ("rubble"), earth strata, or planks. Drawn once each (the stones take a
 * moment), a new texture on it each time.
 */
export function patternTexture(style: "stone" | "rubble" | "earth" | "wood"): THREE.CanvasTexture {
  let canvas = patternCanvases.get(style);
  if (!canvas) {
    canvas = drawPattern(style);
    patternCanvases.set(style, canvas);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

const patternCanvases = new Map<string, HTMLCanvasElement>();

function drawPattern(style: "stone" | "rubble" | "earth" | "wood"): HTMLCanvasElement {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext("2d")!;
  const random = seeded(style === "stone" ? 7 : style === "rubble" ? 5 : style === "earth" ? 11 : 13);
  const grey = (v: number) => `rgb(${v},${v},${v})`;
  if (style === "stone") {
    // Four courses of blocks, each row offset, with dark mortar.
    c.fillStyle = grey(120);
    c.fillRect(0, 0, size, size);
    const row = size / 4;
    for (let r = 0; r < 4; r++) {
      let x = -random() * 60;
      while (x < size) {
        const w = 70 + random() * 60;
        const shade = 205 + random() * 40;
        for (const dx of [0, size]) {
          // Drawn twice, a tile apart, so blocks wrap around the edge.
          c.fillStyle = grey(shade);
          c.fillRect(x + dx - size + 3, r * row + 3, w - 6, row - 6);
          c.fillRect(x + dx + 3, r * row + 3, w - 6, row - 6);
        }
        x += w;
      }
    }
  } else if (style === "rubble") {
    // Irregular stones: each pixel belongs to its nearest of some jittered points (across the tile's
    // edges too, so it repeats), with mortar where two are about as near and a bevel toward it.
    const cells = 6;
    const seeds: { x: number; y: number; shade: number }[] = [];
    for (let gy = 0; gy < cells; gy++) {
      for (let gx = 0; gx < cells; gx++) {
        seeds.push({ x: ((gx + 0.1 + random() * 0.8) * size) / cells, y: ((gy + 0.1 + random() * 0.8) * size) / cells, shade: 175 + random() * 65 });
      }
    }
    const image = c.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let d1 = Infinity;
        let d2 = Infinity;
        let shade = 0;
        for (const seed of seeds) {
          let dx = Math.abs(x - seed.x);
          let dy = Math.abs(y - seed.y);
          dx = Math.min(dx, size - dx);
          dy = Math.min(dy, size - dy);
          const d = dx * dx + dy * dy;
          if (d < d1) {
            d2 = d1;
            d1 = d;
            shade = seed.shade;
          } else if (d < d2) {
            d2 = d;
          }
        }
        // How far from the edge with the next stone, px.
        const edge = Math.sqrt(d2) - Math.sqrt(d1);
        const v = edge < 2.5 ? 105 : shade * (edge < 9 ? 0.8 + ((edge - 2.5) / 6.5) * 0.2 : 1);
        const i = (y * size + x) * 4;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
        image.data[i + 3] = 255;
      }
    }
    c.putImageData(image, 0, 0);
  } else if (style === "earth") {
    // Wavy strata of different shades, with speckles.
    let y = 0;
    while (y < size) {
      const h = 14 + random() * 30;
      const shade = 170 + random() * 70;
      const phase = random() * Math.PI * 2;
      const amp = 2 + random() * 4;
      c.fillStyle = grey(shade);
      c.beginPath();
      c.moveTo(0, size);
      for (let x = 0; x <= size; x += 8) {
        c.lineTo(x, y + Math.sin((x / size) * Math.PI * 4 + phase) * amp);
      }
      c.lineTo(size, size);
      c.closePath();
      c.fill();
      y += h;
    }
    for (let i = 0; i < 900; i++) {
      c.fillStyle = grey(random() < 0.5 ? 120 + random() * 40 : 235);
      c.fillRect(random() * size, random() * size, 1 + random() * 2, 1 + random() * 2);
    }
  } else {
    // Upright planks with grain and dark gaps.
    c.fillStyle = grey(90);
    c.fillRect(0, 0, size, size);
    const widths: number[] = [];
    let total = 0;
    while (total < size - 40) {
      const w = 28 + Math.round(random() * 16);
      widths.push(w);
      total += w;
    }
    widths.push(size - total);
    let x = 0;
    for (const w of widths) {
      c.fillStyle = grey(200 + random() * 40);
      c.fillRect(x + 2, 0, w - 4, size);
      c.strokeStyle = "rgba(0,0,0,0.12)";
      c.lineWidth = 1;
      for (let g = 0; g < 4; g++) {
        const gx = x + 6 + random() * (w - 12);
        const phase = random() * Math.PI * 2;
        c.beginPath();
        for (let y = 0; y <= size; y += 8) {
          c.lineTo(gx + Math.sin((y / size) * Math.PI * 2 + phase) * 2, y);
        }
        c.stroke();
      }
      x += w;
    }
  }
  // A little noise over all of it.
  const image = c.getImageData(0, 0, size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (random() - 0.5) * 18;
    image.data[i] += n;
    image.data[i + 1] += n;
    image.data[i + 2] += n;
  }
  c.putImageData(image, 0, 0);
  return canvas;
}
