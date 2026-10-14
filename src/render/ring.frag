uniform mat3 model;
uniform mat3 data1;
uniform mat3 data2;
uniform mat3 data3;
uniform mat3 data4;
uniform mat3 data5;
uniform mat3 data6;
uniform float minFalloff;
uniform float maxFalloff;
uniform int type;
// The grid's rhombus width/height ratio, 0 on a flat grid (see axonometry.ts).
uniform float axonometry;
// One cell, px: on a hex grid, what goes in a Banda is whole cells (see hex.ts).
uniform float cell;
// The Origen's cells, px from it (bandRings.ts originUniform): its own cell,
// or the three around a corner. [x1 y1 x2] [y2 x3 y3] [count 0 0].
uniform mat3 origins;

float circle(vec2 p) {
  return length(p);
}

float square(vec2 p) {
  return max(abs(p.x), abs(p.y));
}

// Hex steps, continuous (see hex.ts): the largest projection on the three
// directions between neighbours, over cos 30°. 2 = hexHorizontal (sides at
// 0/60/120°), 3 = hexVertical (sides at 30/90/150°). What the gradient
// follows, so it flows across a whole Banda rather than cell by cell.
float hex(vec2 p, int kind) {
  float c30 = 0.8660254;
  float a = kind == 2 ? abs(p.x) : abs(p.x * c30 + p.y * 0.5);
  float b = kind == 2 ? abs(p.x * 0.5 + p.y * c30) : abs(p.y);
  float c = kind == 2 ? abs(-p.x * 0.5 + p.y * c30) : abs(-p.x * c30 + p.y * 0.5);
  return max(a, max(b, c)) / c30;
}

vec2 origin(int i) {
  return i == 0 ? vec2(origins[0].x, origins[0].y) : i == 1 ? vec2(origins[0].z, origins[1].x) : vec2(origins[1].y, origins[1].z);
}

// Hex steps (px) to the nearest of the Origen's cells; from a corner its
// three cells are already one step away (see hex.ts stepsFrom).
float hexFrom(vec2 p, int kind) {
  float best = hex(p - origin(0), kind);
  if (origins[2].x > 1.5) {
    best = min(best, min(hex(p - origin(1), kind), hex(p - origin(2), kind))) + cell;
  }
  return best;
}

// The hex steps of the cell a point is in (axial coordinates, cube-rounded,
// on the lattice of the Origen's cells), to the nearest of them: whole
// numbers, so a Banda takes whole cells.
float cellSteps(vec2 p, int kind) {
  vec2 c = (p - origin(0)) / cell;
  float r = kind == 2 ? c.x / 0.8660254 : c.y / 0.8660254;
  float q = kind == 2 ? c.y - 0.5 * r : c.x - 0.5 * r;
  float s = -q - r;
  float rq = floor(q + 0.5);
  float rr = floor(r + 0.5);
  float rs = floor(s + 0.5);
  float dq = abs(rq - q);
  float dr = abs(rr - r);
  float ds = abs(rs - s);
  if (dq > dr && dq > ds) {
    rq = -rr - rs;
  } else if (dr > ds) {
    rr = -rq - rs;
  } else {
    rs = -rq - rr;
  }
  // Back to where that cell's center is, px from the Origen.
  vec2 center = kind == 2
    ? vec2(rr * 0.8660254, rq + 0.5 * rr)
    : vec2(rq + 0.5 * rr, rr * 0.8660254);
  return floor(hexFrom(center * cell + origin(0), kind) / cell + 0.5);
}

// `dist` says which Banda a point is in, `shade` where in it (they differ on a hex grid: cells vs. a smooth gradient).
void addRing(inout vec3 color, inout float alpha, vec3 ringColor, float radius, float prevRadius, float dist, float shade) {
  if (radius <= 0.0) return;
  float outer = step(dist, radius);
  float inner = step(dist, prevRadius);
  float mask = outer - inner;
  float a = clamp((shade - prevRadius) / (radius - prevRadius), 0.0, 1.0);
  float falloff = mix(minFalloff, maxFalloff, a);
  alpha += falloff * mask;
  color += mix(vec3(1, 1, 1), ringColor, falloff) * mask;
}

half4 main(float2 coord) {
  vec2 worldCoord = (model * vec3(coord, 1.0)).xy;
  if (axonometry > 0.0) {
    worldCoord = vec2(worldCoord.y + worldCoord.x / axonometry, worldCoord.y - worldCoord.x / axonometry);
  }
  float shade = type == 0 ? circle(worldCoord) : type == 1 ? square(worldCoord) : hexFrom(worldCoord, type);
  float dist = type >= 2 ? cellSteps(worldCoord, type) * cell : shade;

  vec3 color = vec3(0.0);
  float alpha = 0.0;
  
  addRing(color, alpha, data1[1].rgb, data1[0].x, 0.0, dist, shade);
  addRing(color, alpha, data1[2].rgb, data1[0].y, data1[0].x, dist, shade);

  addRing(color, alpha, data2[1].rgb, data2[0].x, data1[0].y, dist, shade);
  addRing(color, alpha, data2[2].rgb, data2[0].y, data2[0].x, dist, shade);
  
  addRing(color, alpha, data3[1].rgb, data3[0].x, data2[0].y, dist, shade);
  addRing(color, alpha, data3[2].rgb, data3[0].y, data3[0].x, dist, shade);
  
  addRing(color, alpha, data4[1].rgb, data4[0].x, data3[0].y, dist, shade);
  addRing(color, alpha, data4[2].rgb, data4[0].y, data4[0].x, dist, shade);
  
  addRing(color, alpha, data5[1].rgb, data5[0].x, data4[0].y, dist, shade);
  addRing(color, alpha, data5[2].rgb, data5[0].y, data5[0].x, dist, shade);

  addRing(color, alpha, data6[1].rgb, data6[0].x, data5[0].y, dist, shade);
  addRing(color, alpha, data6[2].rgb, data6[0].y, data6[0].x, dist, shade);
  
  return half4(vec3(color) * alpha, alpha);
}