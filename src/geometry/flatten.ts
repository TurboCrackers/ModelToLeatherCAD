import { MeshTopology } from './mesh';
import { SparseBuilder, pcgSolve } from './sparse';
import { V3, sub3, dot3, cross3, len3 } from './vec';

export interface FlattenResult {
  /** global vertex ids of the patch, in local order */
  vertices: Int32Array;
  /** global → local index */
  localIndex: Map<number, number>;
  /** local face corner indices (3 per face), faces in the same order as input */
  localFaces: Int32Array;
  faces: Int32Array;
  /** 2D coordinates, 2 per local vertex */
  uv: Float64Array;
  /** per-face max principal strain deviation |σ-1| */
  faceStrain: Float64Array;
  maxStrain: number;
  meanStrain: number;
  flippedFaces: number;
  area3D: number;
  area2D: number;
}

interface LocalTri {
  x1: number; // P1 = (x1, 0)
  x2: number;
  y2: number; // P2 = (x2, y2)
  area: number;
}

function localTriangle(p: Float64Array, a: number, b: number, c: number): LocalTri {
  const A: V3 = [p[3 * a], p[3 * a + 1], p[3 * a + 2]];
  const B: V3 = [p[3 * b], p[3 * b + 1], p[3 * b + 2]];
  const C: V3 = [p[3 * c], p[3 * c + 1], p[3 * c + 2]];
  const e1 = sub3(B, A);
  const e2 = sub3(C, A);
  const L = len3(e1);
  if (L < 1e-12) return { x1: 1e-6, x2: 0, y2: 1e-6, area: 5e-13 };
  const x2 = dot3(e2, e1) / L;
  const y2 = len3(cross3(e1, e2)) / L;
  return { x1: L, x2, y2: Math.max(y2, 1e-9), area: Math.max((L * y2) / 2, 1e-18) };
}

/**
 * Flatten a set of faces to the plane. LSCM gives a conformal start; ARAP
 * iterations then minimise stretch, which is what leather actually resists.
 */
