import * as THREE from "three";
import type { Item } from "@owlbear-rodeo/sdk";

// The Weather extension's weather (github.com/owlbear-rodeo/weather), drawn
// in 3D: it keeps its settings on a Map- or Fog-layer item, under its own
// metadata key, and covers that item's area with an animated effect. Only
// its settings are read here (it's GPL: nothing of its code is used); the
// Vistazo draws its own particles from them, falling between the heights.

/** The clouds' noise picture (see cloudNoise): its side (px), and how many of the noise's cells it holds across. */
const CLOUD_NOISE_SIZE = 256;
const CLOUD_NOISE_CELLS = 16;

export const WEATHER_KEY = "rodeo.owlbear.weather/weather";

export type WeatherType = "SNOW" | "RAIN" | "SAND" | "FIRE" | "CLOUD" | "BLOOM";
const TYPES: readonly WeatherType[] = ["SNOW", "RAIN", "SAND", "FIRE", "CLOUD", "BLOOM"];

/** How the clouds are drawn here (the viewer's choice): a mist over the map, or their shadows passing over it. */
export type CloudStyle = "mist" | "shadows";

/** One item's weather: its kind, Weather's settings (speed and density 1–4) and the box it covers, scene px. */
export type Weather = {
  id: string;
  type: WeatherType;
  speed: number;
  density: number;
  /** Where it blows toward, on the map (y down); Weather's default is south-west. */
  direction: { x: number; y: number };
  box: { x0: number; y0: number; x1: number; y1: number };
};

/** An item's weather, if Weather put some on it; `outline` is the item's outline in the scene. */
export function weatherOf(item: Item, outline: [number, number][]): Weather | null {
  const stored = item.metadata[WEATHER_KEY] as { type?: unknown; speed?: unknown; density?: unknown; direction?: unknown } | undefined;
  if (!stored || typeof stored !== "object" || outline.length < 3 || (item.layer !== "MAP" && item.layer !== "FOG")) {
    return null;
  }
  const type = TYPES.includes(stored.type as WeatherType) ? (stored.type as WeatherType) : "SNOW";
  const level = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(4, value)) : fallback);
  const direction = stored.direction as { x?: unknown; y?: unknown } | undefined;
  const ok = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  return {
    id: item.id,
    type,
    speed: level(stored.speed, 1),
    density: level(stored.density, 3),
    // Weather's y points north (up the screen); the map's runs down.
    direction: direction && ok(direction.x) && ok(direction.y) ? { x: direction.x, y: -direction.y } : { x: -1, y: 1 },
    box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
  };
}

/** How much faster than at Weather's speed 1 it moves: more so at each step, as Weather's own (1, 2.1, 3.5, 5.2). */
function paceOf(speed: number): number {
  return 0.4 + 0.6 * Math.pow(speed, 1.5);
}

/**
 * How each kind moves and looks, per cell (a cell across, a cell up), before
 * Weather's speed and density. Sized to be seen at the map's scale, as
 * Weather draws them (a snowflake its real size wouldn't show).
 */
type Look = {
  /** Along its direction, and up (negative: falling), cells a second. */
  drift: number;
  rise: number;
  /** Sideways sway, cells. */
  sway: number;
  /** Across, cells (a streak's length for rain). */
  size: number;
  /** How many to a cell of ground at density 3. */
  perCell: number;
  color: [number, number, number];
  opacity: number;
  /** How high above the highest ground it reaches, cells. */
  ceiling: number;
  glow?: boolean;
  petal?: boolean;
};

const LOOKS: Record<Exclude<WeatherType, "CLOUD" | "SAND">, Look> = {
  RAIN: { drift: 3, rise: -14, sway: 0, size: 0.5, perCell: 1.2, color: [0.75, 0.82, 0.95], opacity: 0.55, ceiling: 6 },
  SNOW: { drift: 0.6, rise: -0.9, sway: 0.25, size: 0.14, perCell: 1.5, color: [1, 1, 1], opacity: 0.9, ceiling: 6 },
  FIRE: { drift: 0.4, rise: 1.2, sway: 0.15, size: 0.14, perCell: 0.5, color: [1, 0.55, 0.15], opacity: 0.95, ceiling: 5, glow: true },
  BLOOM: { drift: 1, rise: -0.5, sway: 0.3, size: 0.28, perCell: 0.4, color: [1, 0.7, 0.85], opacity: 0.9, ceiling: 5, petal: true },
};

