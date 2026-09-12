import { TriMesh } from './mesh';

/** One level of linear (midpoint) subdivision: 4 triangles per triangle, geometry unchanged. */
export function subdivideLinear(m: TriMesh): TriMesh {
  const pos: number[] = Array.from(m.positions);
  const idx: number[] = [];
  const mid = new Map<number, number>();
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? a * m.nv + b : b * m.nv + a;
    let v = mid.get(key);
    if (v === undefined) {
      v = pos.length / 3;
      pos.push((m.positions[3 * a] + m.positions[3 * b]) / 2, (m.positions[3 * a + 1] + m.positions[3 * b + 1]) / 2, (m.positions[3 * a + 2] + m.positions[3 * b + 2]) / 2);
      mid.set(key, v);
    }
    return v;
  };
  for (let f = 0; f < m.nf; f++) {
    const a = m.indices[3 * f], b = m.indices[3 * f + 1], c = m.indices[3 * f + 2];
    const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
    idx.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return { positions: Float64Array.from(pos), indices: Uint32Array.from(idx), nv: pos.length / 3, nf: idx.length / 3 };
}

/** Subdivide until the mesh has at least `targetFaces` triangles (max 3 levels). */
export function refineToTarget(m: TriMesh, targetFaces: number, maxLevels = 3): { mesh: TriMesh; levels: number } {
  let mesh = m, levels = 0;
  while (mesh.nf < targetFaces && levels < maxLevels) { mesh = subdivideLinear(mesh); levels++; }
  return { mesh, levels };
}
