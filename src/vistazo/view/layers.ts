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
 * A material whose colour is each piece's own (its `tone` attribute, the same at every vertex of it),
 * taken where the material's colour is (its colour white, that is, times 1: the same numbers, in the
 * same order, as a material of that colour). So every piece of a kind can share one material (one
 * program, one material switch: see VistazoView's pieceMaterial). Flat: not interpolated across a
 * triangle (the very value). Over what the material's shader had already.
 */
export function toned<M extends THREE.MeshBasicMaterial>(material: M): M {
  const before = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 tone;\nflat varying vec3 vTone;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvTone = tone;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nflat varying vec3 vTone;")
      .replace("vec4 diffuseColor = vec4( diffuse, opacity );", "vec4 diffuseColor = vec4( diffuse * vTone, opacity );");
  };
  material.customProgramCacheKey = () => `${key()}+rising-ranges/toned`;
  return material;
}

/** A piece's `tone` attribute (see toned): its colour at each of its `count` vertices. */
export function toneAttribute(count: number, color: THREE.Color): THREE.BufferAttribute {
  const array = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    array[i * 3] = color.r;
    array[i * 3 + 1] = color.g;
    array[i * 3 + 2] = color.b;
  }
  return new THREE.BufferAttribute(array, 3);
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
 * zoom, a line as Owlbear's grid has it (its width, colour and opacity; solid,
 * dashed or dotted; a pixel wide at least); fading out where the cells get too small to tell
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
      .replace("#include <map_fragment>", "#include <map_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, uGridColor, uGridOpacity * gridLine(vGridAt));");
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
  uniform float uGridWidth;
  uniform vec3 uGridColor;
  uniform float uGridOpacity;
  uniform float uGridDash;
  uniform vec2 uGridCenter;
  // A flat-topped hex's distance from its middle, in the way its edges go (its apothem at the edge).
  float hexFlat(vec2 q) {
    q = abs(q);
    return max(q.y, 0.8660254 * q.x + 0.5 * q.y);
  }
  // A point by its cell's nearest edge (scene px): how far inside it, how far along it (0 to 1, corner
  // to corner), and how far from that edge's nearer corner. The nearest of two offset lattices' centers.
  vec3 hexEdge(vec2 p, bool flatTop) {
    float d = uGridDpi;
    float s = 0.8660254 * d;
    vec2 q = p - uGridCenter;
    if (!flatTop) q = q.yx;
    vec2 period = vec2(2.0 * s, d);
    vec2 a = q - period * floor(q / period + 0.5);
    vec2 qb = q - vec2(s, 0.5 * d);
    vec2 b = qb - period * floor(qb / period + 0.5);
    vec2 v = hexFlat(a) < hexFlat(b) ? a : b;
    // Turned so its nearest edge (normals at 30° + 60° k) is the top one, at y = d / 2.
    float k = floor((atan(v.y, v.x) - 0.5235988) / 1.0471976 + 0.5);
    float turn = 1.0471976 * (1.0 - k);
    vec2 r = vec2(cos(turn) * v.x - sin(turn) * v.y, sin(turn) * v.x + cos(turn) * v.y);
    float side = d * 0.5773503;
    return vec3(0.5 * d - hexFlat(v), r.x / side + 0.5, length(vec2(abs(r.x) - 0.5 * side, r.y - 0.5 * d)));
  }
  float gridLine(vec2 p) {
    // How far a pixel goes here (taken first, where every pixel gets: a derivative needs them all).
    float px = length(fwidth(p));
    if (uGridKind < 0.5) return 0.0;
    float d = uGridDpi;
    float dist;
    float along;
    float corner;
    if (uGridKind < 1.5) {
      vec2 g = p / d;
      vec2 f = abs(fract(g + 0.5) - 0.5) * d;
      dist = min(f.x, f.y);
      along = f.x < f.y ? fract(g.y) : fract(g.x);
      corner = length(f);
    } else {
      vec3 h = hexEdge(p, uGridKind < 2.5);
      dist = h.x;
      along = h.y;
      corner = h.z;
    }
    // As wide as Owlbear draws it (its line width, scene px; a fiftieth of a cell till it's known).
    float width = uGridWidth > 0.0 ? uGridWidth : d * 0.02;
    if (uGridDash > 1.5) {
      // Dotted, as Owlbear's: a dot on each corner, as wide round as the line is wide.
      dist = corner;
      width *= 2.0;
    } else if (uGridDash > 0.5 && abs(fract(along * 3.0) - 0.5) > 0.25) {
      // Dashed, as Owlbear's: three dashes a side, each a sixth of it (by the side, not the width).
      return 0.0;
    }
    // A pixel wide at least; thinner than that, as much fainter as it's thinner (as a picture of it
    // made smaller would be), not wider.
    float halfWidth = max(width * 0.5, px * 0.5);
    float cover = min(1.0, width / (2.0 * halfWidth));
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
 * cells by the point's own hex steps, not whole ones). Sharp at any zoom.
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
  // cellStepsG: a hex cell's whole steps from the Origen's cells (as cellStepsFrom).
  float cellStepsG(vec2 cell, bool horizontal) {
    float best = 1e9;
    for (int k = 0; k < ${FILL_CELLS}; k++) {
      if (k >= uFillCellCount) break;
      best = min(best, hexStepsG(cell - uFillCells[k], horizontal));
    }
    if (uFillCellCount > 1) best += 1.0;
    return floor(best + 0.5);
  }
  // bandOfG: the first Banda whose edge a distance is within (uFillBands: past them all).
  float bandOfG(float across) {
    for (int k = 0; k < ${FILL_BANDS}; k++) {
      if (k >= uFillBands) break;
      if (across <= uFillEdges[k]) return float(k);
    }
    return float(uFillBands);
  }
  vec3 paintBands(vec3 color, vec2 at, bool tint) {
    if (uFillBands == 0) return color;
    vec2 d = (at - uFillOrigin) / uFillDpi;
    // How fast d changes from one pixel to the next (taken here, where every pixel gets: the rings' width).
    vec2 dx = dFdx(d);
    vec2 dy = dFdy(d);
    float across;
    float far = length(d);
    // On hex cells: how far (in pixels) the nearest cell edge with another Banda across it is, and that
    // edge's Banda (the inner one's, as a circle's ring is its Banda's edge).
    float hexLine = 1e9;
    float hexInk = 0.0;
    if (uFillShape < 0.5) {
      across = far;
    } else if (uFillShape < 1.5) {
      across = max(abs(d.x), abs(d.y));
      far = across;
    } else {
      bool horizontal = uFillShape < 2.5;
      vec2 base = uFillCells[0];
      vec2 cell = base + nearestCellG(d - base, horizontal);
      across = cellStepsG(cell, horizontal);
      // Its tint follows the point's own hex steps (as the map's gradient, ring.frag hexFrom), not
      // how far it is in a straight line: hexagons, as its Bandas are.
      far = 1e9;
      for (int k = 0; k < ${FILL_CELLS}; k++) {
        if (k >= uFillCellCount) break;
        far = min(far, hexStepsG(d - uFillCells[k], horizontal));
      }
      if (uFillCellCount > 1) far += 1.0;
      float own = bandOfG(across);
      vec2 off = d - cell;
      // Its six neighbours, one cell away (their edges half a cell from its middle).
      float first = horizontal ? 0.5235988 : 0.0;
      for (int k = 0; k < 6; k++) {
        float angle = first + float(k) * 1.0471976;
        vec2 n = vec2(cos(angle), sin(angle));
        float px = max(abs(dot(dx, n)) + abs(dot(dy, n)), 1e-6);
        float e = (0.5 - dot(off, n)) / px;
        if (e < 2.0 && e < hexLine) {
          float other = bandOfG(cellStepsG(cell + n, horizontal));
          if (other != own) {
            hexLine = e;
            hexInk = min(own, other);
          }
        }
      }
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
    float step = max(fwidth(across), 1e-6);
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
      } else if (hexLine < 2.0) {
        // Hex cells: on the cell edges where the Banda changes, as wide and smooth as a circle's
        // (both sides of the edge, a pixel and a half each).
        line = 1.0 - smoothstep(0.5, 1.5, hexLine);
        for (int k = 0; k < ${FILL_BANDS}; k++) {
          if (k >= uFillBands) break;
          if (float(k) == min(hexInk, float(uFillBands - 1))) ink = uFillColors[k];
        }
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
