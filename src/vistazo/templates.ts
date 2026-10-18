import * as THREE from "three";

// Volume templates, only in this Vistazo (not the scene's): a spell's area
// in 3D — a cone, a sphere, a cylinder, a line or a cube — at the heights
// it reaches, drawn translucent and moving with its kind (fire, ice...).

export type TemplateShape = "cone" | "sphere" | "cylinder" | "line" | "cube";
export type TemplateLook = "fire" | "ice" | "poison" | "lightning" | "darkness" | "arcane" | "force" | "necrotic" | "acid" | "thunder" | "psychic" | "radiant";

export const TEMPLATE_SHAPES: readonly TemplateShape[] = ["cone", "sphere", "cylinder", "line", "cube"];
export const TEMPLATE_LOOKS: readonly TemplateLook[] = ["fire", "ice", "poison", "lightning", "darkness", "arcane", "force", "necrotic", "acid", "thunder", "psychic", "radiant"];

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
 * colours (deep, bright), and whether it glows (adds light).
 */
type Mode = "cloud" | "veins" | "bolts" | "waves" | "sparkles" | "pulse";
const MODES: Record<Mode, number> = { cloud: 0, veins: 1, bolts: 2, waves: 3, sparkles: 4, pulse: 6 };
type Look = { deep: [number, number, number]; bright: [number, number, number]; opacity: number; glow: boolean; mode: Mode; rise: number; grain: number; speed: number };

const LOOKS: Record<TemplateLook, Look> = {
  fire: { deep: [0.85, 0.2, 0.02], bright: [1, 0.8, 0.25], opacity: 0.55, glow: true, mode: "cloud", rise: 0.9, grain: 0.9, speed: 1 },
  ice: { deep: [0.45, 0.75, 0.95], bright: [0.92, 0.98, 1], opacity: 0.45, glow: false, mode: "veins", rise: 0.02, grain: 1.6, speed: 0.45 },
  poison: { deep: [0.12, 0.38, 0.04], bright: [0.7, 1, 0.3], opacity: 0.52, glow: false, mode: "cloud", rise: 0.15, grain: 0.7, speed: 1.5 },
  lightning: { deep: [0.12, 0.25, 0.85], bright: [0.92, 0.96, 1], opacity: 0.55, glow: true, mode: "bolts", rise: 0, grain: 1.4, speed: 1 },
  darkness: { deep: [0.01, 0.01, 0.015], bright: [0.12, 0.11, 0.14], opacity: 0.85, glow: false, mode: "cloud", rise: 0.05, grain: 0.5, speed: 0.8 },
  arcane: { deep: [0.32, 0.02, 0.82], bright: [0.92, 0.45, 1], opacity: 0.5, glow: true, mode: "cloud", rise: 0.3, grain: 1.1, speed: 1.5 },
  force: { deep: [0.55, 0.01, 0.04], bright: [1, 0.4, 0.35], opacity: 0.5, glow: true, mode: "cloud", rise: 0.2, grain: 1.3, speed: 2 },
  necrotic: { deep: [0.01, 0.0, 0.02], bright: [0.42, 0.11, 0.56], opacity: 0.72, glow: false, mode: "cloud", rise: 0.15, grain: 1, speed: 1.7 },
  acid: { deep: [0.005, 0.035, 0.005], bright: [0.18, 0.36, 0.05], opacity: 0.68, glow: false, mode: "cloud", rise: 0.4, grain: 1.5, speed: 1.8 },
  thunder: { deep: [0.62, 0.66, 0.72], bright: [1, 1, 1], opacity: 0.4, glow: false, mode: "waves", rise: 0, grain: 1, speed: 1 },
  psychic: { deep: [0.5, 0.32, 0.9], bright: [1, 0.9, 1], opacity: 0.48, glow: true, mode: "pulse", rise: 0.1, grain: 0.8, speed: 1 },
  radiant: { deep: [0.95, 0.72, 0.1], bright: [1, 0.98, 0.85], opacity: 0.5, glow: true, mode: "sparkles", rise: 0.4, grain: 1, speed: 1 },
};

