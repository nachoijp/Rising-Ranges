import * as THREE from "three";

// Volume templates (the scene's items: see templateItems.ts): a spell's area
// in 3D — a cone, a sphere, a cylinder, a line or a cube — at the heights
// it reaches, drawn translucent and moving with its kind (fire, ice...).

export type TemplateShape = "cone" | "sphere" | "cylinder" | "line" | "cube";
export type TemplateLook = "fire" | "ice" | "poison" | "lightning" | "darkness" | "arcane" | "force" | "necrotic" | "acid" | "thunder" | "psychic" | "radiant";

/**
 * A placed template: where (scene px, and the height there, grid units),
 * which way it points (a cone or a line; unit, on the map), and its size in
 * cells — a sphere's or a cylinder's radius, a cube's side, a cone's or a
 * line's length.
 */
export type Template = {
  id: string;
  shape: TemplateShape;
  look: TemplateLook;
  x: number;
  y: number;
  /** Its height (grid units): the ground under it plus `lift`, raised or lowered by the scene's keys. */
  z: number;
  lift: number;
  dir: { x: number; y: number };
  /** A cone's or a line's tip, how much higher than its origin (grid units; it tilts, its length kept). */
  rise: number;
  size: number;
};

/**
 * A cone's or a line's tip: how far along the map from its origin (cells)
 * and how high over it — its rise, at most its length — its length kept.
 */
export function templateTip(template: Template): { across: number; rise: number } {
  const rise = Math.max(-template.size, Math.min(template.size, template.rise));
  return { across: Math.sqrt(Math.max(0, template.size * template.size - rise * rise)), rise };
}

/**
 * How each kind is drawn: what pattern moves through it, how fast, its
 * colours (deep, mid, bright: a ramp), and whether it glows (adds light).
 */
type Mode = "cloud" | "ice" | "bolts" | "waves" | "radiant" | "flame" | "pulse" | "veins" | "bubbles" | "swirl" | "rings";
const MODES: Record<Mode, number> = { cloud: 0, ice: 1, bolts: 2, waves: 3, radiant: 4, flame: 5, pulse: 6, veins: 7, bubbles: 8, swirl: 9, rings: 10 };
type RGB = [number, number, number];
type Look = { deep: RGB; mid: RGB; bright: RGB; opacity: number; glow: boolean; mode: Mode; rise: number; grain: number; speed: number };

const LOOKS: Record<TemplateLook, Look> = {
  fire: { deep: [0.85, 0.22, 0.03], mid: [1, 0.48, 0.06], bright: [1, 0.95, 0.65], opacity: 0.65, glow: true, mode: "flame", rise: 0.9, grain: 0.9, speed: 1 },
  ice: { deep: [0.3, 0.55, 0.85], mid: [0.6, 0.85, 0.98], bright: [0.95, 0.99, 1], opacity: 0.48, glow: false, mode: "ice", rise: 0.02, grain: 1.4, speed: 0.9 },
  poison: { deep: [0.08, 0.25, 0.03], mid: [0.35, 0.6, 0.1], bright: [0.75, 1, 0.35], opacity: 0.55, glow: false, mode: "cloud", rise: 0.15, grain: 0.55, speed: 1.2 },
  lightning: { deep: [0.08, 0.15, 0.6], mid: [0.35, 0.55, 1], bright: [0.95, 0.97, 1], opacity: 0.5, glow: true, mode: "bolts", rise: 0, grain: 1.4, speed: 1 },
  darkness: { deep: [0, 0, 0], mid: [0.035, 0.035, 0.036], bright: [0.14, 0.137, 0.143], opacity: 0.9, glow: false, mode: "cloud", rise: 0.05, grain: 0.45, speed: 0.7 },
  arcane: { deep: [0.22, 0.02, 0.6], mid: [0.55, 0.2, 0.95], bright: [0.95, 0.6, 1], opacity: 0.52, glow: true, mode: "swirl", rise: 0.3, grain: 1, speed: 1.2 },
  force: { deep: [0.4, 0, 0.03], mid: [0.85, 0.15, 0.15], bright: [1, 0.6, 0.55], opacity: 0.45, glow: true, mode: "rings", rise: 0.2, grain: 1, speed: 1.5 },
  necrotic: { deep: [0.015, 0.018, 0.01], mid: [0.12, 0.14, 0.07], bright: [0.36, 0.4, 0.25], opacity: 0.78, glow: false, mode: "veins", rise: 0.15, grain: 1, speed: 1.2 },
  acid: { deep: [0.005, 0.035, 0.005], mid: [0.09, 0.2, 0.03], bright: [0.18, 0.36, 0.05], opacity: 0.68, glow: false, mode: "bubbles", rise: 0.4, grain: 1.3, speed: 1.2 },
  thunder: { deep: [0.5, 0.55, 0.62], mid: [0.78, 0.8, 0.86], bright: [1, 1, 1], opacity: 0.4, glow: false, mode: "waves", rise: 0, grain: 1, speed: 1 },
  psychic: { deep: [0.4, 0.2, 0.8], mid: [0.85, 0.5, 0.95], bright: [1, 0.92, 1], opacity: 0.48, glow: true, mode: "pulse", rise: 0.1, grain: 0.8, speed: 1 },
  radiant: { deep: [0.9, 0.65, 0.1], mid: [1, 0.88, 0.45], bright: [1, 1, 0.9], opacity: 0.5, glow: true, mode: "radiant", rise: 0.4, grain: 1, speed: 1 },
};