export function flattenPatch(topo: MeshTopology, positions: Float64Array, faceIds: ArrayLike<number>, arapIterations = 12): FlattenResult {
  const idx = topo.mesh.indices;
  const nf = faceIds.length;
  const faces = Int32Array.from(faceIds as any);
  const localIndex = new Map<number, number>();
  const verts: number[] = [];
  const localFaces = new Int32Array(3 * nf);
  for (let t = 0; t < nf; t++) {
    const f = faces[t];
    for (let k = 0; k < 3; k++) {
      const v = idx[3 * f + k];
      let li = localIndex.get(v);
      if (li === undefined) {
        li = verts.length;
        localIndex.set(v, li);
        verts.push(v);
      }
      localFaces[3 * t + k] = li;
    }
  }
  const nv = verts.length;
  const uv = new Float64Array(2 * nv);
  const faceStrain = new Float64Array(nf);
  const tris: LocalTri[] = new Array(nf);
  let area3D = 0;
  for (let t = 0; t < nf; t++) {
    const f = faces[t];
    tris[t] = localTriangle(positions, idx[3 * f], idx[3 * f + 1], idx[3 * f + 2]);
    area3D += tris[t].area;
  }
  if (nv < 3) {
    return { vertices: Int32Array.from(verts), localIndex, localFaces, faces, uv, faceStrain, maxStrain: 0, meanStrain: 0, flippedFaces: 0, area3D, area2D: 0 };
  }

  // ---- pins: two mutually far vertices
  const P = (i: number): V3 => {
    const v = verts[i];
    return [positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]];
  };
  const farthest = (from: number): number => {
    let best = 0, bd = -1;
    const a = P(from);
    for (let i = 0; i < nv; i++) {
      const d = len3(sub3(P(i), a));
      if (d > bd) { bd = d; best = i; }
    }
    return best;
  };
  let pinB = farthest(0);
  const pinA = farthest(pinB);
  if (pinA === pinB) pinB = (pinA + 1) % nv;
  const pinDist = len3(sub3(P(pinA), P(pinB)));

  // ---- LSCM
  const freeIndex = new Int32Array(nv).fill(-1);
  let nFree = 0;
  for (let i = 0; i < nv; i++) if (i !== pinA && i !== pinB) freeIndex[i] = nFree++;
  const pinned = new Float64Array(2 * nv);
  pinned[2 * pinA] = 0; pinned[2 * pinA + 1] = 0;
  pinned[2 * pinB] = pinDist; pinned[2 * pinB + 1] = 0;

  const N = new SparseBuilder(2 * nFree);
  const rhs = new Float64Array(2 * nFree);
  // per row: entries (col, val) for free unknowns; pinned contributions accumulate in rowRhs
  const cols: number[] = [];
  const vals: number[] = [];
  for (let t = 0; t < nf; t++) {
    const tri = tris[t];
    const Pl = [[0, 0], [tri.x1, 0], [tri.x2, tri.y2]];
    const s = 1 / Math.sqrt(2 * tri.area);
    // D_k = P_{k+2} - P_{k+1}
    const D: number[][] = [];
    for (let k = 0; k < 3; k++) {
      const a = Pl[(k + 2) % 3], b = Pl[(k + 1) % 3];
      D.push([(a[0] - b[0]) * s, (a[1] - b[1]) * s]);
    }
    for (let row = 0; row < 2; row++) {
      cols.length = 0; vals.length = 0;
      let rowRhs = 0;
      for (let k = 0; k < 3; k++) {
        const li = localFaces[3 * t + k];
        const dx = D[k][0], dy = D[k][1];
        // row 0: dy*u + dx*v ; row 1: dx*u - dy*v
        const cu = row === 0 ? dy : dx;
        const cv = row === 0 ? dx : -dy;
        const fi = freeIndex[li];
        if (fi >= 0) {
          cols.push(2 * fi, 2 * fi + 1); vals.push(cu, cv);
        } else {
          rowRhs -= cu * pinned[2 * li] + cv * pinned[2 * li + 1];
        }
      }
      for (let i = 0; i < cols.length; i++) {
        rhs[cols[i]] += vals[i] * rowRhs;
        for (let j = 0; j < cols.length; j++) N.add(cols[i], cols[j], vals[i] * vals[j]);
      }
    }
  }
  const x = new Float64Array(2 * nFree);
  if (nFree > 0) pcgSolve(N.build(), rhs, x, 3e-5, 1200);
  for (let i = 0; i < nv; i++) {
    const fi = freeIndex[i];
    if (fi >= 0) { uv[2 * i] = x[2 * fi]; uv[2 * i + 1] = x[2 * fi + 1]; }
    else { uv[2 * i] = pinned[2 * i]; uv[2 * i + 1] = pinned[2 * i + 1]; }
  }

  // ---- ARAP: constant cot-Laplacian, rotations re-fitted each iteration
  const cotW = new Float64Array(3 * nf); // weight of edge (k, k+1) = cot of angle at k+2
  for (let t = 0; t < nf; t++) {
    const tri = tris[t];
    const Pl = [[0, 0], [tri.x1, 0], [tri.x2, tri.y2]];
    for (let k = 0; k < 3; k++) {
      const o = Pl[(k + 2) % 3], a = Pl[k], b = Pl[(k + 1) % 3];
      const ea = [a[0] - o[0], a[1] - o[1]], eb = [b[0] - o[0], b[1] - o[1]];
      const cr = ea[0] * eb[1] - ea[1] * eb[0];
      const dt = ea[0] * eb[0] + ea[1] * eb[1];
      const cot = Math.abs(cr) > 1e-14 ? dt / Math.abs(cr) : 1e3;
      cotW[3 * t + k] = Math.min(Math.max(cot, 1e-3), 1e3);
    }
  }
  const Lb = new SparseBuilder(nv);
  for (let t = 0; t < nf; t++) {
    for (let k = 0; k < 3; k++) {
      const i = localFaces[3 * t + k], j = localFaces[3 * t + ((k + 1) % 3)];
      const w = cotW[3 * t + k];
      Lb.add(i, i, w); Lb.add(j, j, w); Lb.add(i, j, -w); Lb.add(j, i, -w);
    }
  }
  const anchor = pinA;
  const anchorW = 1;
  Lb.add(anchor, anchor, anchorW);
  const L = Lb.build();
  const bu = new Float64Array(nv), bv = new Float64Array(nv);
  const U = new Float64Array(nv), Vv = new Float64Array(nv);
  for (let i = 0; i < nv; i++) { U[i] = uv[2 * i]; Vv[i] = uv[2 * i + 1]; }
  const rot = new Float64Array(2 * nf); // cos, sin per face

  const computeRotations = () => {
    for (let t = 0; t < nf; t++) {
      const tri = tris[t];
      const i0 = localFaces[3 * t], i1 = localFaces[3 * t + 1], i2 = localFaces[3 * t + 2];
      // J = [du1 du2; dv1 dv2] * inv([x1 x2; 0 y2])
      const du1 = U[i1] - U[i0], du2 = U[i2] - U[i0];
      const dv1 = Vv[i1] - Vv[i0], dv2 = Vv[i2] - Vv[i0];
      const inv00 = 1 / tri.x1, inv01 = -tri.x2 / (tri.x1 * tri.y2), inv11 = 1 / tri.y2;
      const a = du1 * inv00, b = du1 * inv01 + du2 * inv11;
      const c = dv1 * inv00, d = dv1 * inv01 + dv2 * inv11;
      const r = Math.hypot(a + d, c - b);
      if (r < 1e-14) { rot[2 * t] = 1; rot[2 * t + 1] = 0; }
      else { rot[2 * t] = (a + d) / r; rot[2 * t + 1] = (c - b) / r; }
    }
  };
  for (let it = 0; it < arapIterations; it++) {
    computeRotations();
    bu.fill(0); bv.fill(0);
    for (let t = 0; t < nf; t++) {
      const tri = tris[t];
      const Pl = [[0, 0], [tri.x1, 0], [tri.x2, tri.y2]];
      const cs = rot[2 * t], sn = rot[2 * t + 1];
      for (let k = 0; k < 3; k++) {
        const i = localFaces[3 * t + k], j = localFaces[3 * t + ((k + 1) % 3)];
        const w = cotW[3 * t + k];
        const ex = Pl[k][0] - Pl[(k + 1) % 3][0], ey = Pl[k][1] - Pl[(k + 1) % 3][1];
        const rx = cs * ex - sn * ey, ry = sn * ex + cs * ey;
        bu[i] += w * rx; bu[j] -= w * rx;
        bv[i] += w * ry; bv[j] -= w * ry;
      }
    }
    bu[anchor] += anchorW * U[anchor];
    bv[anchor] += anchorW * Vv[anchor];
    pcgSolve(L, bu, U, 1e-5, 800);
    pcgSolve(L, bv, Vv, 1e-5, 800);
  }
  for (let i = 0; i < nv; i++) { uv[2 * i] = U[i]; uv[2 * i + 1] = Vv[i]; }

  // ---- strain
  let maxStrain = 0, meanAcc = 0, flipped = 0, area2D = 0;
  for (let t = 0; t < nf; t++) {
    const tri = tris[t];
    const i0 = localFaces[3 * t], i1 = localFaces[3 * t + 1], i2 = localFaces[3 * t + 2];
    const du1 = U[i1] - U[i0], du2 = U[i2] - U[i0];
    const dv1 = Vv[i1] - Vv[i0], dv2 = Vv[i2] - Vv[i0];
    const inv00 = 1 / tri.x1, inv01 = -tri.x2 / (tri.x1 * tri.y2), inv11 = 1 / tri.y2;
    const a = du1 * inv00, b = du1 * inv01 + du2 * inv11;
    const c = dv1 * inv00, d = dv1 * inv01 + dv2 * inv11;
    const det = a * d - b * c;
    if (det < 0) flipped++;
    const s1 = Math.hypot(a + d, b - c), s2 = Math.hypot(a - d, b + c);
    const sigMax = (s1 + s2) / 2, sigMin = Math.abs(s1 - s2) / 2;
    const strain = Math.max(Math.abs(sigMax - 1), Math.abs(sigMin - 1));
    faceStrain[t] = strain;
    if (strain > maxStrain) maxStrain = strain;
    meanAcc += strain * tri.area;
    area2D += Math.abs(du1 * dv2 - du2 * dv1) / 2;
  }
  return {
    vertices: Int32Array.from(verts), localIndex, localFaces, faces, uv, faceStrain,
    maxStrain, meanStrain: area3D > 0 ? meanAcc / area3D : 0, flippedFaces: flipped, area3D, area2D,
  };
}
