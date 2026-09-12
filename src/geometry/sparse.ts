/** Minimal sparse linear algebra: triplet assembly → CSR, Jacobi-preconditioned CG. */

export class SparseBuilder {
  private rows: Map<number, number>[] = [];
  constructor(public n: number) {
    for (let i = 0; i < n; i++) this.rows.push(new Map());
  }
  add(i: number, j: number, v: number): void {
    if (v === 0) return;
    const r = this.rows[i];
    r.set(j, (r.get(j) ?? 0) + v);
  }
  build(): CSRMatrix {
    const offsets = new Int32Array(this.n + 1);
    let nnz = 0;
    for (let i = 0; i < this.n; i++) {
      nnz += this.rows[i].size;
      offsets[i + 1] = nnz;
    }
    const cols = new Int32Array(nnz);
    const vals = new Float64Array(nnz);
    let k = 0;
    for (let i = 0; i < this.n; i++) {
      const keys = Array.from(this.rows[i].keys()).sort((a, b) => a - b);
      for (const j of keys) {
        cols[k] = j;
        vals[k] = this.rows[i].get(j)!;
        k++;
      }
    }
    return new CSRMatrix(this.n, offsets, cols, vals);
  }
}

export class CSRMatrix {
  constructor(public n: number, public offsets: Int32Array, public cols: Int32Array, public vals: Float64Array) {}
  multiply(x: Float64Array, out: Float64Array): void {
    for (let i = 0; i < this.n; i++) {
      let s = 0;
      for (let k = this.offsets[i]; k < this.offsets[i + 1]; k++) s += this.vals[k] * x[this.cols[k]];
      out[i] = s;
    }
  }
  diagonal(): Float64Array {
    const d = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++)
      for (let k = this.offsets[i]; k < this.offsets[i + 1]; k++) if (this.cols[k] === i) d[i] = this.vals[k];
    return d;
  }
}

/** Solve A x = b for SPD A with Jacobi-preconditioned conjugate gradients. x is used as the initial guess. */
export function pcgSolve(A: CSRMatrix, b: Float64Array, x: Float64Array, tol = 1e-9, maxIter = 4000): number {
  const n = A.n;
  const diag = A.diagonal();
  const invD = new Float64Array(n);
  for (let i = 0; i < n; i++) invD[i] = Math.abs(diag[i]) > 1e-300 ? 1 / diag[i] : 1;
  const r = new Float64Array(n);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const Ap = new Float64Array(n);
  A.multiply(x, Ap);
  let bnorm = 0;
  for (let i = 0; i < n; i++) {
    r[i] = b[i] - Ap[i];
    bnorm += b[i] * b[i];
  }
  bnorm = Math.sqrt(bnorm) || 1;
  let rz = 0;
  for (let i = 0; i < n; i++) {
    z[i] = invD[i] * r[i];
    p[i] = z[i];
    rz += r[i] * z[i];
  }
  let iter = 0;
  for (; iter < maxIter; iter++) {
    let rn = 0;
    for (let i = 0; i < n; i++) rn += r[i] * r[i];
    if (Math.sqrt(rn) / bnorm < tol) break;
    A.multiply(p, Ap);
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
    if (Math.abs(pAp) < 1e-300) break;
    const alpha = rz / pAp;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
    }
    let rzNew = 0;
    for (let i = 0; i < n; i++) {
      z[i] = invD[i] * r[i];
      rzNew += r[i] * z[i];
    }
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return iter;
}

/** Reverse Cuthill–McKee ordering of a symmetric CSR pattern: perm[newIndex] = oldIndex. */
export function reverseCuthillMcKee(A: CSRMatrix): Int32Array {
  const n = A.n;
  const visited = new Uint8Array(n);
  const order: number[] = [];
  const degree = (i: number) => A.offsets[i + 1] - A.offsets[i];
  const neighbors = (i: number): number[] => {
    const out: number[] = [];
    for (let k = A.offsets[i]; k < A.offsets[i + 1]; k++) if (A.cols[k] !== i) out.push(A.cols[k]);
    return out.sort((a, b) => degree(a) - degree(b));
  };
  for (let start = 0; start < n; start++) {
    if (visited[start]) continue;
    // pick a low-degree seed in this component
    let seed = start;
    for (let i = start; i < n; i++) if (!visited[i] && degree(i) < degree(seed)) seed = i;
    visited[seed] = 1;
    const queue = [seed];
    let head = 0;
    while (head < queue.length) {
      const v = queue[head++];
      order.push(v);
      for (const w of neighbors(v)) if (!visited[w]) { visited[w] = 1; queue.push(w); }
    }
  }
  order.reverse();
  return Int32Array.from(order);
}