/** How a kind is drawn (see LOOKS), for the map's version of it (see templateSksl.ts). */
export function templateLook(look: TemplateLook): Look & { modeIndex: number } {
  return { ...LOOKS[look], modeIndex: MODES[LOOKS[look].mode] };
}

/** A kind's colours as CSS (its deep one, its bright one): its outline and fill on the map. */
export function templateColors(look: TemplateLook): { deep: string; bright: string } {
  const css = ([r, g, b]: RGB) => `#${[r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
  return { deep: css(LOOKS[look].deep), bright: css(LOOKS[look].bright) };
}

const VERTEX = /* glsl */ `
  varying vec3 vAt;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vPos;
  varying vec3 vPoint;
  varying float vZoom;
  varying vec3 vFace;
  uniform float uEyeZ;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vAt = world.xyz;
    vec4 view = viewMatrix * world;
    vNormal = normalize(normalMatrix * normal);
    // Where it and the template's point (the mesh's own origin) are in view space, and the view's
    // zoom: the fragment shader puts them through the perspective, to measure from the point as seen.
    vPos = view.xyz;
    vPoint = (viewMatrix * modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vZoom = length(viewMatrix[0].xyz);
    // Which way its surface faces (world): flat patterns are drawn on the plane it faces most.
    vFace = normalize(mat3(modelMatrix) * normal);
    // The eye is at z = uEyeZ in view space (see the view's projection).
    vView = normalize(vec3(0.0, 0.0, uEyeZ) - view.xyz);
    gl_Position = projectionMatrix * view;
  }
`;

// The map's patterns (templateSksl.ts) in 3D: a volume's walls need noise that changes with height
// too. Each octave turned (no lattice marks) and drifting its own way; things rise (+z), except in a
// cone or a line, which flow along its axis, away from its point.
const FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uCell;
  uniform vec3 uDeep;
  uniform vec3 uMid;
  uniform vec3 uBright;
  uniform float uOpacity;
  uniform float uRise;
  uniform float uGrain;
  uniform float uSpeed;
  uniform int uMode;
  uniform vec3 uOrigin;
  uniform vec3 uAxis;
  uniform float uAimed;
  varying vec3 vAt;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vPos;
  varying vec3 vPoint;
  varying float vZoom;
  varying vec3 vFace;
  uniform float uEyeZ;
  const mat3 TURN = mat3(0.0, 1.6, 1.2, -1.6, 0.72, -0.96, -1.2, -0.96, 1.28);
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  // Unsmoothed: its mid contour comes out in nearly straight runs, breaking at angles (the bolts).
  float noiseLin(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p, float t) {
    float v = 0.0;
    float a = 0.5;
    vec3 drift = uAimed > 0.5 ? -uAxis * 0.15 * t : vec3(0.15, 0.1, 0.0) * t;
    // Added to where it's read, so the pattern moves the other way: up (+z), or out along a cone's axis.
    vec3 churn = (uAimed > 0.5 ? -uAxis : vec3(0.0, 0.0, -1.0)) * (uRise + 0.05) * t;
    for (int i = 0; i < 3; i++) {
      v += a * noise(p + drift + churn);
      p = TURN * p + 11.7;
      churn = TURN * churn * 0.85;
      a *= 0.5;
    }
    return v;
  }
  float fbmLin(vec3 p, vec3 drift) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noiseLin(p + drift);
      p = TURN * p + 11.7;
      drift = TURN * drift * 0.85;
      a *= 0.5;
    }
    return v;
  }
  vec3 turn(vec3 v, float a) {
    float c = cos(a);
    float s = sin(a);
    return vec3(c * v.x - s * v.y, s * v.x + c * v.y, v.z);
  }
  // Little lights scattered on a grid of cells, each fading in and out on its own.
  float motes(vec3 g, float density, float size, float rate) {
    vec3 cell = floor(g);
    float h = hash(cell);
    vec3 off = vec3(hash(cell + 1.7), hash(cell + 3.1), hash(cell + 5.3)) - 0.5;
    float spot = 1.0 - smoothstep(0.0, size, length(fract(g) - 0.5 - off * 0.6));
    return step(1.0 - density, h) * spot * pow(max(0.0, sin(uTime * rate + h * 40.0)), 4.0);
  }
  // Glints with arms along the three axes, each twinkling on its own.
  float glints(vec3 g, float density, float rate) {
    vec3 cell = floor(g);
    float h = hash(cell);
    vec3 l = fract(g) - 0.5 - (vec3(hash(cell + 1.7), hash(cell + 3.1), hash(cell + 5.3)) - 0.5) * 0.6;
    float tw = pow(max(0.0, sin(uTime * rate + h * 40.0)), 8.0);
    float len = 0.02 + tw * 0.4;
    float ax = (1.0 - smoothstep(0.0, 0.025, length(l.yz))) * (1.0 - smoothstep(0.0, len, abs(l.x)));
    float ay = (1.0 - smoothstep(0.0, 0.025, length(l.xz))) * (1.0 - smoothstep(0.0, len, abs(l.y)));
    float az = (1.0 - smoothstep(0.0, 0.025, length(l.xy))) * (1.0 - smoothstep(0.0, len, abs(l.z)));
    float core = 1.0 - smoothstep(0.0, 0.08, length(l));
    return step(1.0 - density, h) * tw * max(max(ax, ay), max(az, core));
  }
  vec3 ramp(float x) {
    x = clamp(x, 0.0, 1.0);
    return x < 0.5 ? mix(uDeep, uMid, x * 2.0) : mix(uMid, uBright, x * 2.0 - 1.0);
  }
  void main() {
    // In cells, from its point.
    vec3 at = (vAt - uOrigin) / uCell;
    // How far from its point and round it, as seen: rings spread and rays fan out from it on the
    // screen (measured in 3D, a sphere's whole shell is as far, and rays round z meet at its poles).
    // (On the screen, through the perspective; back to cells at the point's depth.)
    vec2 onScreen = vPos.xy / (uEyeZ - vPos.z) - vPoint.xy / (uEyeZ - vPoint.z);
    vec2 seen = onScreen * (uEyeZ - vPoint.z) / vZoom / uCell;
    float r = length(seen);
    float ang = atan(seen.y, seen.x);
    // On the plane its surface faces most (flat things, as bubbles, drawn on it).
    vec3 fa = abs(vFace);
    vec2 faced = fa.z >= fa.x && fa.z >= fa.y ? at.xy : (fa.x >= fa.y ? at.yz : at.xz);
    float t = uTime * uSpeed;
    bool aimed = uAimed > 0.5;
    vec3 p = at * uGrain - (aimed ? uAxis * 0.3 * t : vec3(0.0));
    float body;
    float tintAmt = 0.0;
    vec3 tint = vec3(0.0);
    if (uMode == 1) {
      // Ice: frost, with sharp cracks (two sizes) and glints.
      float n = fbm(p, t * 0.6);
      float crack = pow(1.0 - abs(2.0 * n - 1.0), 14.0);
      float n2 = fbm(p * 2.3 + 3.0, -t * 0.5);
      float fine = pow(1.0 - abs(2.0 * n2 - 1.0), 20.0);
      float shimmer = 0.85 + 0.15 * sin(uTime * 1.7 + n * 10.0);
      body = (0.2 + 0.35 * n + 0.7 * crack + 0.35 * fine) * shimmer + glints(at * 3.0, 0.2, 3.2) * 1.3;
    } else if (uMode == 2) {
      // Lightning: the noise's mid contour, angular, with a halo and flashes.
      // Slower than on the map: both its sides show here, crossing each other.
      float tl = uTime * 0.6;
      vec3 drift = aimed ? vec3(0.5, -0.35, 0.2) * tl : vec3(1.9, -1.3, 0.9) * tl;
      vec3 run = aimed ? uAxis * tl * 0.6 : vec3(0.0);
      vec3 b = p + (vec3(fbmLin(p * 0.6, drift * 0.5), fbmLin(p * 0.6 + vec3(4.0, 2.0, 0.0), -drift * 0.5), 0.45) - 0.45) * 0.45;
      float dist = abs(fbmLin(b - run, drift) - 0.5);
      float bolt = 1.0 - smoothstep(0.0, 0.02, dist);
      float halo = 1.0 - smoothstep(0.0, 0.1, dist);
      float flash = 0.65 + 0.35 * step(0.75, hash(vec3(floor(uTime * 9.0), 7.0, 0.0)));
      body = 0.06 + (bolt + 0.35 * halo) * flash;
    } else if (uMode == 3) {
      // Thunder: shock rings from its point, bent by the noise.
      float n = fbm(p, t);
      float wave = 0.5 + 0.5 * sin((r + (n - 0.45) * 0.7) * 5.0 - uTime * 7.0);
      body = 0.1 + 0.9 * pow(wave, 6.0) * (0.6 + 0.4 * n);
    } else if (uMode == 4) {
      // Radiant: two sets of sharp rays sweeping opposite ways round it, light running out along them, glints.
      float n = fbm(p, t);
      float r1 = pow(0.5 + 0.5 * sin(ang * 9.0 + uTime * 0.65 + n * 2.0), 8.0);
      float r2 = pow(0.5 + 0.5 * sin(ang * 5.0 - uTime * 1.05 + n * 3.0), 6.0);
      float travel = 0.55 + 0.45 * sin(r * 4.0 - uTime * 3.3 + n * 3.0);
      body = 0.28 + 0.3 * n + 0.55 * (r1 + r2) * travel + glints(at * 2.5, 0.22, 2.3) * 1.5;
    } else if (uMode == 5) {
      // Fire: turbulent tongues, a hot core where they peak, flicker and embers (rising, or flying out of a cone).
      // Slower than on the map: both its sides show here, crossing each other.
      float tf = t * 0.6;
      float w = fbm(p * 0.8, tf * 0.5);
      float n = fbm(p * 1.3 + vec3(w) * 1.8, tf * 1.4);
      float flick = 0.88 + 0.12 * sin(uTime * 7.0 + n * 14.0);
      vec3 embers = aimed ? uAxis * tf * 0.9 : vec3(0.0, 0.0, tf * 0.9);
      body = pow(smoothstep(0.18, 0.72, n), 1.3) * flick + motes(at * 3.5 - embers, 0.12, 0.1, 5.0) * 1.4;
    } else if (uMode == 6) {
      // Psychic: a slow swirl of interfering rings that breathes.
      vec3 s = turn(at, r * 0.5 - uTime * 0.4);
      float n = fbm(s * uGrain, t);
      float breath = 0.6 + 0.4 * sin(uTime * 2.2);
      vec2 ss = turn(vec3(seen, 0.0), r * 0.5 - uTime * 0.4).xy;
      float rings = sin(r * 3.0 - uTime * 2.5) * sin(length(ss - vec2(0.7, 0.0)) * 4.0 + uTime * 1.3 + n * 5.0);
      body = (0.2 + 0.8 * (0.5 + 0.5 * rings)) * breath;
    } else if (uMode == 7) {
      // Necrotic: dark, thin veins crawling and throbbing, and a second set of them, blood red.
      float w = fbm(p * 0.7, t * 0.3);
      float n = fbm(p + vec3(w, -w, 0.0) * 2.5, t * 0.6);
      float pulse = 0.55 + 0.45 * sin(uTime * 1.8 + w * 9.0);
      float vein = pow(1.0 - abs(2.0 * n - 1.0), 4.0);
      float blood = pow(max(0.0, 1.0 - 3.0 * abs(w - 0.45)), 6.0);
      body = 0.08 + 0.92 * max(vein, blood * 0.8) * pulse;
      tintAmt = blood * (1.0 - 0.7 * vein);
      tint = vec3(0.45, 0.03, 0.04) * (0.6 + 0.4 * pulse);
    } else if (uMode == 8) {
      // Acid: a churning pool, now and then a bubble swelling and popping.
      float n = fbm(p, t);
      // On the plane its surface faces (in 3D a bubble's sphere is rarely cut just at its ring).
      vec2 g = faced * 2.2 * uGrain + vec2(n * 0.6);
      vec2 cell = floor(g);
      float h = hash(vec3(cell, 0.0));
      vec2 off = (vec2(hash(vec3(cell, 1.7)), hash(vec3(cell, 3.1))) - 0.5) * 0.4;
      float phase = fract(uTime * 0.35 + h * 7.0);
      float dc = length(fract(g) - 0.5 - off);
      float rad = phase * 0.32;
      float ring = (1.0 - smoothstep(0.0, 0.035, abs(dc - rad))) * (1.0 - phase) * step(0.75, h);
      float fill = (1.0 - smoothstep(rad - 0.03, rad, dc)) * step(0.75, h) * 0.25;
      // Dark lines for contrast: a thin black rim just outside each bubble's bright one, and black
      // veins through the pool (a contour of a slower noise of their own).
      float dark = (1.0 - smoothstep(0.0, 0.03, abs(dc - rad - 0.05))) * (1.0 - phase) * step(0.75, h);
      dark = max(dark, 1.0 - smoothstep(0.0, 0.02, abs(fbm(p * 0.8, t * 0.35) - 0.42)));
      body = 0.2 + 0.55 * n + ring * 1.1 + fill + dark * 0.6;
      tintAmt = dark * 0.9;
      tint = vec3(0.005, 0.015, 0.0);
    } else if (uMode == 9) {
      // Arcane: clouds turning round its point, with stars.
      vec3 s = turn(at, r * 0.7 - uTime * 0.6);
      vec3 sp = s * uGrain;
      float w = fbm(sp, t * 0.4);
      body = smoothstep(0.25, 0.75, fbm(sp + vec3(w) * 1.6, t)) + motes(s * 4.0, 0.15, 0.1, 3.0) * 1.3;
    } else if (uMode == 10) {
      // Force: slow, wide rings spreading from its point.
      float n = fbm(p, t * 0.5);
      float wave = 0.5 + 0.5 * sin(r * 2.8 - uTime * 2.5);
      body = 0.15 + 0.85 * pow(wave, 4.0) * (0.7 + 0.3 * n);
    } else {
      // Cloud (poison, darkness): warped by itself.
      vec3 w = vec3(fbm(p, t * 0.4), fbm(p + vec3(5.2, 1.3, 0.0), -t * 0.35), 0.0);
      body = smoothstep(0.22, 0.72, fbm(p + w * 2.2, t));
    }
    // Brighter at its edges as seen (a shell, not a solid block).
    float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.0);
    vec3 color = mix(ramp(body * 0.9 + rim * 0.5), tint, tintAmt);
    float alpha = uOpacity * (0.35 + 0.65 * clamp(body, 0.0, 1.0)) + rim * 0.3;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.95));
  }
`;

/**
 * A template's mesh, in view units: `u` view units a scene px, `cell` view
 * units a cell across, `k` a cell of height. Each sits on (or starts from)
 * its point: a sphere centred there, a cylinder or a cube standing on it, a
 * cone or a line from it toward its tip (see templateTip).
 */
export function buildTemplate(template: Template, u: number, cell: number, k: number): THREE.Mesh {
  const look = LOOKS[template.look];
  const size = template.size * cell;
  const hs = k / cell;
  let geometry: THREE.BufferGeometry;
  const at = new THREE.Vector3(template.x * u, template.y * u, template.z * k);
  const dir = new THREE.Vector3(template.dir.x, template.dir.y, 0).normalize();
  // A cone's or a line's way (unit, from its point to its tip): its pattern flows along it.
  let aim: THREE.Vector3 | null = null;
  switch (template.shape) {
    case "sphere":
      geometry = new THREE.SphereGeometry(size, 32, 20);
      geometry.scale(1, 1, hs);
      break;
    case "cylinder":
      // As tall as it's wide (radius by two), standing on the point.
      geometry = new THREE.CylinderGeometry(size, size, size * 2, 40, 1, true);
      geometry.rotateX(Math.PI / 2);
      geometry.scale(1, 1, hs);
      geometry.translate(0, 0, size * hs);
      break;
    case "cube":
      geometry = new THREE.BoxGeometry(size, size, size * hs);
      geometry.translate(0, 0, (size * hs) / 2);
      break;
    case "line":
    default: {
      // From its point to its tip (which may be higher or lower: it tilts), as long as that is in view.
      const tip = templateTip(template);
      const axis = new THREE.Vector3(dir.x * tip.across * cell, dir.y * tip.across * cell, tip.rise * k);
      const length = axis.length() || size;
      if (template.shape === "line") {
        // A cell wide and tall round its axis.
        geometry = new THREE.BoxGeometry(length, cell, cell);
        geometry.translate(length / 2, 0, 0);
      } else {
        // A cone: as wide at its end as it's long. Its point at the origin, opening along +x.
        geometry = new THREE.ConeGeometry(size / 2, length, 40, 1, true);
        geometry.translate(0, -length / 2, 0);
        geometry.rotateZ(Math.PI / 2);
      }
      aim = axis.lengthSq() > 0 ? axis.clone().normalize() : new THREE.Vector3(1, 0, 0);
      geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), aim));
    }
  }
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: look.glow ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uCell: { value: cell },
      uEyeZ: { value: 1 },
      uDeep: { value: new THREE.Color(...look.deep) },
      uMid: { value: new THREE.Color(...look.mid) },
      uBright: { value: new THREE.Color(...look.bright) },
      uOpacity: { value: look.opacity },
      uRise: { value: look.rise },
      uGrain: { value: look.grain },
      uSpeed: { value: look.speed },
      uMode: { value: MODES[look.mode] },
      uOrigin: { value: at.clone() },
      uAxis: { value: aim ?? new THREE.Vector3(1, 0, 0) },
      uAimed: { value: aim ? 1 : 0 },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(at);
  mesh.renderOrder = 8;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Whether a template reaches a point (cells; a body's middle) within
 * `reach` (its radius and the tolerance): a sphere round its point, a
 * cylinder standing on it (as tall as wide), a cube on it, a line a cell
 * wide and tall from it toward its tip, a cone from it (as wide at its end
 * as it's long) toward its tip; their tip may be higher or lower (see templateTip).
 */
export function templateReaches(template: Template, c: { x: number; y: number; z: number }, reach: number, dpi: number): boolean {
  const o = { x: template.x / dpi, y: template.y / dpi, z: template.z };
  const s = template.size;
  const [dx, dy] = [template.dir.x, template.dir.y];
  switch (template.shape) {
    case "sphere":
      return Math.hypot(c.x - o.x, c.y - o.y, c.z - o.z) <= s + reach;
    case "cylinder":
      return Math.hypot(c.x - o.x, c.y - o.y) <= s + reach && c.z >= o.z - reach && c.z <= o.z + s * 2 + reach;
    case "cube": {
      const ax = Math.max(0, Math.abs(c.x - o.x) - s / 2);
      const ay = Math.max(0, Math.abs(c.y - o.y) - s / 2);
      const az = Math.max(0, o.z - c.z, c.z - (o.z + s));
      return Math.hypot(ax, ay, az) <= reach;
    }
    case "line":
    default: {
      // Along its axis (from its point toward its tip: it may tilt), and how far from it.
      const tip = templateTip(template);
      const a = { x: (dx * tip.across) / s, y: (dy * tip.across) / s, z: tip.rise / s };
      const v = { x: c.x - o.x, y: c.y - o.y, z: c.z - o.z };
      const along = v.x * a.x + v.y * a.y + v.z * a.z;
      const off = Math.hypot(v.x - a.x * along, v.y - a.y * along, v.z - a.z * along);
      if (along < -reach || along > s + reach) {
        return false;
      }
      // A line: half a cell round its axis; a cone: its half-width there is half that far.
      if (template.shape === "line") {
        return off <= 0.5 + reach;
      }
      return off <= Math.max(0, along) / 2 + reach;
    }
  }
}
