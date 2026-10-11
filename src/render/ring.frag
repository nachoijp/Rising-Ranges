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

float circle(vec2 p) {
  return length(p);
}

float square(vec2 p) {
  return max(abs(p.x), abs(p.y));
}

void addRing(inout vec3 color, inout float alpha, vec3 ringColor, float radius, float prevRadius, float dist) {
  if (radius <= 0.0) return;
  float outer = step(dist, radius);
  float inner = step(dist, prevRadius);
  float mask = outer - inner;
  float a = (dist - prevRadius) / (radius - prevRadius);
  float falloff = mix(minFalloff, maxFalloff, a);
  alpha += falloff * mask;
  color += mix(vec3(1, 1, 1), ringColor, falloff) * mask;
}

half4 main(float2 coord) {
  vec2 worldCoord = (model * vec3(coord, 1.0)).xy;
  if (axonometry > 0.0) {
    worldCoord = vec2(worldCoord.y + worldCoord.x / axonometry, worldCoord.y - worldCoord.x / axonometry);
  }
  float dist = type == 0 ? circle(worldCoord) : square(worldCoord);

  vec3 color = vec3(0.0);
  float alpha = 0.0;
  
  addRing(color, alpha, data1[1].rgb, data1[0].x, 0.0, dist);
  addRing(color, alpha, data1[2].rgb, data1[0].y, data1[0].x, dist);

  addRing(color, alpha, data2[1].rgb, data2[0].x, data1[0].y, dist);
  addRing(color, alpha, data2[2].rgb, data2[0].y, data2[0].x, dist);
  
  addRing(color, alpha, data3[1].rgb, data3[0].x, data2[0].y, dist);
  addRing(color, alpha, data3[2].rgb, data3[0].y, data3[0].x, dist);
  
  addRing(color, alpha, data4[1].rgb, data4[0].x, data3[0].y, dist);
  addRing(color, alpha, data4[2].rgb, data4[0].y, data4[0].x, dist);
  
  addRing(color, alpha, data5[1].rgb, data5[0].x, data4[0].y, dist);
  addRing(color, alpha, data5[2].rgb, data5[0].y, data5[0].x, dist);

  addRing(color, alpha, data6[1].rgb, data6[0].x, data5[0].y, dist);
  addRing(color, alpha, data6[2].rgb, data6[0].y, data6[0].x, dist);
  
  return half4(vec3(color) * alpha, alpha);
}