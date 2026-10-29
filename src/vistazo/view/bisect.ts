/**
 * Triangles (x, y, z each corner, nine numbers a triangle) cut down until no
 * side is longer than `most`: each pass halves every triangle that has one,
 * across its longest side, as three.js's TessellateModifier does (the same
 * triangles, in the same order), on plain numbers: no vectors, normals,
 * colors or uvs carried along, which made that slow on big surfaces.
 */
export function bisect(from: ArrayLike<number>, most: number, passes: number): Float32Array {
  const most2 = most * most;
  let src = Float64Array.from(from);
  let count = src.length;
  for (let pass = 0; pass < passes; pass++) {
    // At most every triangle in two.
    const out = new Float64Array(count * 2);
    let n = 0;
    let cut = false;
    const put = (x: number, y: number, z: number) => {
      out[n++] = x;
      out[n++] = y;
      out[n++] = z;
    };
    for (let i = 0; i < count; i += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = [src[i], src[i + 1], src[i + 2], src[i + 3], src[i + 4], src[i + 5], src[i + 6], src[i + 7], src[i + 8]];
      const dab = (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2;
      const dbc = (bx - cx) ** 2 + (by - cy) ** 2 + (bz - cz) ** 2;
      const dac = (ax - cx) ** 2 + (ay - cy) ** 2 + (az - cz) ** 2;
      if (dab <= most2 && dbc <= most2 && dac <= most2) {
        put(ax, ay, az);
        put(bx, by, bz);
        put(cx, cy, cz);
        continue;
      }
      cut = true;
      // The middle of the longest side (as Vector3.lerpVectors works it out), the two halves round it.
      if (dab >= dbc && dab >= dac) {
        const [mx, my, mz] = [ax + (bx - ax) * 0.5, ay + (by - ay) * 0.5, az + (bz - az) * 0.5];
        put(ax, ay, az);
        put(mx, my, mz);
        put(cx, cy, cz);
        put(mx, my, mz);
        put(bx, by, bz);
        put(cx, cy, cz);
      } else if (dbc >= dab && dbc >= dac) {
        const [mx, my, mz] = [bx + (cx - bx) * 0.5, by + (cy - by) * 0.5, bz + (cz - bz) * 0.5];
        put(ax, ay, az);
        put(bx, by, bz);
        put(mx, my, mz);
        put(mx, my, mz);
        put(cx, cy, cz);
        put(ax, ay, az);
      } else {
        const [mx, my, mz] = [ax + (cx - ax) * 0.5, ay + (cy - ay) * 0.5, az + (cz - az) * 0.5];
        put(ax, ay, az);
        put(bx, by, bz);
        put(mx, my, mz);
        put(mx, my, mz);
        put(bx, by, bz);
        put(cx, cy, cz);
      }
    }
    src = out;
    count = n;
    if (!cut) {
      break;
    }
  }
  return Float32Array.from(src.subarray(0, count));
}
