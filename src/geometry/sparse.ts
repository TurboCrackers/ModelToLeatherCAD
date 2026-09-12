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
