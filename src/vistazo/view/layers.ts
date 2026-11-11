import * as THREE from "three";
import { NOISE_2D } from "../glsl";
import { CLOUD_GLSL } from "../weather";
import { BASE_TEX_WIDTH } from "./baseBins";
import { DETAIL_GLSL, WALL_GRAIN } from "./shaders";
import { VIEW_CELL } from "./types";

// What the Vistazo's materials work out at each pixel over what they draw (see VistazoView, which
// gives each its uniforms): the bases painted on the terrain, the grid, the Bandas' rings, the clouds'
// shadows, the player view's fog, a wall's grain. Each a layer over three.js's own shader (see layer).

/** A material with a blended wall's grain (see WALL_GRAIN) over its colour, where it is in the view. */
export function grained<M extends THREE.MeshBasicMaterial>(material: M): M {
  // Over what the material's shader had already (the fog's cut, put on before it: see fogCut).
  const before = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGrainAt;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGrainAt = (modelMatrix * vec4(position, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vGrainAt;\n${NOISE_2D}\n${WALL_GRAIN}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\ndiffuseColor.rgb *= wallGrain(vGrainAt, ${VIEW_CELL.toFixed(1)});`);
  };
  material.customProgramCacheKey = () => `${key()}+rising-ranges/grained`;
  return material;
}

/**
 * A material showing the map's picture read where it's sharpest (see DETAIL_GLSL): the ground's
 * texture as its map, its uv the texture's box's. Over what its shader had already (the grid: put on
 * before this, which keeps the map's include for this to stand in for).
 */
export function detailed<M extends THREE.MeshBasicMaterial>(material: M, uniforms: Record<string, { value: unknown }>): M {
  const before = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${DETAIL_GLSL}`)
      .replace("#include <map_fragment>", "#ifdef USE_MAP\n  diffuseColor *= mapDetail(map, vMapUv);\n#endif");
  };
  material.customProgramCacheKey = () => `${key()}+rising-ranges/detailed`;
  return material;
}

/**
 * The grid's cells drawn over a ground material, worked out at each pixel
 * from where it is (scene px: the view units over uGridU): sharp at any
 * zoom, a line about a fiftieth of a cell wide (a pixel at least), darker
 * as the map's grid was; fading out where the cells get too small to tell
 * apart. Square: lines every cell (dpi). Hex, as Owlbear lays them out from
 * a cell's center, a cell (dpi) between neighbours: flat-topped (2) in
 * columns, every other one half a cell down; pointy (3) in rows, every
 * other one half a cell along. The same cells the hex rings follow.
 */
export function gridded(material: THREE.MeshBasicMaterial, uniforms: Record<string, { value: unknown }>) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vGridAt;\nuniform float uGridU;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGridAt = (modelMatrix * vec4(position, 1.0)).xy / uGridU;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec2 vGridAt;\n${GRID_GLSL}`)
      .replace("#include <map_fragment>", "#include <map_fragment>\ndiffuseColor.rgb *= 1.0 - 0.35 * gridLine(vGridAt);");
  };
  material.customProgramCacheKey = () => "rising-ranges/gridded";
}

/** The bases' texture (see binBases): `rows` rows of BASE_TEX_WIDTH float texels, read texel by texel. */
export function baseTexture(data: Float32Array, rows: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, BASE_TEX_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  return texture;
}

/**
 * The tokens' (and props') bases painted on a top or a wall of the terrain (on a wall, see BASE_WALL), worked out at each pixel from where
 * it is (view units): within a base's radius, darker (35%); its last two units (two pixels at least),
 * a light ring (a token's). On a slab's top (`deck`), only those standing on it, not those under it
 * (the terrain's own tops don't lie over one another: on them, wherever it is, steep ground too).
 * Over what's drawn there, the grid too, as the picture of them laid over it was. With gridded's (or
 * any) changes to the shader, kept.
 */

export function based(material: THREE.MeshBasicMaterial, uniforms: Record<string, { value: unknown }>, on: "top" | "deck" | "wall") {
  const define = on === "deck" ? "#define BASE_DECK\n" : on === "wall" ? "#define BASE_WALL\n" : "";
  layer(material, `based${on === "top" ? "" : `-${on}`}`, uniforms, `${define}${BASE_GLSL}`, "outgoingLight = paintBases(outgoingLight, vLayerAt);");
}

/**
 * The Bandas worked out at each pixel of a top or wall (see BAND_GLSL), as the map's rings: the ring
 * of each, and on a top (`tint`) the ground inside it tinted, if the options ask.
 */
export function tinted(material: THREE.MeshBasicMaterial, uniforms: Record<string, { value: unknown }>, tint: boolean) {
  layer(material, `tinted${tint ? "" : "-rings"}`, uniforms, BAND_GLSL, `#ifdef RR_BANDS\noutgoingLight = paintBands(outgoingLight, vLayerAt.xy / uFillU, ${tint});\n#endif`);
}

