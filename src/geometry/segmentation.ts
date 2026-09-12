import { MeshTopology, CutMesh, cutMeshAlongEdges, csrRange, otherFace } from './mesh';
import { FlattenResult, flattenPatch } from './flatten';
import { estimateBendRadius } from '../leather/physics';

export interface SegmentationParams {
  /** developed (neutral-surface) positions, per ORIGINAL vertex */
  positions: Float64Array;
  minBendRadiusMm: number;
  canCreaseFold: boolean;
  creaseAngleDeg: number;
  flatAngleDeg: number;
  stretchLimit: number;
  maxSplits: number;
  minPatchFaces: number;
  /** interior vertices with more angle defect than this (radians) must lie on a cut */
  defectThresholdRad: number;
  /** relieve distributed curvature with darts (slits) rather than splitting pieces apart */
  preferDarts: boolean;
  /** after refinement, greedily merge small pieces back into neighbours when the leather allows */
  mergePieces: boolean;
  /** cut smoothly curved regions into regular gores around an axis instead of ad-hoc paths */
  regularSeams: boolean;
  /** gore axis: auto (flattest direction of the region, else model Y), or a fixed model axis */
  goreAxis: 'auto' | 'x' | 'y' | 'z';
  forcedSeamEdges: Set<number>;
  forbiddenSeamEdges: Set<number>;
  /** strip width per edge for bend-radius estimates (defaults to the topology's own) */
  edgeStripWidth?: Float64Array;
  /** when the mesh was refined: the original topology and children-per-face count (4^levels) so tightness is judged per ORIGINAL face */
  origTopo?: MeshTopology;
  faceChildren?: number;
  /** displayed (un-offset) positions, snapped together with `positions` when gore seams are planarised */
  displayPositions?: Float64Array;
  onProgress?: (msg: string) => void;
}

/** ARAP iterations while searching for cuts/merges; the final pattern is re-flattened at full quality. */
const SEARCH_ITERATIONS = 4;
/** the gore check decides the piece count, so it gets a more converged flatten */
const GORE_ITERATIONS = 8;
/** original edge ids created by regular gore cuts in the current run (kept out of the merge pass) */
const goreEdges = new Set<number>();
/** components already verified inside the gore check for the current run */
let preValidated: Array<{ faces: Int32Array; flat: FlattenResult }> = [];
/** regions (min face id + size) where a gore search already failed in this run */
const goreFailed = new Set<string>();
const FINAL_ITERATIONS = 14;

export const EDGE_SMOOTH = 0;
export const EDGE_FOLD = 1;
export const EDGE_SEAM = 2;
export const EDGE_BOUNDARY = 3;

export interface Patch {
  id: number;
  /** face ids (identical in original and cut mesh) */
  faces: Int32Array;
  /** flattening on the CUT mesh (vertex ids are cut-mesh ids) */
  flat: FlattenResult;
  overStrained: boolean;
  tightBend: boolean;
}

export interface SegmentationResult {
  cut: CutMesh;
  faceToPatch: Int32Array;
  patches: Patch[];
  /** per ORIGINAL edge */
  edgeClass: Uint8Array;
  warnings: string[];
  splits: number;
}

export const defaultSegmentationParams = (positions: Float64Array): SegmentationParams => ({
  positions,
  minBendRadiusMm: 2,
  canCreaseFold: true,
  creaseAngleDeg: 40,
  flatAngleDeg: 2,
  stretchLimit: 0.05,
  maxSplits: 150,
  minPatchFaces: 2,
  defectThresholdRad: 0.15,
  preferDarts: false,
  mergePieces: true,
  regularSeams: true,
  goreAxis: 'auto',
  forcedSeamEdges: new Set(),
  forbiddenSeamEdges: new Set(),
});

class UnionFind {
  parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(a: number): number {
    while (this.parent[a] !== a) {
      this.parent[a] = this.parent[this.parent[a]];
      a = this.parent[a];
    }
    return a;
  }
  union(a: number, b: number): void {
    a = this.find(a); b = this.find(b);
    if (a !== b) this.parent[a] = b;
  }
}

function componentsOf(topo: MeshTopology, faces: Iterable<number>, canCross: (edge: number, f: number, g: number) => boolean): Int32Array[] {
  const list = Array.from(faces);
  const inSet = new Uint8Array(topo.mesh.nf);
  for (const f of list) inSet[f] = 1;
  const uf = new UnionFind(topo.mesh.nf);
  for (const f of list) {
    for (let k = 0; k < 3; k++) {
      const e = topo.faceEdges[3 * f + k];
      const g = otherFace(topo, e, f);
      if (g < 0 || !inSet[g]) continue;
      if (canCross(e, f, g)) uf.union(f, g);
    }
  }
  const groups = new Map<number, number[]>();
  for (const f of list) {
    const r = uf.find(f);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(f);
  }
  return Array.from(groups.values()).map((g) => Int32Array.from(g));
}

/** Multi-source Dijkstra over the given edges. */
function dijkstra(topo: MeshTopology, sources: number[], allowedEdges: (e: number) => boolean, blockedVerts: Set<number>, cost?: (e: number) => number): { dist: Map<number, number>; prev: Map<number, number> } {
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const heap: Array<[number, number]> = [];
  const push = (d: number, v: number) => {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const s of sources) { dist.set(s, 0); push(0, s); }
  while (heap.length) {
    const [d, v] = pop();
    if (d > (dist.get(v) ?? Infinity)) continue;
    for (const e of csrRange(topo.vertexEdges, v)) {
      if (!allowedEdges(e)) continue;
      const a = topo.edgeVerts[2 * e], b = topo.edgeVerts[2 * e + 1];
      const w = a === v ? b : a;
      if (blockedVerts.has(w)) continue;
      const nd = d + (cost ? cost(e) : topo.edgeLengths[e]);
      if (nd < (dist.get(w) ?? Infinity)) {
        dist.set(w, nd);
        prev.set(w, e);
        push(nd, w);
      }
    }
  }
  return { dist, prev };
}

function pathEdges(topo: MeshTopology, prev: Map<number, number>, source: number, target: number): { edges: number[]; verts: number[] } {
  const edges: number[] = [];
  const verts: number[] = [target];
  let v = target;
  let guard = 0;
  while (v !== source && guard++ < 1e6) {
    const e = prev.get(v);
    if (e === undefined) break;
    edges.push(e);
    const a = topo.edgeVerts[2 * e], b = topo.edgeVerts[2 * e + 1];
    v = a === v ? b : a;
    verts.push(v);
  }
  return { edges, verts };
}

interface ComponentInfo {
  inSet: Uint8Array;
  boundaryVerts: Set<number>; // cut-mesh vertex ids
  interiorEdges: Set<number>; // cut-mesh edge ids
}