/**
 * Banded Cholesky (LLᵀ) factorisation of an SPD matrix after a fill-reducing
 * permutation. Exact, and fast when the bandwidth stays moderate (meshes).
 */
export class BandedCholesky {
  n: number;
  band: number;
  perm: Int32Array; // perm[new] = old
  inv: Int32Array; // inv[old] = new
  L: Float64Array; // L[i*(band+1) + (i-j)] holds L(i,j) for i-band <= j <= i
  constructor(A: CSRMatrix, perm?: Int32Array) {
    this.n = A.n;
    this.perm = perm ?? reverseCuthillMcKee(A);
    this.inv = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) this.inv[this.perm[i]] = i;
    let band = 0;
    for (let i = 0; i < this.n; i++) for (let k = A.offsets[i]; k < A.offsets[i + 1]; k++) band = Math.max(band, Math.abs(this.inv[i] - this.inv[A.cols[k]]));
    this.band = band;
    const w = band + 1;
    const L = new Float64Array(this.n * w);
    // scatter permuted matrix into band storage (lower part)
    for (let i = 0; i < this.n; i++) {
      const pi = this.inv[i];
      for (let k = A.offsets[i]; k < A.offsets[i + 1]; k++) {
        const pj = this.inv[A.cols[k]];
        if (pj <= pi) L[pi * w + (pi - pj)] = A.vals[k];
      }
    }
    // factorise
    for (let j = 0; j < this.n; j++) {
      let d = L[j * w];
      const kmin = Math.max(0, j - band);
      for (let k = kmin; k < j; k++) { const l = L[j * w + (j - k)]; d -= l * l; }
      if (d <= 1e-300) d = 1e-300;
      const dj = Math.sqrt(d);
      L[j * w] = dj;
      const imax = Math.min(this.n - 1, j + band);
      for (let i = j + 1; i <= imax; i++) {
        let s = L[i * w + (i - j)];
        const k0 = Math.max(0, i - band, j - band);
        for (let k = k0; k < j; k++) s -= L[i * w + (i - k)] * L[j * w + (j - k)];
        L[i * w + (i - j)] = s / dj;
      }
    }
    this.L = L;
  }
  /** memory the factor needs (doubles) for a given matrix and permutation, to decide fallbacks */
  static estimateBand(A: CSRMatrix, perm: Int32Array): number {
    const inv = new Int32Array(A.n);
    for (let i = 0; i < A.n; i++) inv[perm[i]] = i;
    let band = 0;
    for (let i = 0; i < A.n; i++) for (let k = A.offsets[i]; k < A.offsets[i + 1]; k++) band = Math.max(band, Math.abs(inv[i] - inv[A.cols[k]]));
    return band;
  }
  solve(b: Float64Array, x: Float64Array): void {
    const { n, band, L, perm } = this;
    const w = band + 1;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = b[perm[i]];
    // forward: L z = y
    for (let i = 0; i < n; i++) {
      let s = y[i];
      const k0 = Math.max(0, i - band);
      for (let k = k0; k < i; k++) s -= L[i * w + (i - k)] * y[k];
      y[i] = s / L[i * w];
    }
    // backward: Lᵀ x = z
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i];
      const kmax = Math.min(n - 1, i + band);
      for (let k = i + 1; k <= kmax; k++) s -= L[k * w + (k - i)] * y[k];
      y[i] = s / L[i * w];
    }
    for (let i = 0; i < n; i++) x[perm[i]] = y[i];
  }
}

/** Solve SPD system exactly when the banded factor is affordable, otherwise fall back to PCG. */
export function solveSPD(A: CSRMatrix, b: Float64Array, x: Float64Array, cache?: { chol?: BandedCholesky | null }): void {
  let chol = cache?.chol;
  if (chol === undefined) {
    const perm = reverseCuthillMcKee(A);
    const band = BandedCholesky.estimateBand(A, perm);
    chol = A.n * (band + 1) <= 12_000_000 ? new BandedCholesky(A, perm) : null;
    if (cache) cache.chol = chol;
  }
  if (chol) chol.solve(b, x);
  else pcgSolve(A, b, x, 1e-7, 8000);
}
