// A template's look on the map (see templateItems.ts): the Glance's shader (templates.ts) seen from
// above, in Owlbear's SkSL, drawn by an Effect attached to the template's outline. Owlbear hands it the
// outline's own coordinates (scene px, its point at 0, pointing along +x: seen live) and clips it to the
// outline; its edge is worked out here too (a circle, a square, a line, a cone), to soften it and make
// it brighter along it, as the Glance's shell is.
//
// Its noise is 2D (the map is flat: half the work of the Glance's 3D one), its octaves turned (no
// lattice marks) and drifting each their own way (it churns, not just slides). Cones and lines drift
// away from their point (the caster). Each kind has a pattern of its own (see templates.ts's LOOKS)
// and a ramp of three colours.

export const TEMPLATE_SKSL = /* sksl */ `
uniform float time;
uniform float uShape;
uniform float uSize;
uniform float uAcross;
uniform float uCell;
uniform float3 uDeep;
uniform float3 uMid;
uniform float3 uBright;
uniform float uOpacity;
uniform float uRise;
uniform float uGrain;
uniform float uSpeed;
uniform float uMode;

float hash(float2 p) {
  float3 p3 = fract(float3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + float2(1.0, 0.0)), f.x), mix(hash(i + float2(0.0, 1.0)), hash(i + float2(1.0, 1.0)), f.x), f.y);
}

// Three octaves, each turned and drifting its own way. Its own drift points back along -x; cones and
// lines turn it round (+x, away from their point).
float fbm(float2 p, float t) {
  float v = 0.0;
  float a = 0.5;
  float way = uShape > 1.5 ? -1.0 : 1.0;
  float2 drift = float2(0.15 * way, 0.1) * t;
  float2 churn = float2((uRise + 0.05) * way, 0.0) * t;
  for (int i = 0; i < 3; i++) {
    v += a * noise(p + drift + churn);
    p = float2x2(1.6, 1.2, -1.2, 1.6) * p + 11.7;
    churn = float2(-churn.y, churn.x) * 1.7;
    a *= 0.5;
  }
  return v;
}

// The noise without its smoothing: its mid contour comes out in nearly straight runs, breaking at angles.
float noiseLin(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  return mix(mix(hash(i), hash(i + float2(1.0, 0.0)), f.x), mix(hash(i + float2(0.0, 1.0)), hash(i + float2(1.0, 1.0)), f.x), f.y);
}

float fbmLin(float2 p, float2 drift) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * noiseLin(p + drift);
    p = float2x2(1.6, 1.2, -1.2, 1.6) * p + 11.7;
    drift = float2(-drift.y, drift.x) * 1.7;
    a *= 0.5;
  }
  return v;
}

float2 turn(float2 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return float2(c * v.x - s * v.y, s * v.x + c * v.y);
}

// Little lights scattered on a grid of cells, each fading in and out on its own.
float motes(float2 g, float density, float size, float rate) {
  float2 cell = floor(g);
  float h = hash(cell);
  float2 off = float2(hash(cell + 1.7), hash(cell + 3.1)) - 0.5;
  float spot = 1.0 - smoothstep(0.0, size, length(fract(g) - 0.5 - off * 0.6));
  return step(1.0 - density, h) * spot * pow(max(0.0, sin(time * rate + h * 40.0)), 4.0);
}

// Four-pointed glints, each twinkling on its own.
float glints(float2 g, float density, float rate) {
  float2 cell = floor(g);
  float h = hash(cell);
  float2 l = fract(g) - 0.5 - (float2(hash(cell + 1.7), hash(cell + 3.1)) - 0.5) * 0.6;
  float tw = pow(max(0.0, sin(time * rate + h * 40.0)), 8.0);
  float len = 0.02 + tw * 0.4;
  float arms = max((1.0 - smoothstep(0.0, 0.025, abs(l.x))) * (1.0 - smoothstep(0.0, len, abs(l.y))),
                   (1.0 - smoothstep(0.0, 0.025, abs(l.y))) * (1.0 - smoothstep(0.0, len, abs(l.x))));
  float core = 1.0 - smoothstep(0.0, 0.08, length(l));
  return step(1.0 - density, h) * tw * max(arms, core);
}

float3 ramp(float x) {
  x = clamp(x, 0.0, 1.0);
  return x < 0.5 ? mix(uDeep, uMid, x * 2.0) : mix(uMid, uBright, x * 2.0 - 1.0);
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
  float2 at = q / uCell;
  float r = length(at);
  float t = time * uSpeed;
  bool aimed = uShape > 1.5;
  float2 flow = aimed ? float2(0.3, 0.0) * t : float2(0.0);
  float2 p = at * uGrain - flow;
  float body;
  float tintAmt = 0.0;
  float3 tint = float3(0.0);
  if (uMode < 0.5) {
    // Cloud (poison, darkness): warped by itself.
    float2 w = float2(fbm(p, t * 0.4), fbm(p + float2(5.2, 1.3), -t * 0.35));
    body = smoothstep(0.22, 0.72, fbm(p + w * 2.2, t));
  } else if (uMode < 1.5) {
    // Ice: frost, with sharp cracks (two sizes) and glints.
    float n = fbm(p, t * 0.6);
    float crack = pow(1.0 - abs(2.0 * n - 1.0), 14.0);
    float n2 = fbm(p * 2.3 + 3.0, -t * 0.5);
    float fine = pow(1.0 - abs(2.0 * n2 - 1.0), 20.0);
    float shimmer = 0.85 + 0.15 * sin(time * 1.7 + n * 10.0);
    body = (0.2 + 0.35 * n + 0.7 * crack + 0.35 * fine) * shimmer + glints(at * 3.0, 0.2, 3.2) * 1.3;
  } else if (uMode < 2.5) {
    // Lightning: the noise's mid contour, angular, with a halo and flashes. Cones and lines: little
    // churn of its own and a steady run outward.
    float2 drift = aimed ? float2(time * 0.5, -time * 0.35) : float2(time * 1.9, -time * 1.3);
    float2 run = aimed ? float2(time * 0.6, 0.0) : float2(0.0);
    float2 b = p + (float2(fbmLin(p * 0.6, drift * 0.5), fbmLin(p * 0.6 + float2(4.0, 2.0), -drift * 0.5)) - 0.45) * 0.45;
    float dist = abs(fbmLin(b - run, drift) - 0.5);
    float bolt = 1.0 - smoothstep(0.0, 0.02, dist);
    float halo = 1.0 - smoothstep(0.0, 0.1, dist);
    float flash = 0.65 + 0.35 * step(0.75, hash(float2(floor(time * 9.0), 7.0)));
    body = 0.06 + (bolt + 0.35 * halo) * flash;
  } else if (uMode < 3.5) {
    // Thunder: shock rings from its point, bent by the noise.
    float n = fbm(p, t);
    float wave = 0.5 + 0.5 * sin((r + (n - 0.45) * 0.7) * 5.0 - time * 7.0);
    body = 0.1 + 0.9 * pow(wave, 6.0) * (0.6 + 0.4 * n);
  } else if (uMode < 4.5) {
    // Radiant: two sets of sharp rays sweeping opposite ways, light running out along them, glints.
    float n = fbm(p, t);
    float ang = atan(at.y, at.x);
    float r1 = pow(0.5 + 0.5 * sin(ang * 9.0 + time * 0.65 + n * 2.0), 8.0);
    float r2 = pow(0.5 + 0.5 * sin(ang * 5.0 - time * 1.05 + n * 3.0), 6.0);
    float travel = 0.55 + 0.45 * sin(r * 4.0 - time * 3.3 + n * 3.0);
    body = 0.28 + 0.3 * n + 0.55 * (r1 + r2) * travel + glints(at * 2.5, 0.22, 2.3) * 1.5;
  } else if (uMode < 5.5) {
    // Fire: turbulent tongues, a hot core where they peak, flicker and embers.
    float w = fbm(p * 0.8, t * 0.5);
    float n = fbm(p * 1.3 + float2(w) * 1.8, t * 1.4);
    float flick = 0.88 + 0.12 * sin(time * 11.0 + n * 14.0);
    float2 embers = aimed ? float2(time * 0.9, 0.0) : float2(0.0, time * 0.9);
    body = pow(smoothstep(0.18, 0.72, n), 1.3) * flick + motes(at * 3.5 - embers, 0.12, 0.1, 5.0) * 1.4;
  } else if (uMode < 6.5) {
    // Psychic: a slow swirl of interfering rings that breathes.
    float2 s = turn(at, r * 0.5 - time * 0.4);
    float n = fbm(s * uGrain, t);
    float breath = 0.6 + 0.4 * sin(time * 2.2);
    float rings = sin(r * 3.0 - time * 2.5) * sin(length(s - float2(0.7, 0.0)) * 4.0 + time * 1.3 + n * 5.0);
    body = (0.2 + 0.8 * (0.5 + 0.5 * rings)) * breath;
  } else if (uMode < 7.5) {
    // Necrotic: dark, thin veins crawling and throbbing, and a second set of them, blood red (the
    // warp's mid contour: another field, so they cross).
    float w = fbm(p * 0.7, t * 0.3);
    float n = fbm(p + float2(w, -w) * 2.5, t * 0.6);
    float pulse = 0.55 + 0.45 * sin(time * 1.8 + w * 9.0);
    float vein = pow(1.0 - abs(2.0 * n - 1.0), 4.0);
    float blood = pow(max(0.0, 1.0 - 3.0 * abs(w - 0.45)), 6.0);
    body = 0.08 + 0.92 * max(vein, blood * 0.8) * pulse;
    tintAmt = blood * (1.0 - 0.7 * vein);
    tint = float3(0.45, 0.03, 0.04) * (0.6 + 0.4 * pulse);
  } else if (uMode < 8.5) {
    // Acid: a churning pool, now and then a bubble swelling and popping.
    float n = fbm(p, t);
    float2 g = at * 2.2 * uGrain + float2(n * 0.6);
    float2 cell = floor(g);
    float h = hash(cell);
    float2 off = (float2(hash(cell + 1.7), hash(cell + 3.1)) - 0.5) * 0.4;
    float phase = fract(time * 0.35 + h * 7.0);
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
    tint = float3(0.005, 0.015, 0.0);
  } else if (uMode < 9.5) {
    // Arcane: clouds turning round its point, with stars.
    float2 s = turn(at, r * 0.7 - time * 0.6);
    float2 sp = s * uGrain;
    float w = fbm(sp, t * 0.4);
    body = smoothstep(0.25, 0.75, fbm(sp + float2(w) * 1.6, t)) + motes(s * 4.0, 0.15, 0.1, 3.0) * 1.3;
  } else {
    // Force: slow, wide rings spreading from its point.
    float n = fbm(p, t * 0.5);
    float wave = 0.5 + 0.5 * sin(r * 2.8 - time * 2.5);
    body = 0.15 + 0.85 * pow(wave, 4.0) * (0.7 + 0.3 * n);
  }
  // Brighter along its edge (the Glance's shell, seen from above), wider where the body is bright.
  float rim = 1.0 - smoothstep(0.0, uCell * (0.22 + 0.25 * clamp(body, 0.0, 1.0)), d);
  rim *= rim;
  float3 color = mix(ramp(body * 0.9 + rim * 0.5), tint, tintAmt);
  float alpha = clamp(uOpacity * (0.35 + 0.65 * clamp(body, 0.0, 1.0)) + rim * 0.3, 0.0, 0.95) * edge;
  return half4(color * alpha, alpha);
}
`;