function componentInfo(ct: MeshTopology, faces: Int32Array): ComponentInfo {
  const inSet = new Uint8Array(ct.mesh.nf);
  for (const f of faces) inSet[f] = 1;
  const boundaryVerts = new Set<number>();
  const interiorEdges = new Set<number>();
  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      const e = ct.faceEdges[3 * f + k];
      const g = otherFace(ct, e, f);
      if (g >= 0 && inSet[g]) interiorEdges.add(e);
      else { boundaryVerts.add(ct.edgeVerts[2 * e]); boundaryVerts.add(ct.edgeVerts[2 * e + 1]); }
    }
  }
  return { inSet, boundaryVerts, interiorEdges };
}

/** Eigen-decomposition of a symmetric 3×3 matrix (Jacobi). Returns eigenvalues ascending with vectors. */
function eigen3(M: number[][]): { values: number[]; vectors: number[][] } {
  const a = M.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) off += a[i][j] * a[i][j];
    if (off < 1e-22) break;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - sn * akq; a[k][q] = sn * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - sn * aqk; a[q][k] = sn * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - sn * vkq; v[k][q] = sn * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return { values: order.map((i) => a[i][i]), vectors: order.map((i) => [v[0][i], v[1][i], v[2][i]]) };
}

/**
 * Regular gores: split a smoothly curved component with N equally spaced
 * planes through an axis (plus optionally the perpendicular "equator"),
 * choosing the fewest gores that meet the strain limit and rotating the set
 * so seams fall on the most curved spots. Returns ORIGINAL edge ids, or null.
 */
interface GoreResult { edges: number[]; ok: boolean; snap?: GoreSnap }
/** Everything needed to move gore-seam vertices exactly onto their cutting planes. */
interface GoreSnap { c: number[]; axis: number[]; e1: number[]; e2: number[]; angleOf: Map<number, number>; equatorVerts: Set<number> }