const VERTEX = /* glsl */ `
  varying vec3 vAt;
  varying vec3 vNormal;
  varying vec3 vView;
  uniform float uEyeZ;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vAt = world.xyz;
    vec4 view = viewMatrix * world;
    vNormal = normalize(normalMatrix * normal);
    // The eye is at z = uEyeZ in view space (see the view's projection).
    vView = normalize(vec3(0.0, 0.0, uEyeZ) - view.xyz);
    gl_Position = projectionMatrix * view;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uCell;
  uniform vec3 uDeep;
  uniform vec3 uBright;
  uniform float uOpacity;
  uniform float uRise;
  uniform float uGrain;
  uniform float uSpeed;
  uniform int uMode;
  uniform vec3 uOrigin;
  varying vec3 vAt;
  varying vec3 vNormal;
  varying vec3 vView;
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
  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noise(p);
      p = p * 2.03 + 11.7;
      a *= 0.5;
    }
    return v;
  }
  void main() {
    float t = uTime * uSpeed;
    // In cells, rising (or drifting) as its kind does.
    vec3 p = vAt / uCell * uGrain - vec3(t * 0.15, t * 0.1, t * uRise);
    float body;
    if (uMode == 1) {
      // Veins (ice): thin bright lines where the noise crosses its middle, barely moving.
      float n = fbm(p);
      body = 0.25 + 0.75 * (1.0 - smoothstep(0.0, 0.05, abs(n - 0.5)));
    } else if (uMode == 2) {
      // Bolts (lightning): thin jagged lines writhing and running on, never still, their light
      // flickering (smoothly: no jumps).
      vec3 q = vAt / uCell * uGrain;
      q += vec3(fbm(q + vec3(0.0, 0.0, uTime * 1.35)), fbm(q + vec3(4.0, 2.0, -uTime * 1.2)), 0.0) * 1.5;
      float n = fbm(q + vec3(uTime * 0.68, -uTime * 0.45, uTime * 0.9));
      float bolt = 1.0 - smoothstep(0.0, 0.03, abs(n - 0.5));
      float flicker = 0.7 + 0.3 * sin(uTime * 23.0) * sin(uTime * 7.3);
      body = 0.08 + bolt * flicker;
    } else if (uMode == 3) {
      // Waves (thunder): rings going out from its origin, as sound does.
      float d = length(vAt - uOrigin) / uCell;
      float wave = 0.5 + 0.5 * sin(d * 5.0 - uTime * 7.0);
      body = 0.15 + 0.85 * pow(wave, 4.0) * (0.7 + 0.3 * fbm(p));
    } else if (uMode == 4) {
      // Sparkles (radiant): a glow, with bright motes each fading slowly in and out in its own time. Each a
      // round spot of its own size, off its cell's middle, on a grid bent by noise: irregular, not squares.
      float n = fbm(p);
      vec3 g = vAt / uCell * 2.5 + vec3(fbm(p * 0.7)) * 1.5;
      vec3 cell = floor(g);
      vec3 off = vec3(hash(cell + 1.3), hash(cell + 2.7), hash(cell + 4.1)) - 0.5;
      float spot = 1.0 - smoothstep(0.0, 0.3 + 0.15 * hash(cell + 9.0), length(fract(g) - 0.5 - off * 0.3));
      float mote = step(0.88, hash(cell)) * spot * pow(max(0.0, sin(uTime * 1.6 + hash(cell + 3.1) * 6.2832)), 6.0);
      body = 0.3 + 0.5 * n + mote * 1.3;
    } else if (uMode == 6) {
      // Pulse (psychic): the whole of it breathing in and out, soft ripples crossing it.
      float d = length(vAt - uOrigin) / uCell;
      float breath = 0.55 + 0.45 * sin(uTime * 2.2);
      float ripple = 0.5 + 0.5 * sin(d * 3.0 - uTime * 2.5) * sin(fbm(p) * 6.0 + uTime);
      body = (0.25 + 0.75 * ripple) * breath;
    } else {
      // Clouds: the noise warped by itself as it goes, so it visibly churns, and sharpened.
      vec3 w = vec3(fbm(p + vec3(0.0, 0.0, t * 0.4)), fbm(p + vec3(5.2, 1.3, -t * 0.35)), 0.0);
      body = smoothstep(0.28, 0.72, fbm(p + w * 2.0));
    }
    // Brighter at its edges as seen (a shell, not a solid block).
    float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.0);
    vec3 color = mix(uDeep, uBright, clamp(body * 0.9 + rim * 0.5, 0.0, 1.0));
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
      geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), axis.lengthSq() > 0 ? axis.clone().normalize() : new THREE.Vector3(1, 0, 0)));
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
      uBright: { value: new THREE.Color(...look.bright) },
      uOpacity: { value: look.opacity },
      uRise: { value: look.rise },
      uGrain: { value: look.grain },
      uSpeed: { value: look.speed },
      uMode: { value: MODES[look.mode] },
      uOrigin: { value: at.clone() },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(at);
  mesh.renderOrder = 8;
  mesh.frustumCulled = false;
  return mesh;
}
