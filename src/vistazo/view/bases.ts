import * as THREE from "three";

/** A token's base in a batch (see BaseBatch): its disc's and ring's meshes, and its place in them. */
export type BaseSeat = { meshes: THREE.InstancedMesh[]; index: number };

const place = new THREE.Matrix4();

/**
 * The flat bases under the tokens (or the props) that aren't on the terrain
 * (a slab's top, in the air: those on it are painted on it, see
 * VistazoView.paintBases), all drawn together: a dark disc and, if
 * `ringed`, a thin light ring round it, one mesh of each per size (most
 * tokens share one) with every base of that size an instance of it, not two
 * meshes a token. Each base is added (add), then all are made at once
 * (build); a base moved is put right in place (moveBase).
 */
export class BaseBatch {
  private readonly bySize = new Map<number, { seat: BaseSeat; x: number; y: number; z: number }[]>();

  constructor(private readonly ringed: boolean) {}

  /** A base of radius `r` at a point (view units); its meshes are there once built. */
  add(r: number, x: number, y: number, z: number): BaseSeat {
    const seat: BaseSeat = { meshes: [], index: 0 };
    const list = this.bySize.get(r) ?? [];
    seat.index = list.length;
    list.push({ seat, x, y, z });
    this.bySize.set(r, list);
    return seat;
  }

  /** The meshes, into `group`: every size's discs first, then the rings (drawn over any disc). */
  build(group: THREE.Group, fill: THREE.Material, ring: THREE.Material, prop: boolean) {
    const make = (geometry: THREE.BufferGeometry, material: THREE.Material, list: { seat: BaseSeat; x: number; y: number; z: number }[]) => {
      const mesh = new THREE.InstancedMesh(geometry, material, list.length);
      for (const { seat, x, y, z } of list) {
        mesh.setMatrixAt(seat.index, place.makeTranslation(x, y, z));
        seat.meshes.push(mesh);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.renderOrder = 3;
      // Its bases move without its bounds being worked out again: always drawn.
      mesh.frustumCulled = false;
      if (prop) {
        mesh.userData.prop = true;
      }
      group.add(mesh);
    };
    for (const [r, list] of this.bySize) {
      make(new THREE.CircleGeometry(r, 32), fill, list);
    }
    if (this.ringed) {
      for (const [r, list] of this.bySize) {
        // The whole disc, the ring drawn on its edge by its material (see ringMaterial): `aEdge`, 0 at the
        // middle to 1 on the edge.
        const disc = new THREE.CircleGeometry(r, 32);
        const edge = new Float32Array(disc.attributes.position.count).fill(1);
        edge[0] = 0;
        disc.setAttribute("aEdge", new THREE.BufferAttribute(edge, 1));
        make(disc, ring, list);
      }
    }
  }
}

/** A base put at a new point (view units). */
export function moveBase(seat: BaseSeat, x: number, y: number, z: number) {
  place.makeTranslation(x, y, z);
  for (const mesh of seat.meshes) {
    mesh.setMatrixAt(seat.index, place);
    mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * The flat bases' ring: as the measuring rings and the bases painted on the terrain (see BASE_GLSL),
 * about two pixels wide at any zoom, just inside the disc's edge (from its geometry's `aEdge`).
 */
export function ringMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, forceSinglePass: true, depthWrite: false, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aEdge;\nvarying float vEdge;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvEdge = aEdge;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vEdge;")
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\nfloat px = (1.0 - vEdge) / max(fwidth(vEdge), 1e-6);\ndiffuseColor.a *= 0.95 * (1.0 - smoothstep(0.5, 1.5, abs(px - 1.0)));"
      );
  };
  material.customProgramCacheKey = () => "rising-ranges/base-ring";
  return material;
}
