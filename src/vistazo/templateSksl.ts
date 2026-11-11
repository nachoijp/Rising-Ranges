// A template's look on the map (see templateItems.ts): the Glance's shader (templates.ts) seen from
// above, in Owlbear's SkSL, drawn by an Effect attached to the template's outline. Owlbear hands it the
// outline's own coordinates (scene px, its point at 0, pointing along +x: seen live) and clips it to the
// outline; its edge is worked out here too (a circle, a square, a line, a cone), to soften it and make
// it brighter along it, as the Glance's shell is.

export const TEMPLATE_SKSL = /* sksl */ `
uniform float time;
uniform float uShape;
uniform float uSize;
uniform float uAcross;
uniform float uCell;
uniform float3 uDeep;
uniform float3 uBright;
uniform float uOpacity;
uniform float uRise;
uniform float uGrain;
uniform float uSpeed;
uniform float uMode;

float hash(float3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(float3 p) {
  float3 i = floor(p);
  float3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + float3(1, 0, 0)), f.x), mix(hash(i + float3(0, 1, 0)), hash(i + float3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + float3(0, 0, 1)), hash(i + float3(1, 0, 1)), f.x), mix(hash(i + float3(0, 1, 1)), hash(i + float3(1, 1, 1)), f.x), f.y), f.z);
}

float fbm(float3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v;
}

// How far inside its shape a point is (scene px; negative outside).
float inside(float2 q) {
  if (uShape < 0.5) {
    return uSize - length(q);
  }
  if (uShape < 1.5) {
    return uSize * 0.5 - max(abs(q.x), abs(q.y));
  }
  if (uShape < 2.5) {
    return min(min(uCell * 0.5 - abs(q.y), q.x), uAcross - q.x);
  }
  // A cone: its sides from its point to its end's corners (half its size out).
  float slope = uSize * 0.5 / max(uAcross, 0.001);
  float side = (q.x * slope - abs(q.y)) / sqrt(1.0 + slope * slope);
  return min(side, uAcross - q.x);
}

half4 main(float2 coord) {
  float2 q = coord;
  float d = inside(q);
  // Its edge a little soft (a few hundredths of a cell), then nothing.
  float soft = uCell * 0.04;
  if (d < -soft) {
    return half4(0.0);
  }
  float edge = smoothstep(-soft, soft, d);
  float3 at = float3(q, 0.0);
  float t = time * uSpeed;
  float3 p = at / uCell * uGrain - float3(t * 0.15, t * 0.1, t * uRise);
  float body;
  if (uMode > 0.5 && uMode < 1.5) {
    float n = fbm(p);
    body = 0.25 + 0.75 * (1.0 - smoothstep(0.0, 0.05, abs(n - 0.5)));
  } else if (uMode > 1.5 && uMode < 2.5) {
    float3 b = at / uCell * uGrain;
    b += float3(fbm(b + float3(0.0, 0.0, time * 1.35)), fbm(b + float3(4.0, 2.0, -time * 1.2)), 0.0) * 1.5;
    float n = fbm(b + float3(time * 0.68, -time * 0.45, time * 0.9));
    float bolt = 1.0 - smoothstep(0.0, 0.03, abs(n - 0.5));
    float flicker = 0.7 + 0.3 * sin(time * 23.0) * sin(time * 7.3);
    body = 0.08 + bolt * flicker;
  } else if (uMode > 2.5 && uMode < 3.5) {
    float r = length(q) / uCell;
    float wave = 0.5 + 0.5 * sin(r * 5.0 - time * 7.0);
    body = 0.15 + 0.85 * pow(wave, 4.0) * (0.7 + 0.3 * fbm(p));
  } else if (uMode > 3.5 && uMode < 4.5) {
    float n = fbm(p);
    float3 g = at / uCell * 2.5 + float3(fbm(p * 0.7)) * 1.5;
    float3 cell = floor(g);
    float3 off = float3(hash(cell + 1.3), hash(cell + 2.7), hash(cell + 4.1)) - 0.5;
    float spot = 1.0 - smoothstep(0.0, 0.3 + 0.15 * hash(cell + 9.0), length(fract(g) - 0.5 - off * 0.3));
    float mote = step(0.88, hash(cell)) * spot * pow(max(0.0, sin(time * 1.6 + hash(cell + 3.1) * 6.2832)), 6.0);
    body = 0.3 + 0.5 * n + mote * 1.3;
  } else if (uMode > 5.5) {
    float r = length(q) / uCell;
    float breath = 0.55 + 0.45 * sin(time * 2.2);
    float ripple = 0.5 + 0.5 * sin(r * 3.0 - time * 2.5) * sin(fbm(p) * 6.0 + time);
    body = (0.25 + 0.75 * ripple) * breath;
  } else {
    float3 w = float3(fbm(p + float3(0.0, 0.0, t * 0.4)), fbm(p + float3(5.2, 1.3, -t * 0.35)), 0.0);
    body = smoothstep(0.28, 0.72, fbm(p + w * 2.0));
  }
  // Brighter along its edge (the Glance's shell, seen from above).
  float rim = 1.0 - smoothstep(0.0, uCell * 0.35, d);
  rim *= rim;
  float3 color = mix(uDeep, uBright, clamp(body * 0.9 + rim * 0.5, 0.0, 1.0));
  float alpha = clamp(uOpacity * (0.35 + 0.65 * clamp(body, 0.0, 1.0)) + rim * 0.3, 0.0, 0.95) * edge;
  return half4(color * alpha, alpha);
}
`;
