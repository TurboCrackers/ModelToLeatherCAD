/**
 * Seam-line smoothing. Cuts follow mesh edges, which on regular meshes gives
 * staircase zig-zags. For each seam chain we (1) find genuine corners by
 * measuring the turning angle over a window of several edge lengths, (2)
 * resample every corner-to-corner span at uniform arc length and (3) smooth
 * the samples with a Gaussian kernel, endpoints fixed. The plan (corner
 * indices, sample fractions, kernel) is decided once on the shared 3D chain
 * and applied identically to both 2D sides, so the sides stay matched.
 */

type P = number[];

const sub = (a: P, b: P): P => a.map((v, i) => v - b[i]);
const len = (a: P): number => Math.sqrt(a.reduce((s, v) => s + v * v, 0));
const dot = (a: P, b: P): number => a.reduce((s, v, i) => s + v * b[i], 0);
const lerp = (a: P, b: P, t: number): P => a.map((v, i) => v + (b[i] - v) * t);

function cumulative(pts: P[]): number[] {
  const arc = [0];
  for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + len(sub(pts[i], pts[i - 1])));
  return arc;
}

function pointAt(pts: P[], arc: number[], s: number): P {
  const L = arc[arc.length - 1];
  if (s <= 0) return pts[0].slice();
  if (s >= L) return pts[pts.length - 1].slice();
  let lo = 0, hi = arc.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arc[mid] <= s) lo = mid; else hi = mid; }
  const seg = arc[hi] - arc[lo];
  return lerp(pts[lo], pts[hi], seg > 0 ? (s - arc[lo]) / seg : 0);
}

function pointLineDistance(p: P, a: P, b: P): number {
  const ab = sub(b, a);
  const L2 = dot(ab, ab);
  if (L2 < 1e-18) return len(sub(p, a));
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / L2));
  return len(sub(p, a.map((v, i) => v + ab[i] * t)));
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

export interface SmoothPlan {
  /** chain indices that stay fixed: endpoints and genuine corners */
  corners: number[];
  /** per span between consecutive corners: arc fractions (0..1) of the uniform samples */
  fractions: number[][];
  /** number of Gaussian passes over each span's interior samples */
  passes: number;
}

/**
 * Decide the plan on the shared 3D chain. `window` (in edge lengths) is the
 * arc distance used to measure turning; a real corner turns sharply even over
 * several edges, a staircase does not.
 */
export function planSmoothing(chain: P[], cornerAngleDeg = 55, windowEdges = 3, passes = 2): SmoothPlan {
  const n = chain.length;
  if (n <= 2) return { corners: chain.map((_, i) => i), fractions: chain.length === 2 ? [[0, 1]] : [], passes: 0 };
  const arc = cumulative(chain);
  const L = arc[n - 1];
  const edges: number[] = [];
  for (let i = 1; i < n; i++) edges.push(arc[i] - arc[i - 1]);
  const sorted = edges.slice().sort((a, b) => a - b);
  const h = sorted[Math.floor(sorted.length / 2)] || L / (n - 1) || 1;
  const w = windowEdges * h;
  // corner candidates: DP-kept vertices; measure turning over ±w along the chain
  const cand = simplifyIndices(chain, h);
  const cosLimit = Math.cos((cornerAngleDeg * Math.PI) / 180);
  const corners: Array<{ i: number; sharp: number }> = [];
  for (const i of cand) {
    if (i === 0 || i === n - 1) continue;
    if (arc[i] < w * 0.6 || L - arc[i] < w * 0.6) continue;
    const a = pointAt(chain, arc, arc[i] - w), b = pointAt(chain, arc, arc[i] + w);
    const d1 = sub(chain[i], a), d2 = sub(b, chain[i]);
    const l1 = len(d1), l2 = len(d2);
    if (l1 < 1e-12 || l2 < 1e-12) continue;
    const c = dot(d1, d2) / (l1 * l2);
    if (c < cosLimit) corners.push({ i, sharp: -c });
  }
  // keep the sharpest of any corners closer than the window
  corners.sort((x, y) => y.sharp - x.sharp);
  const chosen: number[] = [];
  for (const c of corners) if (chosen.every((j) => Math.abs(arc[j] - arc[c.i]) > w)) chosen.push(c.i);
  chosen.push(0, n - 1);
  chosen.sort((a, b) => a - b);
  const fractions: number[][] = [];
  for (let k = 0; k < chosen.length - 1; k++) {
    const span = arc[chosen[k + 1]] - arc[chosen[k]];
    const m = Math.max(1, Math.round(span / h));
    const fr: number[] = [];
    for (let s = 0; s <= m; s++) fr.push(s / m);
    fractions.push(fr);
  }
  return { corners: chosen, fractions, passes };
}

/** Apply a plan to any polyline sampled at the same chain vertices (a 2D side or the 3D chain). */
export function applySmoothing<T extends P>(pts: T[], plan: SmoothPlan): P[] {
  if (pts.length < 2) return pts.map((p) => p.slice());
  const out: P[] = [];
  for (let k = 0; k < plan.corners.length - 1; k++) {
    const i0 = plan.corners[k], i1 = plan.corners[k + 1];
    const seg = pts.slice(i0, i1 + 1);
    const arc = cumulative(seg);
    const L = arc[arc.length - 1];
    let samples = plan.fractions[k].map((f) => pointAt(seg, arc, f * L));
    for (let pass = 0; pass < plan.passes; pass++) {
      const next = samples.map((p) => p.slice());
      for (let i = 1; i < samples.length - 1; i++) {
        const pm2 = samples[Math.max(0, i - 2)], pm1 = samples[i - 1], p0 = samples[i], pp1 = samples[i + 1], pp2 = samples[Math.min(samples.length - 1, i + 2)];
        next[i] = p0.map((_, d) => (pm2[d] + 4 * pm1[d] + 6 * p0[d] + 4 * pp1[d] + pp2[d]) / 16);
      }
      samples = next;
    }
    if (k > 0) samples = samples.slice(1);
    out.push(...samples);
  }
  return out;
}

export function polylineLength(pts: P[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += len(sub(pts[i], pts[i - 1]));
  return L;
}

/** Arc-length fractions (0..1) of each vertex of a polyline. */
export function arcFractions(pts: P[]): number[] {
  const arc = cumulative(pts);
  const L = arc[arc.length - 1] || 1;
  return arc.map((a) => a / L);
}

/** Point at a given arc fraction of a polyline. */
export function pointAtFraction(pts: P[], f: number): P {
  const arc = cumulative(pts);
  return pointAt(pts, arc, f * arc[arc.length - 1]);
}
