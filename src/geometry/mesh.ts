import { V3, sub3, cross3, len3, norm3, dot3 } from './vec';

/** Indexed triangle mesh in millimetres. */
export interface TriMesh {
  positions: Float64Array; // 3 * nv
  indices: Uint32Array; // 3 * nf
  nv: number;
  nf: number;
}

export interface CSR {
  offsets: Int32Array;
  items: Int32Array;
}

/** Full connectivity + differential quantities used throughout the pipeline. */
export interface MeshTopology {
  mesh: TriMesh;
  ne: number;
  /** edge k joins vertices edgeVerts[2k] < edgeVerts[2k+1] */
  edgeVerts: Int32Array;
  /** faces on either side, -1 if boundary */
  edgeFaces: Int32Array;
  /** faceEdges[3f+k] is the edge between face corner k and k+1 */
  faceEdges: Int32Array;
  vertexFaces: CSR;
  vertexEdges: CSR;
  faceNormals: Float64Array;
  faceAreas: Float64Array;
  faceCentroids: Float64Array;
  vertexNormals: Float64Array;
  /** Unsigned dihedral angle across each edge, radians (0 = coplanar). 0 for boundary edges. */
  dihedral: Float64Array;
  /** Signed: >0 convex (ridge), <0 concave (valley). */
  dihedralSigned: Float64Array;
  edgeLengths: Float64Array;
  /** Average height of the two adjacent triangles measured from the edge, i.e. strip width. */
  edgeStripWidth: Float64Array;
  angleDefect: Float64Array;
  isBoundaryVertex: Uint8Array;
}

export function vertexPos(m: TriMesh, v: number): V3 {
  return [m.positions[3 * v], m.positions[3 * v + 1], m.positions[3 * v + 2]];
}

/**
 * Build a welded indexed mesh from a triangle soup. Vertices closer than
 * `tol` are merged; degenerate triangles are removed.
 */
