/**
 * Seam-line smoothing. Cuts follow mesh edges, which on regular meshes gives
 * staircase zig-zags. We simplify each seam chain (Douglas–Peucker at roughly
 * one edge length), keep genuine corners, and run a Catmull-Rom curve through
 * the remaining points. Both sides of a seam use the SAME kept indices and
 * the same curve construction, so their lengths and hole positions stay matched.
 */

type P = number[];

const sub = (a: P, b: P): P => a.map((v, i) => v - b[i]);
const len = (a: P): number => Math.sqrt(a.reduce((s, v) => s + v * v, 0));
const dot = (a: P, b: P): number => a.reduce((s, v, i) => s + v * b[i], 0);

function pointLineDistance(p: P, a: P, b: P): number {
  const ab = sub(b, a);
  const L2 = dot(ab, ab);
  if (L2 < 1e-18) return len(sub(p, a));
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / L2));
  const proj = a.map((v, i) => v + ab[i] * t);
  return len(sub(p, proj));
}

/** Douglas–Peucker: indices of the points to keep (endpoints always kept). */
export function simplifyIndices(pts: P[], tol: number): number[] {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let worst = -1, wd = tol;
    for (let k = i + 1; k < j; k++) {
      const d = pointLineDistance(pts[k], pts[i], pts[j]);
      if (d > wd) { wd = d; worst = k; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([i, worst], [worst, j]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** True where the polyline turns more than `angleDeg`; endpoints are always corners. */
export function cornerFlags(pts: P[], angleDeg: number): boolean[] {
  const n = pts.length;
  const flags = new Array<boolean>(n).fill(false);
  if (n === 0) return flags;
  flags[0] = true; flags[n - 1] = true;
  const cosLimit = Math.cos((angleDeg * Math.PI) / 180);
  for (let i = 1; i < n - 1; i++) {
    const a = sub(pts[i], pts[i - 1]), b = sub(pts[i + 1], pts[i]);
    const la = len(a), lb = len(b);
    if (la < 1e-12 || lb < 1e-12) continue;
    if (dot(a, b) / (la * lb) < cosLimit) flags[i] = true;
  }
  return flags;
}

/** Catmull-Rom through the points, broken (C0) at corners; `subdiv` samples per span. */
export function splineThrough(pts: P[], corners: boolean[], subdiv: number): P[] {
  const n = pts.length;
  if (n < 2) return pts.map((p) => p.slice());
  const out: P[] = [pts[0].slice()];
  let start = 0;
  for (let i = 1; i < n; i++) {
    if (!corners[i]) continue;
    // span start..i is one smooth run
    const seg = pts.slice(start, i + 1);
    if (seg.length === 2) out.push(seg[1].slice());
    else {
      for (let k = 0; k < seg.length - 1; k++) {
        const p0 = seg[Math.max(0, k - 1)], p1 = seg[k], p2 = seg[k + 1], p3 = seg[Math.min(seg.length - 1, k + 2)];
        for (let s = 1; s <= subdiv; s++) {
          const t = s / subdiv;
          const t2 = t * t, t3 = t2 * t;
          out.push(p1.map((_, d) => 0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)));
        }
      }
    }
    start = i;
  }
  return out;
}

export interface SmoothPlan {
  keep: number[];
  corners: boolean[];
  subdiv: number;
}

/** Decide once (on the shared 3D chain) which points survive and where the corners are. */
export function planSmoothing(chain: P[], cornerAngleDeg = 45, tolFactor = 0.75, subdiv = 4): SmoothPlan {
  const n = chain.length;
  if (n <= 2) return { keep: chain.map((_, i) => i), corners: chain.map(() => true), subdiv: 1 };
  const lens: number[] = [];
  for (let i = 1; i < n; i++) lens.push(len(sub(chain[i], chain[i - 1])));
  const sorted = lens.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1;
  const keep = simplifyIndices(chain, tolFactor * median);
  const corners = cornerFlags(keep.map((i) => chain[i]), cornerAngleDeg);
  return { keep, corners, subdiv };
}

/** Apply a plan to any polyline sampled at the same chain vertices (2D side or 3D chain). */
export function applySmoothing<T extends P>(pts: T[], plan: SmoothPlan): P[] {
  return splineThrough(plan.keep.map((i) => pts[i]), plan.corners, plan.subdiv);
}

export function polylineLength(pts: P[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += len(sub(pts[i], pts[i - 1]));
  return L;
}
