import { TriMesh, MeshTopology, buildTopology, edgeBetween } from './mesh';

export interface RefinedMesh {
  mesh: TriMesh;
  levels: number;
  /** per refined vertex: -2 = original vertex, >=0 = lies on that original edge, -1 = inside an original face */
  lineage: Int32Array;
}

/** One level of linear (midpoint) subdivision: 4 triangles per triangle, geometry unchanged. */
export function subdivideLinear(m: TriMesh, lineage: Int32Array, orig: MeshTopology): RefinedMesh {
  const pos: number[] = Array.from(m.positions);
  const idx: number[] = [];
  const lin: number[] = Array.from(lineage);
  const mid = new Map<number, number>();
  const sharedEdge = (a: number, b: number): number => sharedLineage(lineage[a], lineage[b], a, b, orig);
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? a * m.nv + b : b * m.nv + a;
    let v = mid.get(key);
    if (v === undefined) {
      v = pos.length / 3;
      pos.push((m.positions[3 * a] + m.positions[3 * b]) / 2, (m.positions[3 * a + 1] + m.positions[3 * b + 1]) / 2, (m.positions[3 * a + 2] + m.positions[3 * b + 2]) / 2);
      lin.push(sharedEdge(a, b));
      mid.set(key, v);
    }
    return v;
  };
  for (let f = 0; f < m.nf; f++) {
    const a = m.indices[3 * f], b = m.indices[3 * f + 1], c = m.indices[3 * f + 2];
    const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
    idx.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return { mesh: { positions: Float64Array.from(pos), indices: Uint32Array.from(idx), nv: pos.length / 3, nf: idx.length / 3 }, levels: 1, lineage: Int32Array.from(lin) };
}

/** Original edge that both refined vertices lie on, or -1. */
export function sharedLineage(la: number, lb: number, a: number, b: number, orig: MeshTopology): number {
  if (la === -2 && lb === -2) return edgeBetween(orig, a, b); // both original vertices (level 0 only)
  if (la === -2 && lb >= 0) return orig.edgeVerts[2 * lb] === a || orig.edgeVerts[2 * lb + 1] === a ? lb : -1;
  if (lb === -2 && la >= 0) return orig.edgeVerts[2 * la] === b || orig.edgeVerts[2 * la + 1] === b ? la : -1;
  if (la >= 0 && la === lb) return la;
  return -1;
}

/** Subdivide until the mesh has at least `targetFaces` triangles (max 3 levels), tracking edge lineage. */
export function refineToTarget(orig: MeshTopology, targetFaces: number, maxLevels = 3): RefinedMesh {
  let cur: RefinedMesh = { mesh: orig.mesh, levels: 0, lineage: new Int32Array(orig.mesh.nv).fill(-2) };
  while (cur.mesh.nf < targetFaces && cur.levels < maxLevels) {
    const next = subdivideLinear(cur.mesh, cur.lineage, orig);
    cur = { ...next, levels: cur.levels + 1 };
  }
  return cur;
}

/**
 * Per refined edge: the strip width of the original edge it lies on, so bend-radius
 * estimates do not shrink with tessellation. Edges inside original faces keep their own.
 */
export function inheritedStripWidth(refined: MeshTopology, lineage: Int32Array, orig: MeshTopology): Float64Array {
  const out = Float64Array.from(refined.edgeStripWidth);
  for (let e = 0; e < refined.ne; e++) {
    const a = refined.edgeVerts[2 * e], b = refined.edgeVerts[2 * e + 1];
    const src = sharedLineage(lineage[a], lineage[b], a, b, orig);
    if (src >= 0) out[e] = orig.edgeStripWidth[src];
  }
  return out;
}

export { buildTopology };