export function weldMesh(soup: ArrayLike<number>, tolRel = 1e-5): TriMesh {
  const n = Math.floor(soup.length / 9);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n * 9; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const tol = diag * tolRel;
  const inv = 1 / tol;
  const map = new Map<string, number>();
  const pos: number[] = [];
  const idx: number[] = [];
  const key = (x: number, y: number, z: number) =>
    `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
  const getIndex = (x: number, y: number, z: number): number => {
    const k = key(x, y, z);
    let v = map.get(k);
    if (v === undefined) {
      v = pos.length / 3;
      map.set(k, v);
      pos.push(x, y, z);
    }
    return v;
  };
  for (let f = 0; f < n; f++) {
    const o = f * 9;
    const a = getIndex(soup[o], soup[o + 1], soup[o + 2]);
    const b = getIndex(soup[o + 3], soup[o + 4], soup[o + 5]);
    const c = getIndex(soup[o + 6], soup[o + 7], soup[o + 8]);
    if (a === b || b === c || a === c) continue;
    const ab: V3 = [pos[3 * b] - pos[3 * a], pos[3 * b + 1] - pos[3 * a + 1], pos[3 * b + 2] - pos[3 * a + 2]];
    const ac: V3 = [pos[3 * c] - pos[3 * a], pos[3 * c + 1] - pos[3 * a + 1], pos[3 * c + 2] - pos[3 * a + 2]];
    if (len3(cross3(ab, ac)) < 1e-12 * diag * diag) continue;
    idx.push(a, b, c);
  }
  return { positions: Float64Array.from(pos), indices: Uint32Array.from(idx), nv: pos.length / 3, nf: idx.length / 3 };
}

export function meshFromIndexed(positions: ArrayLike<number>, indices: ArrayLike<number>): TriMesh {
  // Re-weld to remove duplicated vertices (e.g. per-face normals in glTF).
  const soup = new Float64Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    soup[3 * i] = positions[3 * v];
    soup[3 * i + 1] = positions[3 * v + 1];
    soup[3 * i + 2] = positions[3 * v + 2];
  }
  return weldMesh(soup);
}

export function transformMesh(m: TriMesh, scale: number, offset: V3 = [0, 0, 0]): TriMesh {
  const p = new Float64Array(m.positions.length);
  for (let i = 0; i < m.nv; i++) {
    p[3 * i] = m.positions[3 * i] * scale + offset[0];
    p[3 * i + 1] = m.positions[3 * i + 1] * scale + offset[1];
    p[3 * i + 2] = m.positions[3 * i + 2] * scale + offset[2];
  }
  return { ...m, positions: p };
}

export function boundingBox(m: TriMesh): { min: V3; max: V3; size: V3; center: V3; maxDim: number } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.nv; i++)
    for (let k = 0; k < 3; k++) {
      const v = m.positions[3 * i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  const size: V3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return { min, max, size, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], maxDim: Math.max(...size) };
}

function buildCSR(count: number, pairs: Array<[number, number]>): CSR {
  const offsets = new Int32Array(count + 1);
  for (const [a] of pairs) offsets[a + 1]++;
  for (let i = 0; i < count; i++) offsets[i + 1] += offsets[i];
  const items = new Int32Array(pairs.length);
  const fill = offsets.slice(0, count);
  for (const [a, b] of pairs) items[fill[a]++] = b;
  return { offsets, items };
}

export function csrRange(c: CSR, i: number): Int32Array {
  return c.items.subarray(c.offsets[i], c.offsets[i + 1]);
}

/**
 * Make face windings consistent across shared edges, then flip everything so
 * the normals point outward (positive signed volume / away from centroid).
 */
export function orientMesh(m: TriMesh): TriMesh {
  const idx = Uint32Array.from(m.indices);
  const nf = m.nf;
  // Build directed edge map: key (a,b) -> face
  const edgeToFaces = new Map<string, number[]>();
  const ek = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[3 * f + k], b = idx[3 * f + ((k + 1) % 3)];
      const key = ek(a, b);
      let arr = edgeToFaces.get(key);
      if (!arr) edgeToFaces.set(key, (arr = []));
      arr.push(f);
    }
  }
  const visited = new Uint8Array(nf);
  const hasDirected = (f: number, a: number, b: number) => {
    for (let k = 0; k < 3; k++) if (idx[3 * f + k] === a && idx[3 * f + ((k + 1) % 3)] === b) return true;
    return false;
  };
  const flip = (f: number) => {
    const t = idx[3 * f + 1];
    idx[3 * f + 1] = idx[3 * f + 2];
    idx[3 * f + 2] = t;
  };
  for (let seed = 0; seed < nf; seed++) {
    if (visited[seed]) continue;
    visited[seed] = 1;
    const stack = [seed];
    while (stack.length) {
      const f = stack.pop()!;
      for (let k = 0; k < 3; k++) {
        const a = idx[3 * f + k], b = idx[3 * f + ((k + 1) % 3)];
        const nbrs = edgeToFaces.get(ek(a, b))!;
        if (nbrs.length !== 2) continue;
        const g = nbrs[0] === f ? nbrs[1] : nbrs[0];
        if (visited[g]) continue;
        // consistent orientation: g must contain the edge as (b,a)
        if (hasDirected(g, a, b)) flip(g);
        visited[g] = 1;
        stack.push(g);
      }
    }
  }
  // Global flip: signed volume for closed meshes, otherwise normals vs centroid.
  const p = m.positions;
  let vol = 0;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < m.nv; i++) { cx += p[3 * i]; cy += p[3 * i + 1]; cz += p[3 * i + 2]; }
  cx /= m.nv; cy /= m.nv; cz /= m.nv;
  let outwardScore = 0;
  let boundaryEdges = 0;
  for (const arr of edgeToFaces.values()) if (arr.length === 1) boundaryEdges++;
  for (let f = 0; f < nf; f++) {
    const a = idx[3 * f], b = idx[3 * f + 1], c = idx[3 * f + 2];
    const A: V3 = [p[3 * a], p[3 * a + 1], p[3 * a + 2]];
    const B: V3 = [p[3 * b], p[3 * b + 1], p[3 * b + 2]];
    const C: V3 = [p[3 * c], p[3 * c + 1], p[3 * c + 2]];
    vol += dot3(A, cross3(B, C)) / 6;
    const n = cross3(sub3(B, A), sub3(C, A));
    const cen: V3 = [(A[0] + B[0] + C[0]) / 3 - cx, (A[1] + B[1] + C[1]) / 3 - cy, (A[2] + B[2] + C[2]) / 3 - cz];
    outwardScore += dot3(n, cen);
  }
  const shouldFlip = boundaryEdges === 0 ? vol < 0 : outwardScore < 0;
  if (shouldFlip) for (let f = 0; f < nf; f++) flip(f);
  return { ...m, indices: idx };
}

export function buildTopology(mesh: TriMesh): MeshTopology {
  const { nv, nf, positions: p, indices: idx } = mesh;
  const edgeMap = new Map<number, number>();
  const edgeVertsArr: number[] = [];
  const edgeFacesArr: number[] = [];
  const faceEdges = new Int32Array(3 * nf);
  const vf: Array<[number, number]> = [];
  const ve: Array<[number, number]> = [];
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[3 * f + k], b = idx[3 * f + ((k + 1) % 3)];
      vf.push([a, f]);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const key = lo * nv + hi;
      let e = edgeMap.get(key);
      if (e === undefined) {
        e = edgeVertsArr.length / 2;
        edgeMap.set(key, e);
        edgeVertsArr.push(lo, hi);
        edgeFacesArr.push(f, -1);
        ve.push([lo, e], [hi, e]);
      } else {
        if (edgeFacesArr[2 * e + 1] === -1) edgeFacesArr[2 * e + 1] = f;
        // non-manifold (3+ faces): keep first two, ignore extra
      }
      faceEdges[3 * f + k] = e;
    }
  }
  const ne = edgeVertsArr.length / 2;
  const edgeVerts = Int32Array.from(edgeVertsArr);
  const edgeFaces = Int32Array.from(edgeFacesArr);
  const vertexFaces = buildCSR(nv, vf);
  const vertexEdges = buildCSR(nv, ve);

  const faceNormals = new Float64Array(3 * nf);
  const faceAreas = new Float64Array(nf);
  const faceCentroids = new Float64Array(3 * nf);
  const vertexNormals = new Float64Array(3 * nv);
  const angleDefect = new Float64Array(nv).fill(2 * Math.PI);
  const isBoundaryVertex = new Uint8Array(nv);
  for (let f = 0; f < nf; f++) {
    const a = idx[3 * f], b = idx[3 * f + 1], c = idx[3 * f + 2];
    const A: V3 = [p[3 * a], p[3 * a + 1], p[3 * a + 2]];
    const B: V3 = [p[3 * b], p[3 * b + 1], p[3 * b + 2]];
    const C: V3 = [p[3 * c], p[3 * c + 1], p[3 * c + 2]];
    const n = cross3(sub3(B, A), sub3(C, A));
    const l = len3(n);
    faceAreas[f] = l / 2;
    const nn = l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 1];
    faceNormals[3 * f] = nn[0]; faceNormals[3 * f + 1] = nn[1]; faceNormals[3 * f + 2] = nn[2];
    faceCentroids[3 * f] = (A[0] + B[0] + C[0]) / 3;
    faceCentroids[3 * f + 1] = (A[1] + B[1] + C[1]) / 3;
    faceCentroids[3 * f + 2] = (A[2] + B[2] + C[2]) / 3;
    // area-weighted vertex normals & interior angles
    const verts = [a, b, c];
    const P = [A, B, C];
    for (let k = 0; k < 3; k++) {
      const v = verts[k];
      vertexNormals[3 * v] += n[0]; vertexNormals[3 * v + 1] += n[1]; vertexNormals[3 * v + 2] += n[2];
      const e1 = norm3(sub3(P[(k + 1) % 3], P[k]));
      const e2 = norm3(sub3(P[(k + 2) % 3], P[k]));
      angleDefect[v] -= Math.acos(Math.max(-1, Math.min(1, dot3(e1, e2))));
    }
  }
  for (let v = 0; v < nv; v++) {
    const n = norm3([vertexNormals[3 * v], vertexNormals[3 * v + 1], vertexNormals[3 * v + 2]]);
    vertexNormals[3 * v] = n[0]; vertexNormals[3 * v + 1] = n[1]; vertexNormals[3 * v + 2] = n[2];
  }
  const dihedral = new Float64Array(ne);
  const dihedralSigned = new Float64Array(ne);
  const edgeLengths = new Float64Array(ne);
  const edgeStripWidth = new Float64Array(ne);
  for (let e = 0; e < ne; e++) {
    const a = edgeVerts[2 * e], b = edgeVerts[2 * e + 1];
    const A: V3 = [p[3 * a], p[3 * a + 1], p[3 * a + 2]];
    const B: V3 = [p[3 * b], p[3 * b + 1], p[3 * b + 2]];
    const L = len3(sub3(B, A));
    edgeLengths[e] = L;
    const f0 = edgeFaces[2 * e], f1 = edgeFaces[2 * e + 1];
    if (f1 === -1) {
      isBoundaryVertex[a] = 1; isBoundaryVertex[b] = 1;
      edgeStripWidth[e] = L > 0 ? (2 * faceAreas[f0]) / L : 0;
      continue;
    }
    const n0: V3 = [faceNormals[3 * f0], faceNormals[3 * f0 + 1], faceNormals[3 * f0 + 2]];
    const n1: V3 = [faceNormals[3 * f1], faceNormals[3 * f1 + 1], faceNormals[3 * f1 + 2]];
    const c = Math.max(-1, Math.min(1, dot3(n0, n1)));
    const ang = Math.acos(c);
    dihedral[e] = ang;
    // sign: convex if the neighbour centroid lies below face f0's plane
    const c1: V3 = [faceCentroids[3 * f1] - A[0], faceCentroids[3 * f1 + 1] - A[1], faceCentroids[3 * f1 + 2] - A[2]];
    dihedralSigned[e] = dot3(n0, c1) < 0 ? ang : -ang;
    edgeStripWidth[e] = L > 0 ? (faceAreas[f0] + faceAreas[f1]) / L : 0;
  }
  // boundary vertices have meaningless angle defect
  for (let v = 0; v < nv; v++) if (isBoundaryVertex[v]) angleDefect[v] = 0;

  return {
    mesh, ne, edgeVerts, edgeFaces, faceEdges, vertexFaces, vertexEdges,
    faceNormals, faceAreas, faceCentroids, vertexNormals, dihedral, dihedralSigned,
    edgeLengths, edgeStripWidth, angleDefect, isBoundaryVertex,
  };
}

/**
 * Offset the surface by `distance` (negative = inward) to develop the neutral
 * surface. Each vertex moves to the point that lies at `distance` from all of
 * its adjacent face planes (least squares, lightly regularised toward the
 * averaged-normal offset). Flat faces stay exactly flat and corners stay
 * sharp; on smooth meshes this reduces to the usual normal offset.
 */
export function offsetMesh(topo: MeshTopology, distance: number): TriMesh {
  const m = topo.mesh;
  const p = new Float64Array(m.positions.length);
  const lambda = 0.05;
  for (let v = 0; v < m.nv; v++) {
    const nv: V3 = [topo.vertexNormals[3 * v], topo.vertexNormals[3 * v + 1], topo.vertexNormals[3 * v + 2]];
    // distinct adjacent face normals (cluster within ~5°)
    const normals: V3[] = [];
    for (const f of csrRange(topo.vertexFaces, v)) {
      const n: V3 = [topo.faceNormals[3 * f], topo.faceNormals[3 * f + 1], topo.faceNormals[3 * f + 2]];
      if (!normals.some((q) => dot3(q, n) > 0.996)) normals.push(n);
    }
    // solve (Σ n nᵀ + λI) d = Σ n·distance + λ·nv·distance  for the displacement d
    const A = [[lambda, 0, 0], [0, lambda, 0], [0, 0, lambda]];
    const b = [lambda * nv[0] * distance, lambda * nv[1] * distance, lambda * nv[2] * distance];
    for (const n of normals) {
      for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) A[i][j] += n[i] * n[j]; b[i] += n[i] * distance; }
    }
    const d = solve3(A, b) ?? [nv[0] * distance, nv[1] * distance, nv[2] * distance];
    // guard against spikes at very acute corners
    const L = Math.hypot(d[0], d[1], d[2]);
    const maxL = 3 * Math.abs(distance);
    const sc = L > maxL ? maxL / L : 1;
    for (let k = 0; k < 3; k++) p[3 * v + k] = m.positions[3 * v + k] + d[k] * sc;
  }
  return { ...m, positions: p };
}

function solve3(A: number[][], b: number[]): number[] | null {
  const [a, b1, c] = A[0], [d, e, f] = A[1], [g, h, i] = A[2];
  const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-14) return null;
  const x = (b[0] * (e * i - f * h) - b1 * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det;
  const y = (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det;
  const z = (a * (e * b[2] - b[1] * h) - b1 * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det;
  return [x, y, z];
}

export function otherFace(topo: MeshTopology, e: number, f: number): number {
  const f0 = topo.edgeFaces[2 * e];
  return f0 === f ? topo.edgeFaces[2 * e + 1] : f0;
}

export function edgeBetween(topo: MeshTopology, a: number, b: number): number {
  for (const e of csrRange(topo.vertexEdges, a)) {
    const x = topo.edgeVerts[2 * e], y = topo.edgeVerts[2 * e + 1];
    if ((x === a && y === b) || (x === b && y === a)) return e;
  }
  return -1;
}

/** A mesh cut open along a set of edges: vertices along the cuts are duplicated per side. */
export interface CutMesh {
  topo: MeshTopology;
  /** cut vertex → original vertex */
  origVertex: Int32Array;
  /** cut edge → original edge */
  origEdge: Int32Array;
  /** original edge → cut edges (1 or 2) */
  cutEdgesOfOrig: Int32Array[];
  seamEdges: Set<number>;
}

export function cutMeshAlongEdges(orig: MeshTopology, developedPositions: Float64Array, seamEdges: Set<number>): CutMesh {
  const m = orig.mesh;
  const idx = m.indices;
  const newIndex = new Uint32Array(idx.length);
  const origVertexArr: number[] = [];
  const isSeamOrBoundary = (e: number) => seamEdges.has(e) || orig.edgeFaces[2 * e + 1] < 0;
  for (let v = 0; v < m.nv; v++) {
    const faces = csrRange(orig.vertexFaces, v);
    // union-find over incident faces
    const local = new Map<number, number>();
    faces.forEach((f, i) => local.set(f, i));
    const parent = Int32Array.from({ length: faces.length }, (_, i) => i);
    const find = (a: number): number => {
      while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
      return a;
    };
    for (const e of csrRange(orig.vertexEdges, v)) {
      if (isSeamOrBoundary(e)) continue;
      const a = local.get(orig.edgeFaces[2 * e]), b = local.get(orig.edgeFaces[2 * e + 1]);
      if (a === undefined || b === undefined) continue;
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }
    const groupId = new Map<number, number>();
    faces.forEach((f, i) => {
      const r = find(i);
      let nid = groupId.get(r);
      if (nid === undefined) {
        nid = origVertexArr.length;
        origVertexArr.push(v);
        groupId.set(r, nid);
      }
      for (let k = 0; k < 3; k++) if (idx[3 * f + k] === v) newIndex[3 * f + k] = nid;
    });
  }
  const nv = origVertexArr.length;
  const positions = new Float64Array(3 * nv);
  for (let i = 0; i < nv; i++) {
    const v = origVertexArr[i];
    positions[3 * i] = developedPositions[3 * v];
    positions[3 * i + 1] = developedPositions[3 * v + 1];
    positions[3 * i + 2] = developedPositions[3 * v + 2];
  }
  const cutTopo = buildTopology({ positions, indices: newIndex, nv, nf: m.nf });
  const origVertex = Int32Array.from(origVertexArr);
  const origEdge = new Int32Array(cutTopo.ne);
  const cutEdgesOfOrig: Int32Array[] = new Array(orig.ne);
  const tmp: number[][] = Array.from({ length: orig.ne }, () => []);
  for (let f = 0; f < m.nf; f++) {
    for (let k = 0; k < 3; k++) {
      const ce = cutTopo.faceEdges[3 * f + k];
      const oe = orig.faceEdges[3 * f + k];
      origEdge[ce] = oe;
    }
  }
  for (let ce = 0; ce < cutTopo.ne; ce++) tmp[origEdge[ce]].push(ce);
  for (let e = 0; e < orig.ne; e++) cutEdgesOfOrig[e] = Int32Array.from(tmp[e]);
  return { topo: cutTopo, origVertex, origEdge, cutEdgesOfOrig, seamEdges: new Set(seamEdges) };
}