function goreCut(orig: MeshTopology, cut: CutMesh, params: SegmentationParams, faces: Int32Array, seams: Set<number>): GoreResult | null {
  const ct = cut.topo;
  const info = componentInfo(ct, faces);
  // gores are for the large smooth regions; small leftovers use the cheap fallback cuts
  if (faces.length < 8 || faces.length < 0.15 * ct.mesh.nf) return null;
  let minF = Infinity; for (const f of faces) if (f < minF) minF = f;
  const regionKey = `${minF}_${faces.length}`;
  if (goreFailed.has(regionKey)) return null;
  // area-weighted centroid & covariance of face centroids
  let A = 0; const c = [0, 0, 0];
  for (const f of faces) { const w = ct.faceAreas[f]; A += w; for (let k = 0; k < 3; k++) c[k] += ct.faceCentroids[3 * f + k] * w; }
  for (let k = 0; k < 3; k++) c[k] /= A || 1;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const f of faces) {
    const w = ct.faceAreas[f];
    const d = [ct.faceCentroids[3 * f] - c[0], ct.faceCentroids[3 * f + 1] - c[1], ct.faceCentroids[3 * f + 2] - c[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += w * d[i] * d[j];
  }
  const eig = eigen3(C);
  let axis: number[];
  if (params.goreAxis === 'x') axis = [1, 0, 0];
  else if (params.goreAxis === 'y') axis = [0, 1, 0];
  else if (params.goreAxis === 'z') axis = [0, 0, 1];
  else {
    // pick the axis the region is most rotationally symmetric about: for a surface of
    // revolution every face normal is coplanar with the axis, i.e. n · (axis × r) = 0
    const cands: number[][] = [[0, 1, 0], [1, 0, 0], [0, 0, 1], ...eig.vectors];
    let bestScore = Infinity; axis = [0, 1, 0];
    for (const ax of cands) {
      let sc = 0;
      for (const f of faces) {
        const r = [ct.faceCentroids[3 * f] - c[0], ct.faceCentroids[3 * f + 1] - c[1], ct.faceCentroids[3 * f + 2] - c[2]];
        const t = [ax[1] * r[2] - ax[2] * r[1], ax[2] * r[0] - ax[0] * r[2], ax[0] * r[1] - ax[1] * r[0]];
        const tl = Math.hypot(t[0], t[1], t[2]);
        if (tl < 1e-9) continue;
        const d = (ct.faceNormals[3 * f] * t[0] + ct.faceNormals[3 * f + 1] * t[1] + ct.faceNormals[3 * f + 2] * t[2]) / tl;
        // second term: band-like shapes (box walls) have normals perpendicular to their natural axis
        const na = ct.faceNormals[3 * f] * ax[0] + ct.faceNormals[3 * f + 1] * ax[1] + ct.faceNormals[3 * f + 2] * ax[2];
        sc += ct.faceAreas[f] * (d * d + na * na);
      }
      if (sc < bestScore * 0.95) { bestScore = sc; axis = ax; }
    }
  }
  const al = Math.hypot(axis[0], axis[1], axis[2]) || 1; axis = axis.map((v) => v / al);
  // orthonormal frame
  const ref = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let e1 = [ref[1] * axis[2] - ref[2] * axis[1], ref[2] * axis[0] - ref[0] * axis[2], ref[0] * axis[1] - ref[1] * axis[0]];
  const l1 = Math.hypot(e1[0], e1[1], e1[2]) || 1; e1 = e1.map((v) => v / l1);
  const e2 = [axis[1] * e1[2] - axis[2] * e1[1], axis[2] * e1[0] - axis[0] * e1[2], axis[0] * e1[1] - axis[1] * e1[0]];
  const theta = new Float64Array(ct.mesh.nf), height = new Float64Array(ct.mesh.nf);
  const BINS = 72;
  const hist = new Float64Array(BINS);
  for (const f of faces) {
    const d = [ct.faceCentroids[3 * f] - c[0], ct.faceCentroids[3 * f + 1] - c[1], ct.faceCentroids[3 * f + 2] - c[2]];
    const x = d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2], y = d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2];
    theta[f] = Math.atan2(y, x);
    height[f] = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
    // curvature concentration: dihedral of the face's edges
    let curv = 0;
    for (let k = 0; k < 3; k++) curv += orig.dihedral[cut.origEdge[ct.faceEdges[3 * f + k]]];
    hist[Math.floor(((theta[f] + Math.PI) / (2 * Math.PI)) * BINS) % BINS] += curv;
  }
  const trySectors = (N: number, equator: boolean): { edges: number[]; maxStrain: number; ok: boolean; snap: GoreSnap } => {
    // phase that puts the N seams on the most curved angles
    let bestPhi = 0, bestScore = -1;
    for (let b = 0; b < BINS; b++) {
      let sc = 0;
      for (let k = 0; k < N; k++) sc += hist[(b + Math.round((k * BINS) / N)) % BINS];
      if (sc > bestScore) { bestScore = sc; bestPhi = ((b + 0.5) / BINS) * 2 * Math.PI - Math.PI; }
    }
    const label = new Int32Array(ct.mesh.nf).fill(-1);
    const wrapA = (f: number) => { let a = theta[f] - bestPhi; return ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); };
    for (const f of faces) label[f] = Math.floor((wrapA(f) / (2 * Math.PI)) * N) % N + (equator && height[f] < 0 ? N : 0);
    if (N === 1) {
      // a single cut along the φ ray: label faces by which side of the ray they sit on so the
      // boundary is exactly the crossing edges (opens a ring into a strip)
      for (const f of faces) label[f] = wrapA(f) < Math.PI ? 0 : 1;
      const edges: number[] = [];
      const angleOf = new Map<number, number>();
      for (const e of info.interiorEdges) {
        if (params.forbiddenSeamEdges.has(cut.origEdge[e])) continue;
        const f = ct.edgeFaces[2 * e], g = ct.edgeFaces[2 * e + 1];
        const a = wrapA(f), b = wrapA(g);
        if (Math.abs(a - b) > Math.PI) {
          edges.push(cut.origEdge[e]);
          angleOf.set(cut.origVertex[ct.edgeVerts[2 * e]], bestPhi);
          angleOf.set(cut.origVertex[ct.edgeVerts[2 * e + 1]], bestPhi);
        }
      }
      const snap: GoreSnap = { c, axis, e1, e2, angleOf, equatorVerts: new Set() };
      if (!edges.length) return { edges, maxStrain: Infinity, ok: false, snap };
      const trySeams = new Set(seams); for (const e of edges) trySeams.add(e);
      const tryCut = cutMeshAlongEdges(orig, params.positions, trySeams);
      const comps = componentsOf(tryCut.topo, faces, () => true);
      let maxStrain = 0, ok = true;
      const flats: Array<{ faces: Int32Array; flat: FlattenResult }> = [];
      for (const comp of comps) {
        let fl = flattenPatch(tryCut.topo, tryCut.topo.mesh.positions, comp, GORE_ITERATIONS);
        if (fl.maxStrain > params.stretchLimit && fl.maxStrain < params.stretchLimit * 1.3) fl = flattenPatch(tryCut.topo, tryCut.topo.mesh.positions, comp, FINAL_ITERATIONS);
        const inf = componentInfo(tryCut.topo, comp);
        if (inf.boundaryVerts.size === 0 || fl.flippedFaces > 0 || fl.maxStrain > params.stretchLimit) ok = false;
        maxStrain = Math.max(maxStrain, fl.maxStrain);
        if (!ok) break;
        flats.push({ faces: comp, flat: fl });
      }
      if (ok) preValidated.push(...flats);
      return { edges, maxStrain, ok, snap };
    }
    // majority-vote cleanup so boundaries are clean edge paths
    for (let it = 0; it < 4; it++) {
      let changed = 0;
      for (const f of faces) {
        const counts = new Map<number, number>();
        for (let k = 0; k < 3; k++) {
          const e = ct.faceEdges[3 * f + k];
          if (!info.interiorEdges.has(e)) continue;
          const g = otherFace(ct, e, f);
          if (g >= 0) counts.set(label[g], (counts.get(label[g]) ?? 0) + 1);
        }
        let best = label[f], bc = counts.get(label[f]) ?? 0;
        for (const [l, n] of counts) if (n > bc) { bc = n; best = l; }
        if (best !== label[f] && bc >= 2) { label[f] = best; changed++; }
      }
      if (!changed) break;
    }
    const edges: number[] = [];
    const angleOf = new Map<number, number>();
    const conflict = new Set<number>();
    const equatorVerts = new Set<number>();
    const setAngle = (ov: number, a: number) => {
      const prev = angleOf.get(ov);
      if (prev !== undefined && Math.abs(Math.atan2(Math.sin(prev - a), Math.cos(prev - a))) > 1e-6) conflict.add(ov);
      else angleOf.set(ov, a);
    };
    for (const e of info.interiorEdges) {
      if (params.forbiddenSeamEdges.has(cut.origEdge[e])) continue;
      const la = label[ct.edgeFaces[2 * e]], lb = label[ct.edgeFaces[2 * e + 1]];
      if (la === lb) continue;
      edges.push(cut.origEdge[e]);
      const va = cut.origVertex[ct.edgeVerts[2 * e]], vb = cut.origVertex[ct.edgeVerts[2 * e + 1]];
      const sa = la % N, sb = lb % N;
      if (sa === sb) { equatorVerts.add(va); equatorVerts.add(vb); continue; }
      let k = -1;
      if ((sa + 1) % N === sb) k = sb; else if ((sb + 1) % N === sa) k = sa;
      if (k < 0) { conflict.add(va); conflict.add(vb); continue; }
      const a = bestPhi + (k * 2 * Math.PI) / N;
      setAngle(va, a); setAngle(vb, a);
    }
    for (const v of conflict) { angleOf.delete(v); }
    const snap: GoreSnap = { c, axis, e1, e2, angleOf, equatorVerts };
    if (!edges.length) return { edges, maxStrain: Infinity, ok: false, snap };
    const trySeams = new Set(seams); for (const e of edges) trySeams.add(e);
    const tryCut = cutMeshAlongEdges(orig, params.positions, trySeams);
    const comps = componentsOf(tryCut.topo, faces, () => true);
    let maxStrain = 0, ok = true;
    const flats: Array<{ faces: Int32Array; flat: FlattenResult }> = [];
    for (const comp of comps) {
      let fl = flattenPatch(tryCut.topo, tryCut.topo.mesh.positions, comp, GORE_ITERATIONS);
      // near miss: confirm with a fully converged flatten before rejecting this gore count
      if (fl.maxStrain > params.stretchLimit && fl.maxStrain < params.stretchLimit * 1.3) fl = flattenPatch(tryCut.topo, tryCut.topo.mesh.positions, comp, FINAL_ITERATIONS);
      const inf = componentInfo(tryCut.topo, comp);
      if (inf.boundaryVerts.size === 0 || fl.flippedFaces > 0) ok = false;
      maxStrain = Math.max(maxStrain, fl.maxStrain);
      if (fl.maxStrain > params.stretchLimit) ok = false;
      if (!ok) break;
      flats.push({ faces: comp, flat: fl });
    }
    if (ok) preValidated.push(...flats);
    return { edges, maxStrain, ok, snap };
  };
  let best: { edges: number[]; maxStrain: number; ok: boolean; snap: GoreSnap } | null = null;
  for (const equator of [false, true]) {
    let stale = 0, prev = Infinity;
    for (let N = !equator && info.boundaryVerts.size > 0 ? 1 : 2; N <= (equator ? 8 : 12); N++) {
      params.onProgress?.(`Trying ${N} regular gores${equator ? ' + equator' : ''}…`);
      const r = trySectors(N, equator);
      params.onProgress?.(`Gores ${N}${equator ? '+eq' : ''}: max strain ${(r.maxStrain * 100).toFixed(1)}% ${r.ok ? 'ok' : 'fail'} (${r.edges.length} edges)`);
      if (r.ok) return { edges: r.edges, ok: true, snap: r.snap };
      if (!best || r.maxStrain < best.maxStrain) best = r;
      // stop when more gores stop helping (e.g. a torus: sectors stay doubly curved)
      stale = r.maxStrain > prev * 0.9 ? stale + 1 : 0;
      prev = Math.min(prev, r.maxStrain);
      if (stale >= 2) break;
    }
    if (best && best.maxStrain > params.stretchLimit * 4) break; // hopeless: skip the equator series
  }
  goreFailed.add(regionKey);
  return best ? { edges: best.edges, ok: false } : null;
}