/**
 * The drifting haze some kinds have besides their particles (as Weather
 * draws them): sand's, low down (with its puffs above); snow adds its own
 * at density 3 and 4. Two sheets at these heights (cells above the ground, or above the
 * highest ground with `overTop`), the haze flowing along the wind.
 */
type Wisps = {
  /** Cells above the ground; or, with `overTop`, above the highest ground; or, with `span`, fractions of the way from the ground to a few cells above the highest. */
  heights: number[];
  overTop?: boolean;
  span?: boolean;
  /** How much of it still shows seen edge on (0: none), so a storm stays a wall of haze from the side. */
  edgeOn: number;
  color: [number, number, number];
  opacity: number;
  /** How much of the sheet the haze covers (0–1), by density 1–4. */
  cover: (density: number) => number;
  /** How fast it flows, cells a second (before Weather's speed). */
  drift: number;
  glow?: boolean;
  /** From which density it shows. */
  from: number;
};

const WISPS: Partial<Record<WeatherType, Wisps>> = {
  SAND: { heights: [0.3, 1.2], edgeOn: 0.7, color: [0.86, 0.6, 0.38], opacity: 0.5, cover: (d) => 0.2 + 0.08 * d, drift: 1.5, from: 1 },
  SNOW: { heights: [0.6, 2.5], overTop: true, edgeOn: 0.3, color: [0.85, 0.87, 0.9], opacity: 0.45, cover: (d) => 0.1 + 0.15 * (d - 2), drift: 0.4, from: 3 },
  // Fire: no haze sheet on the ground, its rising tongues (see PUFFS) are enough.
};

/** Clouds as a mist: haze at a few heights, and puffs for the side (see CLOUD_MIST_PUFFS). */
const CLOUD_MIST: Wisps = { heights: [0.12, 0.45, 0.85], span: true, edgeOn: 0.4, color: [0.86, 0.88, 0.91], opacity: 0.45, cover: (d) => 0.15 + 0.1 * d, drift: 0.4, from: 1 };

/** Its sheets' pattern a cell across, in noise units (a wisp is several cells). */
const WISP_SCALE = 0.14;

const WISP_VERTEX = /* glsl */ `
  uniform float uCell;
  uniform float uEyeZ;
  uniform float uEdgeOn;
  varying vec2 vCell;
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vCell = world.xy / uCell;
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    // How squarely it's seen (the eye is at z = uEyeZ in view space): seen edge on, a sheet fades away.
    vec3 normal = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));
    vFacing = mix(uEdgeOn, 1.0, smoothstep(0.05, 0.45, abs(dot(normal, normalize(vec3(0.0, 0.0, uEyeZ) - view.xyz)))));
    gl_Position = projectionMatrix * view;
  }
`;

const WISP_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec2 uDrift;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uCover;
  uniform float uSeed;
  varying vec2 vCell;
  varying vec2 vUv;
  varying float vFacing;
  uniform sampler2D uNoise;
  // An fbm of the noise (four octaves halving: up to 0.94), read from the noise picture (see cloudNoise).
  float fbm(vec2 p) {
    return texture2D(uNoise, p / ${CLOUD_NOISE_CELLS.toFixed(1)}).g * 0.94;
  }
  void main() {
    vec2 p = vCell * ${WISP_SCALE.toFixed(3)} + uSeed - uDrift * uTime;
    // Warped by itself, slowly changing: billows that flow, not a sliding pattern.
    vec2 q = vec2(fbm(p + vec2(0.0, uTime * 0.05)), fbm(p + vec2(5.2, 1.3) - vec2(uTime * 0.04, 0.0)));
    float n = fbm(p + 3.0 * q);
    float edge = 1.0 - uCover;
    float from = edge * 0.75;
    float alpha = smoothstep(from, from + 0.3, n) * uOpacity * vFacing;
    // Faded out toward the sheet's edges, so its straight sides don't show.
    vec2 rim = min(vUv, 1.0 - vUv);
    alpha *= smoothstep(0.0, 0.08, min(rim.x, rim.y));
    // Fine flow lines through it.
    alpha *= 0.8 + 0.2 * sin(n * 38.0);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColor * (0.75 + 0.5 * n), alpha);
  }
