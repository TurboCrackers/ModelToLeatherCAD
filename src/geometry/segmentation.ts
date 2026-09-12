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
  forcedSeamEdges: Set<number>;
  forbiddenSeamEdges: Set<number>;
  onProgress?: (msg: string) => void;
}

/** ARAP iterations while searching for cuts/merges; the final pattern is re-flattened at full quality. */
const SEARCH_ITERATIONS = 4;
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
function dijkstra(topo: MeshTopology, sources: number[], allowedEdges: (e: number) => boolean, blockedVerts: Set<number>): { dist: Map<number, number>; prev: Map<number, number> } {
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
      const nd = d + topo.edgeLengths[e];
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

/**
 * Decide where to cut a component that is not yet developable enough.
 * Returns ORIGINAL edge ids to add to the seam set.
 */
function chooseCut(orig: MeshTopology, cut: CutMesh, params: SegmentationParams, faces: Int32Array, flat: FlattenResult, seams: Set<number>): number[] {
  const ct = cut.topo;
  const info = componentInfo(ct, faces);
  const allowed = (e: number) => info.interiorEdges.has(e) && !params.forbiddenSeamEdges.has(cut.origEdge[e]);
  const toOrig = (edges: number[]) => edges.map((e) => cut.origEdge[e]);

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
      const dj = dijkstra(ct, [worst], allowed, new Set());
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
    // (b) distributed curvature: cut through the most central / most strained vertex to two sides
    const fromBoundary = dijkstra(ct, Array.from(info.boundaryVerts), allowed, new Set());
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
      const d1 = dijkstra(ct, [best], allowed, new Set());
      let b1 = -1, bd = Infinity;
      for (const v of info.boundaryVerts) {
        const d = d1.dist.get(v);
        if (d !== undefined && d < bd) { bd = d; b1 = v; }
      }
      if (b1 >= 0) {
        const p1 = pathEdges(ct, d1.prev, best, b1);
        const blocked = new Set(p1.verts.filter((v) => v !== best));
        const d2 = dijkstra(ct, [best], allowed, blocked);
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
          return toOrig(p1.edges);
        }
      }
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
    if (estimateBendRadius(th, topo.edgeStripWidth[e]) < params.minBendRadiusMm) isTightEdge[e] = 1;
  }
  const tightFace = new Uint8Array(nf);
  for (let e = 0; e < topo.ne; e++) {
    if (!isTightEdge[e]) continue;
    tightFace[topo.edgeFaces[2 * e]] = 1;
    tightFace[topo.edgeFaces[2 * e + 1]] = 1;
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
      const flat = flattenPatch(ct, ct.mesh.positions, faces, SEARCH_ITERATIONS);
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
        if (protectedSeams.has(e)) continue;
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
          const flat = flattenPatch(tryCut.topo, tryCut.topo.mesh.positions, comps[0], SEARCH_ITERATIONS);
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
