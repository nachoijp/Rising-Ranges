// GLSL shared by the Vistazo's shaders (walls' grain, water, what's under bridges; the weather reads its
// noise from a picture, see cloudNoise): a value noise in 2D,
// from a cheap hash. Each shader builds its own fbm from it (their octaves and
// weights differ, tuned to how each looks).

export const NOISE_2D = /* glsl */ `
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
`;