/** Move gore-seam vertices onto their cutting planes (rotation about the axis; equator → axis height 0). */
function applyGoreSnap(orig: MeshTopology, params: SegmentationParams, snap: GoreSnap): void {
  const arrays = [params.positions, params.displayPositions].filter((a): a is Float64Array => !!a);
  const { c, axis, e1, e2 } = snap;
  const idx = orig.mesh.indices;
  const faceNormal = (arr: Float64Array, f: number): number[] => {
    const a = idx[3 * f], b = idx[3 * f + 1], d = idx[3 * f + 2];
    const u = [arr[3 * b] - arr[3 * a], arr[3 * b + 1] - arr[3 * a + 1], arr[3 * b + 2] - arr[3 * a + 2]];
    const w = [arr[3 * d] - arr[3 * a], arr[3 * d + 1] - arr[3 * a + 1], arr[3 * d + 2] - arr[3 * a + 2]];
    return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  };
  /** move vertex v to p unless one of its faces would flip or collapse */
  const tryMove = (arr: Float64Array, v: number, p: number[]): void => {
    const before = Array.from(csrRange(orig.vertexFaces, v)).map((f) => faceNormal(arr, f));
    const old = [arr[3 * v], arr[3 * v + 1], arr[3 * v + 2]];
    arr[3 * v] = p[0]; arr[3 * v + 1] = p[1]; arr[3 * v + 2] = p[2];
    let ok = true;
    Array.from(csrRange(orig.vertexFaces, v)).forEach((f, i) => {
      const n = faceNormal(arr, f), b = before[i];
      const dot = n[0] * b[0] + n[1] * b[1] + n[2] * b[2];
      const lb = Math.hypot(b[0], b[1], b[2]), ln = Math.hypot(n[0], n[1], n[2]);
      if (lb > 0 && (ln < 0.2 * lb || dot / (lb * ln) < 0.3)) ok = false;
    });
    if (!ok) { arr[3 * v] = old[0]; arr[3 * v + 1] = old[1]; arr[3 * v + 2] = old[2]; }
  };
  for (const arr of arrays) {
    for (const [v, a] of snap.angleOf) {
      const d = [arr[3 * v] - c[0], arr[3 * v + 1] - c[1], arr[3 * v + 2] - c[2]];
      const h = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
      const x = d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2], y = d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2];
      const r = Math.hypot(x, y);
      if (r < 1e-6) continue; // on the axis (pole): leave
      const cur = Math.atan2(y, x);
      const delta = Math.atan2(Math.sin(a - cur), Math.cos(a - cur));
      if (Math.abs(delta) > Math.PI / 6) continue; // never rotate far: something else is going on here
      const nx = r * Math.cos(a), ny = r * Math.sin(a);
      tryMove(arr, v, [0, 1, 2].map((k) => c[k] + axis[k] * h + e1[k] * nx + e2[k] * ny));
    }
    for (const v of snap.equatorVerts) {
      if (snap.angleOf.has(v)) continue;
      const d = [arr[3 * v] - c[0], arr[3 * v + 1] - c[1], arr[3 * v + 2] - c[2]];
      const h = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
      tryMove(arr, v, [0, 1, 2].map((k) => arr[3 * v + k] - axis[k] * h));
    }
  }
}

/**
 * Polyhedron-style net: split the component into flat regions (faces connected across
 * non-crease edges), build the region graph weighted by shared crease length, keep a
 * maximum spanning tree of creases as folds and cut every other crease edge.
 */
function creaseNet(orig: MeshTopology, cut: CutMesh, params: SegmentationParams, faces: Int32Array, info: ComponentInfo): number[] | null {
  const ct = cut.topo;
  const creaseAngle = (params.creaseAngleDeg * Math.PI) / 180;
  const isCrease = (e: number) => orig.dihedral[cut.origEdge[e]] >= creaseAngle;
  const regions = componentsOf(ct, faces, (e) => !isCrease(e));
  if (regions.length < 2) return null;
  const regionOf = new Int32Array(ct.mesh.nf).fill(-1);
  regions.forEach((r, i) => { for (const f of r) regionOf[f] = i; });
  const pairs = new Map<string, { a: number; b: number; w: number; edges: number[] }>();
  for (const e of info.interiorEdges) {
    if (!isCrease(e) || params.forbiddenSeamEdges.has(cut.origEdge[e])) continue;
    const a = regionOf[ct.edgeFaces[2 * e]], b = regionOf[ct.edgeFaces[2 * e + 1]];
    if (a === b || a < 0 || b < 0) continue;
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    let p = pairs.get(key);
    if (!p) pairs.set(key, (p = { a, b, w: 0, edges: [] }));
    p.w += ct.edgeLengths[e];
    p.edges.push(e);
  }
  if (!pairs.size) return null;
  // Kruskal, longest shared creases first: those stay folds
  const uf = new UnionFind(regions.length);
  const sorted = Array.from(pairs.values()).sort((x, y) => y.w - x.w);
  const cutEdges: number[] = [];
  for (const p of sorted) {
    if (uf.find(p.a) !== uf.find(p.b)) uf.union(p.a, p.b);
    else cutEdges.push(...p.edges);
  }
  if (!cutEdges.length) return null;
  return cutEdges.map((e) => cut.origEdge[e]);
}

/**
 * Decide where to cut a component that is not yet developable enough.
 * Returns ORIGINAL edge ids to add to the seam set.
 */
