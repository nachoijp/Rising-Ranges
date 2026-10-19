import * as THREE from "three";

/** A token's base in a batch (see BaseBatch): its disc's and ring's meshes, and its place in them. */
export type BaseSeat = { meshes: THREE.InstancedMesh[]; index: number };

const place = new THREE.Matrix4();

/**
 * The bases under the tokens (or the props), all drawn together: a dark
 * disc and, if `ringed`, a thin light ring round it, one mesh of each per
 * size (most tokens share one) with every base of that size an instance of
 * it, not two meshes a token. Each base is added (add), then all are made
 * at once (build); a base moved is put right in place (moveBase).
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
        make(new THREE.RingGeometry(r - 2, r, 32), ring, list);
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
