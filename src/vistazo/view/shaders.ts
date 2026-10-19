import { NOISE_2D } from "../glsl";

// The fill under bridges (see buildUnderBridges) and the zones' water (see buildWater).

export const UNDER_VERTEX = /* glsl */ `
  varying vec3 vAt;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vAt = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const UNDER_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uU;
  uniform vec4 uTex;
  uniform vec4 uFrame;
  uniform vec4 uAcross;
  uniform float uBelow;
  varying vec3 vAt;
  void main() {
    // Only what's below the bridge's underside, inside its box.
    if (vAt.z > uBelow) discard;
    vec2 p = vAt.xy / uU;
    vec2 d = p - uFrame.xy;
    float a = dot(d, uFrame.zw);
    float b = dot(d, uAcross.xy);
    if (abs(a) > uAcross.z || abs(b) > uAcross.w) discard;
    // The map mirrored across each long side (just past it, going out as it goes in), the two blended
    // across its width: each side's own next to it, fading into the other's, so no seam in the middle.
    vec2 base = uFrame.xy + uFrame.zw * a;
    // On a wall (an upright face: its slope from the screen's derivatives), the deeper below the bridge
    // the farther out the picture comes from, as a folded wall's: not one colour streaked down it.
    vec3 normal = normalize(cross(dFdx(vAt), dFdy(vAt)));
    float upright = 1.0 - smoothstep(0.3, 0.7, abs(normal.z));
    float deep = upright * max(0.0, uBelow - vAt.z) / uU;
    vec2 north = base + uAcross.xy * (2.0 * uAcross.w - b + 2.0 + deep);
    vec2 south = base + uAcross.xy * (-2.0 * uAcross.w - b - 2.0 - deep);
    vec2 scale = vec2(1.0 / uTex.z, -1.0 / uTex.w);
    vec3 fromNorth = texture2D(uMap, (north - uTex.xy) * scale + vec2(0.0, 1.0)).rgb;
    vec3 fromSouth = texture2D(uMap, (south - uTex.xy) * scale + vec2(0.0, 1.0)).rgb;
    vec3 color = mix(fromSouth, fromNorth, smoothstep(0.0, 1.0, (b + uAcross.w) / (2.0 * uAcross.w)));
    // Faded out toward its ends, into what the map has there (no straight cut across the walls).
    float ends = 1.0 - smoothstep(uAcross.z - uAcross.w * 0.6, uAcross.z, abs(a));
    // A little darker: in the bridge's shadow.
    gl_FragColor = vec4(color * 0.82, ends);
  }
`;

export const WATER_VERTEX = /* glsl */ `
  varying vec2 vAt;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vAt = world.xy;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const WATER_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uMap;
  uniform float uU;
  uniform float uCell;
  uniform vec4 uTex;
  uniform sampler2D uReach;
  uniform vec4 uGrid;
  uniform vec2 uGridSize;
  varying vec2 vAt;
  ${NOISE_2D}
  void main() {
    // Only where the water reaches (see buildWater): its zone, and what's connected to it below its level.
    vec2 scene = vAt / uU;
    vec2 cell = ((scene - uGrid.xy) / uGrid.z + 0.5) / uGridSize;
    if (texture2D(uReach, cell).r < 0.5) discard;
    // In cells, so the ripples are the same size on any map.
    vec2 p = vAt / uU / uCell;
    float a = noise(p * 1.6 + vec2(uTime * 0.25, uTime * 0.18));
    float b = noise(p * 2.3 - vec2(uTime * 0.2, -uTime * 0.27));
    // The map's picture there, wobbling a little (a few hundredths of a cell).
    vec2 wobble = (vec2(a, b) - 0.5) * 0.06 * uCell;
    vec2 q = vAt / uU + wobble;
    vec3 under = texture2D(uMap, vec2((q.x - uTex.x) / uTex.z, 1.0 - (q.y - uTex.y) / uTex.w)).rgb;
    // Glints where the two ripple patterns meet.
    float glint = smoothstep(0.82, 0.95, 1.0 - abs(a - b) * 3.0) * 0.35;
    vec3 color = under * vec3(0.82, 0.92, 1.0) + glint;
    gl_FragColor = vec4(color, 0.72);
  }
`;