function chooseCut(orig: MeshTopology, cut: CutMesh, params: SegmentationParams, faces: Int32Array, flat: FlattenResult, seams: Set<number>): number[] {
  const ct = cut.topo;
  const info = componentInfo(ct, faces);
  const allowed = (e: number) => info.interiorEdges.has(e) && !params.forbiddenSeamEdges.has(cut.origEdge[e]);
  const toOrig = (edges: number[]) => edges.map((e) => cut.origEdge[e]);
  // cuts should run along existing feature edges (creases) rather than across faces
  const creaseAngle = (params.creaseAngleDeg * Math.PI) / 180;
  const creaseCost = (e: number) => ct.edgeLengths[e] * (orig.dihedral[cut.origEdge[e]] >= creaseAngle ? 0.2 : 5);

  // (0) closed shape made of flat regions joined by foldable creases: unfold it into one net by
  // keeping a spanning tree of creases as folds and cutting the rest — no cuts across faces
  if (info.boundaryVerts.size === 0 && params.canCreaseFold) {
    const net = creaseNet(orig, cut, params, faces, info);
    if (net) return net;
  }

  if (info.boundaryVerts.size > 0) {
    // (a) concentrated curvature: dart from the worst interior vertex to the nearest boundary
    let worst = -1, worstDefect = params.defectThresholdRad;
    const seen = new Set<number>();
    for (const f of faces) for (let k = 0; k < 3; k++) {
      const cv = ct.mesh.indices[3 * f + k];
      if (seen.has(cv) || info.boundaryVerts.has(cv)) continue;
      seen.add(cv);
      const d = Math.abs(orig.angleDefect[cut.origVertex[cv]]);
      if (d > worstDefect) { worstDefect = d; worst = cv; }
    }
    if (worst >= 0) {
      const dj = dijkstra(ct, [worst], allowed, new Set(), creaseCost);
      let b = -1, bd = Infinity;
      for (const v of info.boundaryVerts) {
        const d = dj.dist.get(v);
        if (d !== undefined && d < bd) { bd = d; b = v; }
      }
      if (b >= 0) {
        const p = pathEdges(ct, dj.prev, worst, b);
        if (p.edges.length) return toOrig(p.edges);
      }
    }
    // (b0) distributed curvature, regular style: gores around an axis
    if (params.regularSeams) {
      const g = goreCut(orig, cut, params, faces, seams);
      if (g && g.ok) { for (const e of g.edges) goreEdges.add(e); if (g.snap) applyGoreSnap(orig, params, g.snap); return g.edges; }
    }
    // (b) distributed curvature: cut through the most central / most strained vertex to two sides
    const fromBoundary = dijkstra(ct, Array.from(info.boundaryVerts), allowed, new Set(), creaseCost);
    let maxD = 0;
    for (const [, d] of fromBoundary.dist) if (d > maxD) maxD = d;
    const strainSum = new Map<number, number>();
    const areaSum = new Map<number, number>();
    for (let t = 0; t < flat.faces.length; t++) {
      const f = flat.faces[t];
      const a = ct.faceAreas[f];
      for (let k = 0; k < 3; k++) {
        const v = ct.mesh.indices[3 * f + k];
        strainSum.set(v, (strainSum.get(v) ?? 0) + flat.faceStrain[t] * a);
        areaSum.set(v, (areaSum.get(v) ?? 0) + a);
      }
    }
    let maxS = 1e-12;
    for (const [v, s] of strainSum) maxS = Math.max(maxS, s / areaSum.get(v)!);
    let best = -1, bs = -1;
    for (const [v, d] of fromBoundary.dist) {
      if (info.boundaryVerts.has(v)) continue;
      const sn = (strainSum.get(v) ?? 0) / (areaSum.get(v) ?? 1) / maxS;
      const score = (maxD > 0 ? d / maxD : 0) + 0.5 * sn;
      if (score > bs) { bs = score; best = v; }
    }
    if (best >= 0) {
      const d1 = dijkstra(ct, [best], allowed, new Set(), creaseCost);
      let b1 = -1, bd = Infinity;
      for (const v of info.boundaryVerts) {
        const d = d1.dist.get(v);
        if (d !== undefined && d < bd) { bd = d; b1 = v; }
      }
      if (b1 >= 0) {
        const p1 = pathEdges(ct, d1.prev, best, b1);
        const blocked = new Set(p1.verts.filter((v) => v !== best));
        const d2 = dijkstra(ct, [best], allowed, blocked, creaseCost);
        const P = ct.mesh.positions;
        const B1 = [P[3 * b1], P[3 * b1 + 1], P[3 * b1 + 2]];
        let b2 = -1, bscore = -Infinity;
        for (const v of info.boundaryVerts) {
          if (blocked.has(v)) continue;
          const d = d2.dist.get(v);
          if (d === undefined) continue;
          const far = Math.hypot(P[3 * v] - B1[0], P[3 * v + 1] - B1[1], P[3 * v + 2] - B1[2]);
          const sc = far - (d - bd);
          if (sc > bscore) { bscore = sc; b2 = v; }
        }
        if (params.preferDarts && p1.edges.length) {
          // count existing dart edges (seam edges with both faces inside this piece) vs. its boundary
          let dartEdges = 0, boundaryEdges = 0;
          const inSet = info.inSet;
          for (const f of faces) for (let k = 0; k < 3; k++) {
            const oe = orig.faceEdges[3 * f + k];
            const g = otherFace(orig, oe, f);
            if (g < 0) { boundaryEdges++; continue; }
            if (!inSet[g]) boundaryEdges++;
            else if (seams.has(oe)) dartEdges++;
          }
          dartEdges /= 2;
          if (dartEdges < 0.6 * boundaryEdges) return toOrig(p1.edges);
        }
        const edges = [...p1.edges];
        if (b2 >= 0) edges.push(...pathEdges(ct, d2.prev, best, b2).edges);
        if (edges.length) {
          const cutSet = new Set(edges);
          const groups = componentsOf(ct, faces, (e) => !cutSet.has(e));
          const smallest = Math.min(...groups.map((g) => g.length));
          // accept a through-cut when it splits reasonably, otherwise use just the dart leg
          if (groups.length >= 2 && smallest >= Math.max(params.minPatchFaces, faces.length * 0.08)) return toOrig(edges);
          // a rim-to-rim cut that does not disconnect still opens a ring (annulus → strip)
          if (b2 >= 0 && groups.length === 1) return toOrig(edges);
          return toOrig(p1.edges);
        }
      }
    }
  }
  if (params.regularSeams && info.boundaryVerts.size === 0) {
    // gores only suit smoothly distributed curvature; a closed box-like shape has corner
    // defects that darts must relieve after a plane split
    let concentrated = false;
    const seenV = new Set<number>();
    for (const f of faces) for (let k = 0; k < 3; k++) {
      const cv = ct.mesh.indices[3 * f + k];
      if (seenV.has(cv)) continue;
      seenV.add(cv);
      if (Math.abs(orig.angleDefect[cut.origVertex[cv]]) > params.defectThresholdRad) { concentrated = true; break; }
    }
    if (!concentrated) {
      const g = goreCut(orig, cut, params, faces, seams);
      if (g && g.ok) { for (const e of g.edges) goreEdges.add(e); if (g.snap) applyGoreSnap(orig, params, g.snap); return g.edges; }
    }
  }
  // (c) closed surface (or nothing else worked): plane split along the principal axis
  const P = ct.mesh.positions;
  let cx = 0, cy = 0, cz = 0, A = 0;
  const cen: number[][] = [];
  for (const f of faces) {
    cen.push([ct.faceCentroids[3 * f], ct.faceCentroids[3 * f + 1], ct.faceCentroids[3 * f + 2], ct.faceAreas[f]]);
    cx += cen[cen.length - 1][0] * ct.faceAreas[f]; cy += cen[cen.length - 1][1] * ct.faceAreas[f]; cz += cen[cen.length - 1][2] * ct.faceAreas[f]; A += ct.faceAreas[f];
  }
  cx /= A; cy /= A; cz /= A;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const [x, y, z, w] of cen) {
    const d = [x - cx, y - cy, z - cz];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += w * d[i] * d[j];
  }
  let ax = [1, 0.7, 0.3];
  for (let it = 0; it < 60; it++) {
    const nx = [0, 0, 0];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) nx[i] += C[i][j] * ax[j];
    const l = Math.hypot(nx[0], nx[1], nx[2]) || 1;
    ax = [nx[0] / l, nx[1] / l, nx[2] / l];
  }
  const side = new Int8Array(ct.mesh.nf);
  faces.forEach((f, i) => { const [x, y, z] = cen[i]; side[f] = (x - cx) * ax[0] + (y - cy) * ax[1] + (z - cz) * ax[2] >= 0 ? 1 : 0; });
  // majority-vote smoothing of the labels so the boundary is a clean edge path (no alternating slivers)
  for (let it = 0; it < 4; it++) {
    let changed = 0;
    for (const f of faces) {
      let same = 0, other = 0;
      for (let k = 0; k < 3; k++) {
        const e = ct.faceEdges[3 * f + k];
        if (!info.interiorEdges.has(e)) continue;
        const g = otherFace(ct, e, f);
        if (g < 0) continue;
        if (side[g] === side[f]) same++; else other++;
      }
      if (other > same) { side[f] = side[f] ? 0 : 1; changed++; }
    }
    if (!changed) break;
  }
  const out: number[] = [];
  for (const e of info.interiorEdges) {
    if (params.forbiddenSeamEdges.has(cut.origEdge[e])) continue;
    const f = ct.edgeFaces[2 * e], g = ct.edgeFaces[2 * e + 1];
    if (side[f] !== side[g]) out.push(cut.origEdge[e]);
  }
  void P;
  return out;
}