/** The clouds' shadows over a top or wall (see CLOUD_GLSL), when there are any. */
export function clouded(material: THREE.MeshBasicMaterial, uniforms: Record<string, { value: unknown }>) {
  layer(material, "clouded", uniforms, CLOUD_GLSL, "#ifdef RR_CLOUDS\noutgoingLight = shadeClouds(outgoingLight, vLayerAt.xy);\n#endif");
}

/**
 * The player view's fog over a top or wall, from its picture laid from above (see drawFog): under
 * it, not drawn (the fog's floor and curtains stand in for it, see buildFogFloor: its heights would
 * give it away); by its edge, tinted.
 */
export function fogged(material: THREE.MeshBasicMaterial, uniforms: Record<string, { value: unknown }>) {
  layer(material, "fogged", uniforms, FOG_GLSL, "#ifdef RR_FOG\nif (fogHidden(vLayerAt.xy)) discard;\noutgoingLight = paintFog(outgoingLight, vLayerAt.xy);\n#endif");
}

/**
 * As fogged, always (not only with RR_FOG on, as the terrain's own materials are, see layers): not drawn
 * where the fog hides, darkened where it covers; the material given back (a slab's sides, its belly; a
 * door's leaf).
 */
export function foggedToo<M extends THREE.MeshBasicMaterial>(material: M, uniforms: Record<string, { value: unknown }>): M {
  layer(material, "foggedtoo", uniforms, FOG_GLSL, "if (fogHidden(vLayerAt.xy)) discard;\noutgoingLight = paintFog(outgoingLight, vLayerAt.xy);");
  return material;
}

/** Not drawn under the player view's fog (lines). */
export function fogCut<M extends THREE.MeshBasicMaterial | THREE.LineBasicMaterial>(material: M, uniforms: Record<string, { value: unknown }>): M {
  layer(material, "fogcut", uniforms, FOG_GLSL, "if (fogHidden(vLayerAt.xy)) discard;");
  return material;
}