`;

/**
 * Haze in the air that flat sheets can't give from the side: soft puffs
 * always facing the camera, drifting round their box — a sandstorm's dust
 * (big, round), or the heat rising off a fire (narrow tongues stood along
 * the scene's up, glowing strands running up them, dying out higher up).
 */
type Puffs = {
  /** Across, cells; how many times taller than wide (along the scene's up); and how many times longer along the wind. */
  size: number;
  stretch: number;
  long: number;
  /** Along the wind, and up, cells a second (before Weather's speed). */
  drift: number;
  rise: number;
  /** How many to a cell of ground at density 3, and how many cells over the highest ground they reach. */
  perCell: number;
  ceiling: number;
  /** How much lower down they gather (1: evenly; more: nearer the ground). */
  low: number;
  color: [number, number, number];
  opacity: (density: number) => number;
  glow?: boolean;
  /** Strands instead of billows, and faded out as they rise. */
  flame?: boolean;
  /** From which density they show. */
  from: number;
};

/** A cloud mist's puffs: big, pale and few, wider than tall (banks), from the ground to well over the highest. */
const CLOUD_MIST_PUFFS: Puffs = { size: 5, stretch: 0.6, long: 2, drift: 0.8, rise: 0, perCell: 0.05, ceiling: 3, low: 1.2, color: [0.88, 0.9, 0.93], opacity: (d) => 0.1 + 0.03 * d, from: 1 };

const PUFFS: Partial<Record<WeatherType, Puffs>> = {
  SAND: { size: 4, stretch: 1, long: 2, drift: 3, rise: 0, perCell: 0.18, ceiling: 3, low: 1.8, color: [0.86, 0.62, 0.4], opacity: (d) => 0.2 + 0.04 * d, from: 1 },
  FIRE: { size: 1.6, stretch: 1.2, long: 1, drift: 0.3, rise: 0.8, perCell: 0.08, ceiling: 0.5, low: 2.5, color: [1, 0.45, 0.16], opacity: (d) => 0.25 + 0.12 * (d - 2), glow: true, flame: true, from: 3 },
};

const PUFF_VERTEX = /* glsl */ `
  attribute vec2 corner;
  attribute vec3 seed;
  attribute float phase;
  uniform float uTime;
  uniform vec3 uMin;
  uniform vec3 uSize;
  uniform vec3 uVel;
  uniform float uPuff;
  uniform float uStretch;
  uniform float uViewScale;
  uniform vec2 uWind;
  uniform float uLong;
  varying vec2 vCorner;
  varying float vPhase;
  varying float vFade;
  varying float vHeight;
  void main() {
    vec3 at = fract(seed + (uVel * uTime) / uSize);
    vec3 center = uMin + at * uSize;
    vec4 view = modelViewMatrix * vec4(center, 1.0);
    // Facing the camera, its long side along the scene's up as the screen shows it.
    // Seen from straight above the scene's up is toward the eye: round then, tall seen from the side.
    vec2 up = (modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xy;
    float upright = clamp(length(up) / max(uViewScale, 0.0001), 0.0, 1.0);
    up = length(up) > 0.0001 ? normalize(up) : vec2(0.0, -1.0);
    vec2 side = vec2(-up.y, up.x);
    float size = uPuff * (0.7 + 0.6 * phase) * uViewScale;
    vec2 offset = (side * corner.x + up * corner.y * mix(1.0, uStretch, upright)) * size;
    // Longer along the wind as the screen shows it (shorter seen end on, as anything long is).
    vec2 wind = (modelViewMatrix * vec4(uWind, 0.0, 0.0)).xy;
    float across = clamp(length(wind) / max(uViewScale, 0.0001), 0.0, 1.0);
    if (length(wind) > 0.0001) {
      vec2 axis = normalize(wind);
      offset += axis * dot(offset, axis) * (mix(1.0, uLong, across) - 1.0);
    }
    view.xy += offset;
    gl_Position = projectionMatrix * view;
    vCorner = corner;
    vPhase = phase;
    vHeight = at.z;
    // Faded in and out where it wraps round its box.
    vec2 edge = min(at.xy, 1.0 - at.xy);
    vFade = smoothstep(0.0, 0.12, min(edge.x, edge.y)) * smoothstep(0.0, 0.06, at.z);
  }
`;

const PUFF_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uFlame;
  varying vec2 vCorner;
  varying float vPhase;
  varying float vFade;
  varying float vHeight;
  uniform sampler2D uNoise;
  // An fbm of the noise (octaves halving, as the haze's: up to 0.88 as three of them sum), read from the
  // noise picture (see cloudNoise).
  float fbm(vec2 p) {
    return texture2D(uNoise, p / ${CLOUD_NOISE_CELLS.toFixed(1)}).g * 0.88;
  }
  void main() {
    float r = length(vCorner) * 2.0;
    // Billows drifting slowly; or, for heat, strands running up it (narrow across, long along).
    vec2 flow = mix(vec2(uTime * 0.08, -uTime * 0.05), vec2(0.0, -uTime * 0.5), uFlame);
    vec2 grain = mix(vec2(2.2), vec2(3.0, 1.6), uFlame);
    float n = fbm(vCorner * grain + vPhase * 31.0 + flow);
    // A billow's outline is the noise's, not a circle: denser toward the middle, frayed unevenly
    // outward (the circle only keeps it off the quad's square edges).
    float billow = smoothstep(0.0, 0.4, n - r * 0.5) * (1.0 - smoothstep(0.85, 1.0, r));
    float strand = smoothstep(0.4, 0.46, n) * (1.0 - smoothstep(0.52, 0.68, n));
    float body = 1.0 - smoothstep(0.35, 1.0, r);
    float shape = mix(billow, (strand + 0.25 * smoothstep(0.25, 0.75, n)) * body, uFlame);
    // Heat dies out as it rises: toward the top of its box, and of each tongue.
    float rising = mix(1.0, (1.0 - vHeight) * (1.0 - smoothstep(-0.1, 0.5, vCorner.y)), uFlame);
    float alpha = shape * rising * uOpacity * vFade;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColor * (0.8 + 0.4 * n), alpha);
  }
`;

/** A weather's puffs (see Puffs), if it has any at its density: how many by its area and density, how big, how high. */
function buildPuffs(weather: Weather, frame: WeatherFrame, dpi: number, look = PUFFS[weather.type]): THREE.Object3D[] {
  if (!look || weather.density < look.from) {
    return [];
  }
  const pace = paceOf(weather.speed);
  const length = Math.hypot(weather.direction.x, weather.direction.y);
  const dir = length > 0 ? { x: weather.direction.x / length, y: weather.direction.y / length } : { x: 1, y: 0 };
  const { x0, y0, x1, y1 } = weather.box;
  const cells = ((x1 - x0) / dpi) * ((y1 - y0) / dpi);
  const count = Math.round(Math.min(1500, Math.max(30, cells * look.perCell * (weather.density / 3))) * (frame.amount ?? 1));
  const bottom = 0;
  const top = (frame.highest + look.ceiling) * frame.k;
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("corner", new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  // A position attribute three.js expects to be there (the corners do the work).
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
  const seeds = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    seeds.set([Math.random(), Math.random(), Math.pow(Math.random(), look.low)], i * 3);
    phases[i] = Math.random();
  }
  geometry.setAttribute("seed", new THREE.InstancedBufferAttribute(seeds, 3));
  geometry.setAttribute("phase", new THREE.InstancedBufferAttribute(phases, 1));
  geometry.instanceCount = count;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  const material = new THREE.ShaderMaterial({
    vertexShader: PUFF_VERTEX,
    fragmentShader: PUFF_FRAGMENT,
    transparent: true,
    depthWrite: false,
    // The view's y runs down the screen, which turns the quads' winding round: drawn from both sides.
    side: THREE.DoubleSide,
    blending: look.glow ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uNoise: { value: cloudNoise() },
      uMin: { value: new THREE.Vector3(x0 * frame.u, y0 * frame.u, bottom) },
      uSize: { value: new THREE.Vector3(Math.max(1, (x1 - x0) * frame.u), Math.max(1, (y1 - y0) * frame.u), Math.max(1, top - bottom)) },
      uVel: { value: new THREE.Vector3(dir.x * look.drift * pace * frame.cell, dir.y * look.drift * pace * frame.cell, look.rise * pace * frame.k) },
      uPuff: { value: look.size * frame.cell },
      uStretch: { value: look.stretch },
      uWind: { value: new THREE.Vector2(dir.x, dir.y) },
      uLong: { value: look.long },
      uViewScale: { value: 1 },
      uColor: { value: new THREE.Color(...look.color) },
      uOpacity: { value: look.opacity(weather.density) },
      uFlame: { value: look.flame ? 1 : 0 },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;
  return [mesh];
}

/** A weather's haze sheets (see Wisps), if it has any at its density. */
function buildWisps(weather: Weather, frame: WeatherFrame, wisps = WISPS[weather.type]): THREE.Object3D[] {
  if (!wisps || weather.density < wisps.from) {
    return [];
  }
  const pace = paceOf(weather.speed);
  const length = Math.hypot(weather.direction.x, weather.direction.y);
  const dir = length > 0 ? { x: weather.direction.x / length, y: weather.direction.y / length } : { x: 1, y: 0 };
  const { x0, y0, x1, y1 } = weather.box;
  const w = Math.max(1, (x1 - x0) * frame.u);
  const h = Math.max(1, (y1 - y0) * frame.u);
  return wisps.heights.map((height, index) => {
    const material = new THREE.ShaderMaterial({
      vertexShader: WISP_VERTEX,
      fragmentShader: WISP_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: wisps.glow ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        uTime: { value: 0 },
        uNoise: { value: cloudNoise() },
        uCell: { value: frame.cell },
        uEyeZ: { value: 1 },
        uDrift: { value: new THREE.Vector2(dir.x, dir.y).multiplyScalar(wisps.drift * pace * WISP_SCALE * (1 + index * 0.35)) },
        uColor: { value: new THREE.Color(...wisps.color) },
        // Thinner the higher it is.
        uOpacity: { value: wisps.opacity * (1 - (0.45 * index) / Math.max(1, wisps.heights.length - 1)) },
        uEdgeOn: { value: wisps.edgeOn },
        uCover: { value: Math.max(0.05, Math.min(0.9, wisps.cover(weather.density))) },
        uSeed: { value: index * 13.7 },
      },
    });
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    const z = (wisps.span ? height * (frame.highest + 2) : (wisps.overTop ? frame.highest : 0) + height) * frame.k;
    sheet.position.set(x0 * frame.u + w / 2, y0 * frame.u + h / 2, z);
    sheet.renderOrder = 7;
    sheet.frustumCulled = false;
    return sheet;
  });
}

/** The most particles one weather draws, however big its area (rain's streaks, then the rest). */
const MOST_STREAKS = 30000;
const MOST_POINTS = 20000;

const VERTEX = /* glsl */ `
  attribute float phase;
  uniform float uTime;
  uniform vec3 uMin;
  uniform vec3 uSize;
  uniform vec3 uVel;
  uniform float uSway;
  uniform float uPointSize;
  uniform float uPointScale;
  uniform float uLength;
  uniform float uGlow;
  #ifdef STREAK
  attribute float tail;
  #endif
  varying float vAlpha;
  varying float vPhase;
  void main() {
    float turn = phase * 6.2832;
    vec3 sway = vec3(sin(uTime * 1.3 + turn), cos(uTime * 1.1 + turn), 0.0) * uSway;
    // Each one goes round its box: where it started (its seed), on by its speed, wrapped.
    vec3 at = fract(position + (uVel * uTime + sway) / uSize);
    vec3 world = uMin + at * uSize;
    #ifdef STREAK
    world -= tail * normalize(uVel) * uLength;
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
    gl_PointSize = max(1.5, uPointSize * (0.6 + 0.8 * phase) * uPointScale / gl_Position.w);
    // Faded in at the top of its box and out at the bottom, so wrapping round doesn't pop.
    vAlpha = smoothstep(0.0, 0.08, at.z) * smoothstep(1.0, 0.92, at.z);
    vAlpha *= mix(1.0, 0.55 + 0.45 * sin(uTime * 7.0 + phase * 40.0), uGlow);
    vPhase = phase;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uPetal;
  varying float vAlpha;
  varying float vPhase;
  void main() {
    #ifdef STREAK
    float shape = 1.0;
    #else
    vec2 p = gl_PointCoord - 0.5;
    // A petal: an ellipse turned its own way.
    float a = vPhase * 6.2832;
    p = mix(p, vec2(p.x * cos(a) - p.y * sin(a), (p.x * sin(a) + p.y * cos(a)) * 2.2), uPetal);
    float shape = smoothstep(0.5, 0.15, length(p));
    #endif
    float alpha = shape * uOpacity * vAlpha;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

/** Where the weather's drawn: the view's scale (view units a scene px, and a cell of height) and the ground's lowest and highest. */
/** `amount`: how many particles and puffs, of all (the quality setting's: 1 at high). */
export type WeatherFrame = { u: number; cell: number; k: number; lowest: number; highest: number; amount?: number };

/**
 * The particles and haze for each weather (clouds as a mist or their
 * shadows), moving on the GPU: each frame only their time changes (see
 * setWeatherTime).
 */
export function buildWeather(weathers: Weather[], frame: WeatherFrame, dpi: number, clouds: CloudStyle): THREE.Object3D[] {
  const objects: THREE.Object3D[] = [];
  for (const weather of weathers) {
    if (weather.type === "CLOUD") {
      // As shadows they're laid on the terrain itself (see CLOUD_GLSL).
      if (clouds === "mist") {
        objects.push(...buildWisps(weather, frame, CLOUD_MIST), ...buildPuffs(weather, frame, dpi, CLOUD_MIST_PUFFS));
      }
      continue;
    }
    objects.push(...buildWisps(weather, frame));
    objects.push(...buildPuffs(weather, frame, dpi));
    // Sand is only dust: haze low down, and puffs in the air.
    if (weather.type === "SAND") {
      continue;
    }
    const look = LOOKS[weather.type];
    const pace = paceOf(weather.speed);
    const length = Math.hypot(weather.direction.x, weather.direction.y);
    // Sand needs somewhere to blow.
    const dir = length > 0 ? { x: weather.direction.x / length, y: weather.direction.y / length } : { x: 1, y: 0 };
    const { x0, y0, x1, y1 } = weather.box;
    const bottom = (frame.lowest - 0.5) * frame.k;
    const top = (frame.highest + look.ceiling) * frame.k;
    const min = new THREE.Vector3(x0 * frame.u, y0 * frame.u, bottom);
    const size = new THREE.Vector3(Math.max(1, (x1 - x0) * frame.u), Math.max(1, (y1 - y0) * frame.u), Math.max(1, top - bottom));
    const cells = ((x1 - x0) / dpi) * ((y1 - y0) / dpi);
    const streak = weather.type === "RAIN";
    const count = Math.round(Math.min(streak ? MOST_STREAKS : MOST_POINTS, Math.max(50, cells * look.perCell * (weather.density / 3))) * (frame.amount ?? 1));

    const geometry = new THREE.BufferGeometry();
    const seeds = new Float32Array(count * 3 * (streak ? 2 : 1));
    const phases = new Float32Array(count * (streak ? 2 : 1));
    const tails = streak ? new Float32Array(count * 2) : null;
    for (let i = 0; i < count; i++) {
      const seed = [Math.random(), Math.random(), Math.random()];
      const phase = Math.random();
      for (let end = 0; end < (streak ? 2 : 1); end++) {
        const j = streak ? i * 2 + end : i;
        seeds.set(seed, j * 3);
        phases[j] = phase;
        if (tails) {
          tails[j] = end;
        }
      }
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(seeds, 3));
    geometry.setAttribute("phase", new THREE.BufferAttribute(phases, 1));
    if (tails) {
      geometry.setAttribute("tail", new THREE.BufferAttribute(tails, 1));
    }
    // Its seeds are 0–1, not where it's drawn: never left out as off screen.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      defines: streak ? { STREAK: "" } : {},
      transparent: true,
      depthWrite: false,
      blending: look.glow ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        uTime: { value: 0 },
        uMin: { value: min },
        uSize: { value: size },
        uVel: { value: new THREE.Vector3(dir.x * look.drift * pace * frame.cell, dir.y * look.drift * pace * frame.cell, look.rise * pace * frame.k) },
        uSway: { value: look.sway * frame.cell },
        uPointSize: { value: look.size * frame.cell },
        uPointScale: { value: 1 },
        uLength: { value: look.size * frame.cell },
        uGlow: { value: look.glow ? 1 : 0 },
        uColor: { value: new THREE.Color(...look.color) },
        uOpacity: { value: look.opacity },
        uPetal: { value: look.petal ? 1 : 0 },
      },
    });
    const object = streak ? new THREE.LineSegments(geometry, material) : new THREE.Points(geometry, material);
    object.frustumCulled = false;
    object.renderOrder = 6;
    objects.push(object);
  }
  return objects;
}

/** How many cloud zones the terrain shades at once (see CLOUD_GLSL). */
export const CLOUD_ZONES = 4;

/**
 * A cloud zone's shadow on the terrain, as CLOUD_GLSL works it out: its item's box (view units), how
 * it drifts with the wind (cells a second), how much of it is cloud.
 */
export function cloudShadowOf(weather: Weather, frame: WeatherFrame): { box: [number, number, number, number]; drift: [number, number]; cover: number } {
  const pace = paceOf(weather.speed);
  const length = Math.hypot(weather.direction.x, weather.direction.y);
  const dir = length > 0 ? { x: weather.direction.x / length, y: weather.direction.y / length } : { x: 1, y: 0 };
  const { x0, y0, x1, y1 } = weather.box;
  return {
    box: [x0 * frame.u, y0 * frame.u, x1 * frame.u, y1 * frame.u],
    drift: [dir.x * 0.6 * pace * 0.12, dir.y * 0.6 * pace * 0.12],
    cover: Math.min(0.85, 0.3 + 0.1 * weather.density),
  };
}

let cloudNoiseTexture: THREE.DataTexture | null = null;

/**
 * The weather's noise as a picture, worked out once: the fbms of a value noise the shaders used
 * (the clouds' shadows', the haze's and puffs'), each octave twice as fine, wrapping round on itself
 * (each octave's cells repeat across it), so they read it, repeated, instead of working the noise
 * out at every pixel (a read, not up to twelve noises: a slow graphics card feels those over the
 * whole terrain, and over every sheet of haze).
 */
export function cloudNoise(): THREE.DataTexture {
  if (cloudNoiseTexture) {
    return cloudNoiseTexture;
  }
  const hash = (x: number, y: number) => {
    let [px, py] = [(x * 123.34) % 1, (y * 456.21) % 1];
    const d = px * (px + 45.32) + py * (py + 45.32);
    [px, py] = [px + d, py + d];
    return (((px * py) % 1) + 1) % 1;
  };
  const noise = (x: number, y: number, period: number) => {
    const [ix, iy] = [Math.floor(x), Math.floor(y)];
    const [fx, fy] = [x - ix, y - iy];
    const [ux, uy] = [fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)];
    const at = (i: number, j: number) => hash(((i % period) + period) % period, ((j % period) + period) % period);
    const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * ux;
    const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * ux;
    return a + (b - a) * uy;
  };
  // Two fbms of the same noise: red, the clouds' (three octaves, each 0.4 as strong: blobs); green, the
  // haze's (four, each half as strong: finer billows).
  const data = new Uint8Array(CLOUD_NOISE_SIZE * CLOUD_NOISE_SIZE * 2);
  for (let j = 0; j < CLOUD_NOISE_SIZE; j++) {
    for (let i = 0; i < CLOUD_NOISE_SIZE; i++) {
      const [x, y] = [(i / CLOUD_NOISE_SIZE) * CLOUD_NOISE_CELLS, (j / CLOUD_NOISE_SIZE) * CLOUD_NOISE_CELLS];
      const octaves = [0, 1, 2, 3].map((o) => noise(x * 2 ** o, y * 2 ** o, CLOUD_NOISE_CELLS * 2 ** o));
      const clouds = (0.6 * octaves[0] + 0.24 * octaves[1] + 0.096 * octaves[2]) / 0.936;
      const haze = (0.5 * octaves[0] + 0.25 * octaves[1] + 0.125 * octaves[2] + 0.0625 * octaves[3]) / 0.9375;
      data[(j * CLOUD_NOISE_SIZE + i) * 2] = Math.round(Math.min(1, clouds) * 255);
      data[(j * CLOUD_NOISE_SIZE + i) * 2 + 1] = Math.round(Math.min(1, haze) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, CLOUD_NOISE_SIZE, CLOUD_NOISE_SIZE, THREE.RGFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  cloudNoiseTexture = texture;
  return texture;
}

/**
 * Clouds as their shadows, worked out at each pixel of the terrain (its tops and walls, see clouded
 * in render.ts) from where it is (view units), so they fall where the ground is, raised or sunk: big
 * soft patches drifting with the wind, each its own shade, almost black with a touch of blue (a
 * shadow under a sky), over each zone's item and faded toward its edges. Their shapes read from the
 * clouds' noise picture (see cloudNoise).
 */
export const CLOUD_GLSL = /* glsl */ `
  uniform float uCloudTime;
  uniform float uCloudCell;
  uniform int uCloudCount;
  uniform vec4 uCloudBoxes[${CLOUD_ZONES}];
  uniform vec2 uCloudDrifts[${CLOUD_ZONES}];
  uniform float uCloudCovers[${CLOUD_ZONES}];
  uniform sampler2D uCloudNoise;
  // The fbm at a point of the noise (its cells), from the picture, repeated.
  float cloudFbm(vec2 p) {
    return texture2D(uCloudNoise, p / ${CLOUD_NOISE_CELLS.toFixed(1)}).r;
  }
  vec3 shadeClouds(vec3 color, vec2 at) {
    vec2 cell = at / uCloudCell;
    for (int i = 0; i < ${CLOUD_ZONES}; i++) {
      if (i >= uCloudCount) break;
      vec4 b = uCloudBoxes[i];
      vec2 inside = min(at - b.xy, b.zw - at);
      float rim = smoothstep(0.0, uCloudCell * 2.0, min(inside.x, inside.y));
      if (rim <= 0.0) continue;
      vec2 drift = uCloudDrifts[i] * uCloudTime;
      float n = cloudFbm(cell * 0.12 - drift);
      float tone = cloudFbm(cell * 0.04 + 7.3 - drift * 0.8);
      float edge = 1.0 - uCloudCovers[i];
      float alpha = smoothstep(edge - 0.1, edge + 0.1, n) * mix(0.4, 1.0, smoothstep(0.3, 0.7, tone)) * 0.47 * rim;
      color = mix(color, vec3(0.02, 0.04, 0.09), alpha);
    }
    return color;
  }
`;

/**
 * Each weather on to `time` (seconds): its particles sized for the camera
 * (screen px per view unit at the eye's distance), its haze faded by how
 * squarely it's seen from the eye (`eyeZ`, in view space).
 */
export function setWeatherTime(objects: THREE.Object3D[], time: number, pointScale: number, eyeZ: number, viewScale: number) {
  for (const object of objects) {
    const { uniforms } = (object as THREE.Mesh).material as THREE.ShaderMaterial;
    uniforms.uTime.value = time;
    if (uniforms.uViewScale) {
      uniforms.uViewScale.value = viewScale;
    }
    if (uniforms.uPointScale) {
      uniforms.uPointScale.value = pointScale;
    }
    if (uniforms.uEyeZ) {
      uniforms.uEyeZ.value = eyeZ;
    }
  }
}