function rebindFlat(flat: FlattenResult, ct: MeshTopology): FlattenResult {
  const localIndex = new Map<number, number>();
  const vertices = new Int32Array(flat.vertices.length);
  for (let t = 0; t < flat.faces.length; t++) {
    const f = flat.faces[t];
    for (let k = 0; k < 3; k++) {
      const cv = ct.mesh.indices[3 * f + k];
      const li = flat.localFaces[3 * t + k];
      localIndex.set(cv, li);
      vertices[li] = cv;
    }
  }
  return { ...flat, localIndex, vertices };
}

/**
 * Rough strain estimate for flattening a face set: proportional to the total absolute
 * Gaussian curvature of its interior vertices (calibrated on spherical caps: a hemisphere,
 * K = 2π, flattens with ≈ 39% strain).
 */
function predictedStrain(orig: MeshTopology, cut: CutMesh, faces: Int32Array): number {
  const ct = cut.topo;
  const info = componentInfo(ct, faces);
  let K = 0;
  const seen = new Set<number>();
  for (const f of faces) for (let k = 0; k < 3; k++) {
    const cv = ct.mesh.indices[3 * f + k];
    if (seen.has(cv) || info.boundaryVerts.has(cv)) continue;
    seen.add(cv);
    K += Math.abs(orig.angleDefect[cut.origVertex[cv]]);
  }
  return 0.19 * (K / Math.PI);
}