/** As fogCut, for a shader of its own: `at`, its pixel's place (view units, a vec2 it has). */
export function fogCutShader(material: THREE.ShaderMaterial, uniforms: Record<string, { value: unknown }>, at: string): THREE.ShaderMaterial {
  Object.assign(material.uniforms, uniforms);
  material.fragmentShader = `${FOG_GLSL}\n${material.fragmentShader.replace("void main() {", `void main() {\n    if (fogHidden(${at})) discard;`)}`;
  return material;
}

/**
 * Something worked out at each pixel of a material, over what it draws: its uniforms; its functions;
 * what it does to the colour (before it's written), from the pixel's place in the world (vLayerAt,
 * view units: one for every layer, worked out once a vertex). Over what the material's shader had
 * already (the grid, another layer), in that order.
 */
export function layer(material: THREE.Material, name: string, uniforms: Record<string, { value: unknown }>, head: string, body: string) {
  const before = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    if (!shader.vertexShader.includes("vLayerAt")) {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vLayerAt;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLayerAt = (modelMatrix * vec4(position, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vLayerAt;");
    }
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${head}`)
      .replace("#include <opaque_fragment>", `${body}\n#include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => `${key()}+rising-ranges/${name}`;
}

export const BASE_GLSL = /* glsl */ `
  uniform highp sampler2D uBaseTex;
  uniform int uBaseCount;
  uniform vec4 uBaseBins;
  uniform float uBaseDown;
  uniform float uBaseReach;
  vec4 baseTexel(int i) {
    return texelFetch(uBaseTex, ivec2(i % ${BASE_TEX_WIDTH}, i / ${BASE_TEX_WIDTH}), 0);
  }
  vec3 paintBases(vec3 color, vec3 at) {
    // Half a pixel either side of each edge (smooth at any zoom), worked out once (before anything that
    // differs from one pixel to the next: a derivative needs its neighbours to have got here too).
    float aa = max(length(fwidth(at.xy)), 1e-4) * 0.5;
    if (uBaseCount == 0) return color;
    // Only the bases in this pixel's bin (see binBases): however many there are, a few at most each.
    vec2 bin = floor((at.xy - uBaseBins.xy) / uBaseBins.z);
    if (bin.x < 0.0 || bin.y < 0.0 || bin.x >= uBaseBins.w || bin.y >= uBaseDown) return color;
    vec4 list = baseTexel(uBaseCount + int(bin.y * uBaseBins.w + bin.x));
    int start = int(list.x);
    int count = int(list.y);
    for (int n = 0; n < count; n++) {
      vec4 b = baseTexel(int(baseTexel(start + n).x));
      vec2 off = at.xy - b.xy;
      float r = abs(b.z);
      if (dot(off, off) > (r + aa) * (r + aa)) continue;
      #ifdef BASE_DECK
        if (abs(at.z - b.w) > uBaseReach) continue;
      #endif
      // On a wall: down from its feet as far as the wall goes (as on the tops under it), up half a cell
      // at most, fading (not up a tall wall beside it, nor a bridge's sides over it).
      float lift = 1.0;
      #ifdef BASE_WALL
        lift = 1.0 - smoothstep(0.0, uBaseReach, at.z - b.w);
        if (lift <= 0.0) continue;
      #endif
      float d = length(off);
      float inside = (1.0 - smoothstep(r - aa, r + aa, d)) * lift;
      color *= 1.0 - 0.35 * inside;
      if (b.z > 0.0) {
        // As the measuring rings (see BAND_GLSL): about two pixels wide at any zoom, smooth; just inside
        // its edge (its middle a pixel in), not spilling out of the base.
        float px = (r - d) / (2.0 * aa);
        color = mix(color, vec3(1.0), 0.95 * lift * (1.0 - smoothstep(0.5, 1.5, abs(px - 1.0))));
      }
    }
    return color;
  }
`;

export const GRID_GLSL = /* glsl */ `
  uniform float uGridKind;
  uniform float uGridDpi;
  uniform vec2 uGridCenter;
  // A flat-topped hex's distance from its middle, in the way its edges go (its apothem at the edge).
  float hexFlat(vec2 q) {
    q = abs(q);
    return max(q.y, 0.8660254 * q.x + 0.5 * q.y);
  }
  // How far a point is inside its cell's edge (scene px): the nearest of two offset lattices' centers.
  float hexEdge(vec2 p, bool flatTop) {
    float d = uGridDpi;
    float s = 0.8660254 * d;
    vec2 q = p - uGridCenter;
    if (!flatTop) q = q.yx;
    vec2 period = vec2(2.0 * s, d);
    vec2 a = q - period * floor(q / period + 0.5);
    vec2 qb = q - vec2(s, 0.5 * d);
    vec2 b = qb - period * floor(qb / period + 0.5);
    return 0.5 * d - min(hexFlat(a), hexFlat(b));
  }
  float gridLine(vec2 p) {
    if (uGridKind < 0.5) return 0.0;
    float d = uGridDpi;
    float dist;
    if (uGridKind < 1.5) {
      vec2 f = abs(fract(p / d + 0.5) - 0.5) * d;
      dist = min(f.x, f.y);
    } else {
      dist = hexEdge(p, uGridKind < 2.5);
    }
    float px = length(fwidth(p));
    // A pixel wide at least; thinner than that, as much fainter as it's thinner (as a picture of it
    // made smaller would be), not wider.
    float halfWidth = max(d * 0.01, px * 0.5);
    float cover = min(1.0, d * 0.02 / (2.0 * halfWidth));
    float line = (1.0 - smoothstep(halfWidth - px * 0.5, halfWidth + px * 0.5, dist)) * cover;
    // Too far to tell the cells apart: gone, not a grey haze.
    return line * (1.0 - smoothstep(d * 0.12, d * 0.35, px));
  }
`;

/** How many Bandas, and how many cells an Origen takes, the ground works out (see BAND_GLSL). */
export const FILL_BANDS = 12;

export const FILL_CELLS = 16;

/**
 * The Banda tint at a ground point (scene px), as buildReach measured it on
 * the CPU before: how far across it is (a circle, a square, or on hex cells
 * the whole steps of the cell it's in from the Origen's cells, as
 * cellStepsFrom), the first Banda whose edge it's within, and its color
 * fading in across the Banda (5% at its inner edge, 25% at its ring; on hex
 * cells by the point's own distance, not whole steps). Sharp at any zoom.
 */
export const BAND_GLSL = /* glsl */ `
  uniform float uFillU;
  uniform float uFillShape;
  uniform vec2 uFillOrigin;
  uniform float uFillDpi;
  uniform vec2 uFillCells[${FILL_CELLS}];
  uniform int uFillCellCount;
  uniform float uFillEdges[${FILL_BANDS}];
  uniform vec3 uFillColors[${FILL_BANDS}];
  uniform int uFillBands;
  uniform float uFillTint;
  uniform float uFillRings;
  const float C30 = 0.8660254;
  // hexSteps: how many hex steps an offset (cells) is, continuously.
  float hexStepsG(vec2 d, bool horizontal) {
    float first = horizontal ? 0.0 : 0.5235988;
    float most = 0.0;
    for (int k = 0; k < 3; k++) {
      float angle = first + float(k) * 1.0471976;
      most = max(most, abs(d.x * cos(angle) + d.y * sin(angle)));
    }
    return most / C30;
  }
  // nearestCell: the center of the cell an offset (cells, from a cell's center) falls in.
  vec2 nearestCellG(vec2 d, bool horizontal) {
    float r = horizontal ? d.x / C30 : d.y / C30;
    float q = horizontal ? d.y - 0.5 * r : d.x - 0.5 * r;
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
    }
    return horizontal ? vec2(rr * C30, rq + rr * 0.5) : vec2(rq + rr * 0.5, rr * C30);
  }
  vec3 paintBands(vec3 color, vec2 at, bool tint) {
    if (uFillBands == 0) return color;
    vec2 d = (at - uFillOrigin) / uFillDpi;
    float across;
    float far = length(d);
    if (uFillShape < 0.5) {
      across = far;
    } else if (uFillShape < 1.5) {
      across = max(abs(d.x), abs(d.y));
      far = across;
    } else {
      bool horizontal = uFillShape < 2.5;
      vec2 base = uFillCells[0];
      vec2 cell = base + nearestCellG(d - base, horizontal);
      float best = 1e9;
      for (int k = 0; k < ${FILL_CELLS}; k++) {
        if (k >= uFillCellCount) break;
        best = min(best, hexStepsG(cell - uFillCells[k], horizontal));
      }
      if (uFillCellCount > 1) best += 1.0;
      across = floor(best + 0.5);
    }
    int index = -1;
    float inner = 0.0;
    float outer = 0.0;
    for (int k = 0; k < ${FILL_BANDS}; k++) {
      if (k >= uFillBands) break;
      if (across <= uFillEdges[k]) {
        index = k;
        outer = uFillEdges[k];
        break;
      }
      inner = uFillEdges[k];
    }
    // How fast across and the Banda change from one pixel to the next (worked out here, where every
    // pixel gets: the rings' width from them).
    float step = max(fwidth(across), 1e-6);
    float banded = fwidth(float(index < 0 ? uFillBands : index));
    if (tint && uFillTint > 0.5 && index >= 0) {
      float t = clamp((far - inner) / max(outer - inner, 1e-6), 0.0, 1.0);
      color = mix(color, uFillColors[index], 0.05 + 0.2 * t * t);
    }
    if (uFillRings > 0.5) {
      float line = 0.0;
      vec3 ink = vec3(1.0);
      if (uFillShape < 1.5) {
        // A circle's or a square's: about two pixels wide on its edge, smooth.
        for (int k = 0; k < ${FILL_BANDS}; k++) {
          if (k >= uFillBands) break;
          float a = 1.0 - smoothstep(0.5, 1.5, abs(across - uFillEdges[k]) / step);
          if (a > line) {
            line = a;
            ink = uFillColors[k];
          }
        }
      } else if (banded > 0.0) {
        // Hex cells: where the Banda changes, between cells.
        line = 1.0;
        ink = uFillColors[index < 0 ? uFillBands - 1 : index];
      }
      color = mix(color, ink, 0.95 * line);
    }
    return color;
  }
`;

/** The fog's picture over a scene point (view units; see drawFog): its colour, as much as it covers there. */
export const FOG_GLSL = /* glsl */ `
  uniform sampler2D uFog;
  uniform sampler2D uFogHard;
  uniform vec4 uFogBox;
  uniform float uFogOn;
  // Whether the fog hides a point (view units): its sharp picture, past half (its outline, where the
  // curtains stand). A light's soft edge only darkens (see paintFog).
  bool fogHidden(vec2 at) {
    if (uFogOn < 0.5) return false;
    vec2 uv = (at - uFogBox.xy) / uFogBox.zw;
    return texture2D(uFogHard, vec2(uv.x, 1.0 - uv.y)).a > 0.5;
  }
  vec3 paintFog(vec3 color, vec2 at) {
    if (uFogOn < 0.5) return color;
    vec2 uv = (at - uFogBox.xy) / uFogBox.zw;
    vec4 fog = texture2D(uFog, vec2(uv.x, 1.0 - uv.y));
    return mix(color, fog.rgb, fog.a);
  }
`;