export function segmentMesh(topo: MeshTopology, params: SegmentationParams): SegmentationResult {
  const warnings: string[] = [];
  const nf = topo.mesh.nf;
  const flatAngle = (params.flatAngleDeg * Math.PI) / 180;
  const creaseAngle = (params.creaseAngleDeg * Math.PI) / 180;

  // ---- 1. classify edges
  const hard = new Uint8Array(topo.ne);
  const isTightEdge = new Uint8Array(topo.ne);
  for (let e = 0; e < topo.ne; e++) {
    if (topo.edgeFaces[2 * e + 1] < 0) continue;
    if (params.forbiddenSeamEdges.has(e)) continue;
    if (params.forcedSeamEdges.has(e)) { hard[e] = 1; continue; }
    const th = topo.dihedral[e];
    if (th < flatAngle) continue;
    if (th >= creaseAngle) { if (!params.canCreaseFold) hard[e] = 1; continue; }
    if (estimateBendRadius(th, (params.edgeStripWidth ?? topo.edgeStripWidth)[e]) < params.minBendRadiusMm) isTightEdge[e] = 1;
  }
  // A fold is only possible along a straight crease: a crease that curves (a flat bottom
  // meeting a rounded wall) cannot be folded and must be sewn. Judge per connected crease chain.
  {
    const ot = params.origTopo && params.faceChildren && params.faceChildren > 1 ? params.origTopo : topo;
    const isCrease = (e: number) => ot.edgeFaces[2 * e + 1] >= 0 && ot.dihedral[e] >= creaseAngle;
    const creaseAt: number[][] = Array.from({ length: ot.mesh.nv }, () => []);
    for (let e = 0; e < ot.ne; e++) if (isCrease(e)) { creaseAt[ot.edgeVerts[2 * e]].push(e); creaseAt[ot.edgeVerts[2 * e + 1]].push(e); }
    const seenE = new Uint8Array(ot.ne);
    const curvedOrig = new Set<number>();
    const P = ot.mesh.positions;
    const dir = (e: number, from: number): number[] => { const a = ot.edgeVerts[2 * e], b = ot.edgeVerts[2 * e + 1]; const to = a === from ? b : a; const d = [P[3 * to] - P[3 * from], P[3 * to + 1] - P[3 * from + 1], P[3 * to + 2] - P[3 * from + 2]]; const l = Math.hypot(d[0], d[1], d[2]) || 1; return d.map((v) => v / l); };
    for (let e0 = 0; e0 < ot.ne; e0++) {
      if (!isCrease(e0) || seenE[e0]) continue;
      // grow the chain in both directions through vertices with exactly two crease edges
      const chain = [e0]; seenE[e0] = 1;
      for (const side of [0, 1]) {
        let e = e0, v = ot.edgeVerts[2 * e0 + side];
        for (let guard = 0; guard < ot.ne; guard++) {
          const nexts = creaseAt[v].filter((x) => x !== e);
          if (creaseAt[v].length !== 2 || nexts.length !== 1 || seenE[nexts[0]]) break;
          e = nexts[0]; seenE[e] = 1; chain.push(e);
          v = ot.edgeVerts[2 * e] === v ? ot.edgeVerts[2 * e + 1] : ot.edgeVerts[2 * e];
        }
      }
      // turning along the chain: a straight crease has none; a rim curves a little at every vertex
      let maxTurn = 0, totalTurn = 0;
      const chainSet = new Set(chain);
      for (const v of new Set(chain.flatMap((e) => [ot.edgeVerts[2 * e], ot.edgeVerts[2 * e + 1]]))) {
        const es = creaseAt[v].filter((x) => chainSet.has(x));
        if (es.length !== 2) continue;
        const d1 = dir(es[0], v), d2 = dir(es[1], v);
        const turn = Math.PI - Math.acos(Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2])));
        maxTurn = Math.max(maxTurn, turn);
        totalTurn += turn;
      }
      if (maxTurn > (8 * Math.PI) / 180 || totalTurn > (25 * Math.PI) / 180) for (const e of chain) curvedOrig.add(e);
    }
    if (curvedOrig.size) {
      if (ot === topo) { for (const e of curvedOrig) if (!params.forbiddenSeamEdges.has(e)) hard[e] = 1; }
      else {
        // map original crease edges to refined sub-edges via lineage (both endpoints on that original edge)
        const lineageOf = params.edgeStripWidth ? null : null; void lineageOf;
        for (let e = 0; e < topo.ne; e++) {
          if (topo.edgeFaces[2 * e + 1] < 0 || topo.dihedral[e] < creaseAngle) continue;
          // a refined crease edge lies on exactly one original crease edge: find it by geometry (midpoint on the segment)
          const a = topo.edgeVerts[2 * e], b = topo.edgeVerts[2 * e + 1];
          const mx = (topo.mesh.positions[3 * a] + topo.mesh.positions[3 * b]) / 2, my = (topo.mesh.positions[3 * a + 1] + topo.mesh.positions[3 * b + 1]) / 2, mz = (topo.mesh.positions[3 * a + 2] + topo.mesh.positions[3 * b + 2]) / 2;
          for (const oe of curvedOrig) {
            const oa = ot.edgeVerts[2 * oe], ob = ot.edgeVerts[2 * oe + 1];
            const ax = P[3 * oa], ay = P[3 * oa + 1], az = P[3 * oa + 2], bx = P[3 * ob], by = P[3 * ob + 1], bz = P[3 * ob + 2];
            const ux = bx - ax, uy = by - ay, uz = bz - az; const L2 = ux * ux + uy * uy + uz * uz || 1;
            const t = ((mx - ax) * ux + (my - ay) * uy + (mz - az) * uz) / L2;
            if (t < -1e-6 || t > 1 + 1e-6) continue;
            const px = ax + ux * t, py = ay + uy * t, pz = az + uz * t;
            if (Math.hypot(mx - px, my - py, mz - pz) < 1e-6 * Math.sqrt(L2) + 1e-6) { if (!params.forbiddenSeamEdges.has(e)) hard[e] = 1; break; }
          }
        }
      }
    }
  }

  const tightFace = new Uint8Array(nf);
  if (params.origTopo && params.faceChildren && params.faceChildren > 1) {
    // judge tightness on the original mesh, then inherit per refined child face
    const ot = params.origTopo;
    const tightOrig = new Uint8Array(ot.mesh.nf);
    for (let e = 0; e < ot.ne; e++) {
      if (ot.edgeFaces[2 * e + 1] < 0) continue;
      const th = ot.dihedral[e];
      if (th < flatAngle || th >= creaseAngle) continue;
      if (estimateBendRadius(th, ot.edgeStripWidth[e]) < params.minBendRadiusMm) { tightOrig[ot.edgeFaces[2 * e]] = 1; tightOrig[ot.edgeFaces[2 * e + 1]] = 1; }
    }
    for (let f = 0; f < nf; f++) tightFace[f] = tightOrig[Math.floor(f / params.faceChildren)];
  } else {
    for (let e = 0; e < topo.ne; e++) {
      if (!isTightEdge[e]) continue;
      tightFace[topo.edgeFaces[2 * e]] = 1;
      tightFace[topo.edgeFaces[2 * e + 1]] = 1;
    }
  }
  const isHard = (e: number) => hard[e] === 1;

  // ---- 2. initial regions (non-tight faces, separated by hard edges); tight fillet faces absorbed by flood fill
  const regionFaces: number[] = [];
  for (let f = 0; f < nf; f++) if (!tightFace[f]) regionFaces.push(f);
  const faceToRegion = new Int32Array(nf).fill(-1);
  const groups = componentsOf(topo, regionFaces, (e) => !isHard(e));
  groups.forEach((g, i) => { for (const f of g) faceToRegion[f] = i; });
  let frontier: number[] = [];
  for (const g of groups) for (const f of g) frontier.push(f);
  while (frontier.length) {
    const next: number[] = [];
    const claims = new Map<number, number>();
    for (const f of frontier) {
      for (let k = 0; k < 3; k++) {
        const e = topo.faceEdges[3 * f + k];
        if (isHard(e)) continue;
        const g = otherFace(topo, e, f);
        if (g < 0 || faceToRegion[g] >= 0 || claims.has(g)) continue;
        claims.set(g, faceToRegion[f]);
      }
    }
    for (const [g, rid] of claims) { faceToRegion[g] = rid; next.push(g); }
    frontier = next;
  }
  const tightRegion = new Set<number>();
  const leftover: number[] = [];
  for (let f = 0; f < nf; f++) if (faceToRegion[f] < 0) leftover.push(f);
  if (leftover.length) {
    const lg = componentsOf(topo, leftover, (e) => !isHard(e));
    for (const g of lg) {
      const id = groups.length;
      groups.push(g);
      tightRegion.add(id);
      for (const f of g) faceToRegion[f] = id;
    }
    warnings.push(`${lg.length} region(s) bend tighter than this leather's minimum bend radius (${params.minBendRadiusMm.toFixed(1)} mm). Expect wrinkling there, or choose thinner/softer leather.`);
  }
  const faceTight = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) if (tightRegion.has(faceToRegion[f])) faceTight[f] = 1;

  // seam set (original edge ids)
  const seams = new Set<number>();
  for (let e = 0; e < topo.ne; e++) {
    const f0 = topo.edgeFaces[2 * e], f1 = topo.edgeFaces[2 * e + 1];
    if (f1 < 0) continue;
    if (faceToRegion[f0] !== faceToRegion[f1] || hard[e]) seams.add(e);
  }

  const protectedSeams = new Set(seams);
  goreEdges.clear();
  preValidated = [];
  goreFailed.clear();

  // ---- 3. cut → flatten → refine
  const validated = new Uint8Array(nf);
  const flatCache = new Map<number, FlattenResult>(); // keyed by min face id of a validated component
  const overStrainedKeys = new Set<number>();
  let splits = 0;
  let cut = cutMeshAlongEdges(topo, params.positions, seams);
  let patches: Patch[] = [];
  const allFaces = Array.from({ length: nf }, (_, i) => i);
  for (let round = 0; round < params.maxSplits + 10; round++) {
    const ct = cut.topo;
    const comps = componentsOf(ct, allFaces, () => true);
    patches = [];
    let cutsThisRound = 0;
    for (const faces of comps) {
      let minF = Infinity, allValid = true;
      for (const f of faces) { if (f < minF) minF = f; if (!validated[f]) allValid = false; }
      const cached = flatCache.get(minF);
      if (allValid && cached && cached.faces.length === faces.length) {
        patches.push({ id: patches.length, faces, flat: cached, overStrained: overStrainedKeys.has(minF), tightBend: faceTight[faces[0]] === 1 });
        continue;
      }
      for (const f of faces) validated[f] = 0;
      params.onProgress?.(`Flattening piece ${patches.length + 1} (${faces.length} faces)…`);
      let flat = flattenPatch(ct, ct.mesh.positions, faces, SEARCH_ITERATIONS);
      // near miss: confirm with a converged flatten before cutting further
      if ((flat.maxStrain > params.stretchLimit && flat.maxStrain < params.stretchLimit * 1.3) || flat.flippedFaces > 0) flat = flattenPatch(ct, ct.mesh.positions, faces, FINAL_ITERATIONS);
      const info = componentInfo(ct, faces);
      const closed = info.boundaryVerts.size === 0;
      const ok = !closed && flat.flippedFaces === 0 && flat.maxStrain <= params.stretchLimit;
      const giveUp = faces.length <= params.minPatchFaces || splits >= params.maxSplits;
      if (!ok && !giveUp) {
        const newEdges = chooseCut(topo, cut, params, faces, flat, seams).filter((e) => !seams.has(e));
        if (newEdges.length) {
          for (const e of newEdges) seams.add(e);
          splits++;
          cutsThisRound++;
          patches.push({ id: patches.length, faces, flat, overStrained: true, tightBend: faceTight[faces[0]] === 1 });
          continue;
        }
      }
      for (const f of faces) validated[f] = 1;
      flatCache.set(minF, flat);
      if (!ok) overStrainedKeys.add(minF);
      patches.push({ id: patches.length, faces, flat, overStrained: !ok, tightBend: faceTight[faces[0]] === 1 });
    }
    if (cutsThisRound === 0) break;
    cut = cutMeshAlongEdges(topo, params.positions, seams);
    // pieces verified by the gore check need no second judgement (avoids flaky re-cuts at the limit)
    for (const pv of preValidated) {
      let minF = Infinity; for (const f of pv.faces) { if (f < minF) minF = f; validated[f] = 1; }
      flatCache.set(minF, pv.flat);
    }
    preValidated = [];
  }
  // ---- 4. merge pass: absorb small pieces into neighbours (and remove darts) when the leather allows
  if (params.mergePieces) {
    const faceArea = (fs: Int32Array) => { let a = 0; for (const f of fs) a += topo.faceAreas[f]; return a; };
    for (let guard = 0; guard < 400; guard++) {
      const f2p = new Int32Array(nf);
      patches.forEach((p, i) => { for (const f of p.faces) f2p[f] = i; });
      // shared removable edges per patch pair (pa <= pb; pa === pb is a dart)
      const shared = new Map<string, number[]>();
      for (const e of seams) {
        if (protectedSeams.has(e) || goreEdges.has(e)) continue;
        const pa = f2p[topo.edgeFaces[2 * e]], pb = f2p[topo.edgeFaces[2 * e + 1]];
        const key = pa <= pb ? `${pa}_${pb}` : `${pb}_${pa}`;
        let arr = shared.get(key);
        if (!arr) shared.set(key, (arr = []));
        arr.push(e);
      }
      if (!shared.size) break;
      const order = patches.map((p, i) => ({ i, a: faceArea(p.faces) })).sort((x, y) => x.a - y.a);
      let accepted = false;
      outer: for (const { i } of order) {
        const cands: Array<{ other: number; edges: number[] }> = [];
        for (const [key, edges] of shared) {
          const [a, b] = key.split('_').map(Number);
          if (a === i || b === i) cands.push({ other: a === i ? b : a, edges });
        }
        cands.sort((x, y) => y.edges.length - x.edges.length);
        for (const c of cands) {
          const trySeams = new Set(seams);
          for (const e of c.edges) trySeams.delete(e);
          const tryCut = cutMeshAlongEdges(topo, params.positions, trySeams);
          const union = c.other === i ? patches[i].faces : Int32Array.from([...patches[i].faces, ...patches[c.other].faces]);
          const comps = componentsOf(tryCut.topo, union, () => true);
          if (comps.length !== 1) continue;
          // cheap prune: integrated Gaussian curvature of the union's interior predicts the strain
          if (predictedStrain(topo, tryCut, comps[0]) > params.stretchLimit * 1.6) continue;
          params.onProgress?.(`Trying to merge pieces (${union.length} faces)…`);
          let flat = flattenPatch(tryCut.topo, tryCut.topo.mesh.positions, comps[0], SEARCH_ITERATIONS);
          if ((flat.maxStrain > params.stretchLimit && flat.maxStrain < params.stretchLimit * 1.3) || flat.flippedFaces > 0) flat = flattenPatch(tryCut.topo, tryCut.topo.mesh.positions, comps[0], FINAL_ITERATIONS);
          const info = componentInfo(tryCut.topo, comps[0]);
          const ok = info.boundaryVerts.size > 0 && flat.flippedFaces === 0 && flat.maxStrain <= params.stretchLimit;
          if (!ok) continue;
          // accept
          seams.clear(); for (const e of trySeams) seams.add(e);
          cut = tryCut;
          const keep = new Map<number, FlattenResult>();
          for (const p of patches) { if (p.id === i || p.id === c.other) continue; let mf = Infinity; for (const f of p.faces) if (f < mf) mf = f; keep.set(mf, p.flat); }
          let mfu = Infinity; for (const f of comps[0]) if (f < mfu) mfu = f;
          keep.set(mfu, flat);
          const newComps = componentsOf(cut.topo, allFaces, () => true);
          patches = newComps.map((faces, id) => {
            let mf = Infinity; for (const f of faces) if (f < mf) mf = f;
            const cached = keep.get(mf);
            const fl = cached && cached.faces.length === faces.length ? cached : flattenPatch(cut.topo, cut.topo.mesh.positions, faces, SEARCH_ITERATIONS);
            return { id, faces, flat: fl, overStrained: fl.maxStrain > params.stretchLimit || fl.flippedFaces > 0, tightBend: faceTight[faces[0]] === 1 };
          });
          accepted = true;
          break outer;
        }
      }
      if (!accepted) break;
    }
  }

  // Final full-quality flattening on the final cut mesh (also refreshes vertex ids).
  for (const p of patches) {
    params.onProgress?.(`Final flattening of piece ${p.id + 1}…`);
    p.flat = flattenPatch(cut.topo, cut.topo.mesh.positions, p.faces, FINAL_ITERATIONS);
    if (p.flat.flippedFaces > 0) p.overStrained = true;
  }
  void rebindFlat;
  const overStrained = patches.filter((p) => p.overStrained).length;
  if (overStrained) warnings.push(`${overStrained} piece(s) exceed the leather's stretch limit (${(params.stretchLimit * 100).toFixed(1)}%). Raise the limit, pick a stretchier leather, or add manual cuts.`);
  if (splits >= params.maxSplits) warnings.push(`Stopped after ${params.maxSplits} automatic cuts.`);

  const faceToPatch = new Int32Array(nf);
  for (const p of patches) for (const f of p.faces) faceToPatch[f] = p.id;

  const edgeClass = new Uint8Array(topo.ne);
  for (let e = 0; e < topo.ne; e++) {
    if (topo.edgeFaces[2 * e + 1] < 0) { edgeClass[e] = EDGE_BOUNDARY; continue; }
    if (seams.has(e)) { edgeClass[e] = EDGE_SEAM; continue; }
    edgeClass[e] = topo.dihedral[e] >= creaseAngle ? EDGE_FOLD : EDGE_SMOOTH;
  }
  return { cut, faceToPatch, patches, edgeClass, warnings, splits };
}
