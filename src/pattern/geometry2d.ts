import { V2, sub2, add2, scale2, cross2, norm2, perp2, len2 } from '../geometry/vec';

export function signedArea(poly: V2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function polygonCentroid(poly: V2[]): V2 {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-12) {
    const s: V2 = [0, 0];
    for (const p of poly) { s[0] += p[0]; s[1] += p[1]; }
    return [s[0] / poly.length, s[1] / poly.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function bbox(pts: Iterable<V2>): { min: V2; max: V2; w: number; h: number } {
  const min: V2 = [Infinity, Infinity], max: V2 = [-Infinity, -Infinity];
  for (const p of pts) {
    if (p[0] < min[0]) min[0] = p[0]; if (p[0] > max[0]) max[0] = p[0];
    if (p[1] < min[1]) min[1] = p[1]; if (p[1] > max[1]) max[1] = p[1];
  }
  return { min, max, w: max[0] - min[0], h: max[1] - min[1] };
}

export function rotate2(p: V2, ang: number): V2 {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [c * p[0] - s * p[1], s * p[0] + c * p[1]];
}

/**
 * Offset a closed polygon (patch on the LEFT of travel) outward by a per-edge
 * distance, with mitred joins and bevels at sharp corners. Offsets of 0 leave
 * the edge in place.
 */
export function offsetPolygon(poly: V2[], offsets: number[]): V2[] {
  const n = poly.length;
  if (n < 3) return poly.slice();
  const segs: Array<{ a: V2; b: V2; d: V2 }> = [];
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const d = norm2(sub2(q, p));
    const outward = scale2(perp2(d), -1); // right-hand normal
    const o = offsets[i] ?? 0;
    segs.push({ a: add2(p, scale2(outward, o)), b: add2(q, scale2(outward, o)), d });
  }
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = segs[(i - 1 + n) % n];
    const cur = segs[i];
    const oPrev = offsets[(i - 1 + n) % n] ?? 0, oCur = offsets[i] ?? 0;
    if (oPrev === 0 && oCur === 0) { out.push(poly[i]); continue; }
    const cr = cross2(prev.d, cur.d);
    if (Math.abs(cr) < 1e-9) {
      if (len2(sub2(prev.b, cur.a)) > 1e-9) { out.push(prev.b); out.push(cur.a); } else out.push(cur.a);
      continue;
    }
    // intersection of line(prev.a, prev.d) and line(cur.a, cur.d)
    const w = sub2(cur.a, prev.a);
    const t = cross2(w, cur.d) / cr;
    const X = add2(prev.a, scale2(prev.d, t));
    const maxOff = Math.max(oPrev, oCur, 1e-6);
    if (len2(sub2(X, poly[i])) > 2.5 * maxOff + 1e-6) { out.push(prev.b); out.push(cur.a); }
    else out.push(X);
  }
  return out;
}

/** Point at arc-length position s along an open polyline. */
export function pointAtArc(pts: V2[], s: number): { p: V2; dir: V2 } {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const L = len2(sub2(pts[i + 1], pts[i]));
    if (s <= acc + L || i === pts.length - 2) {
      const f = L > 0 ? Math.min(1, Math.max(0, (s - acc) / L)) : 0;
      return { p: [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f], dir: norm2(sub2(pts[i + 1], pts[i])) };
    }
    acc += L;
  }
  return { p: pts[0], dir: [1, 0] };
}

const same = (p: V2, q: V2) => Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9;

/** Proper crossing test; segments that merely share an endpoint do not count. */
export function segmentsIntersect(a: V2, b: V2, c: V2, d: V2): boolean {
  if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false;
  const o = (p: V2, q: V2, r: V2) => {
    const v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    return Math.abs(v) < 1e-9 ? 0 : Math.sign(v);
  };
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

/** O(n²) self-intersection test for modest polygons. */
export function polygonSelfIntersects(poly: V2[]): boolean {
  const n = poly.length;
  if (n > 1500) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

function intersectionPoint(a: V2, b: V2, c: V2, d: V2): V2 | null {
  const r = sub2(b, a), s = sub2(d, c);
  const den = cross2(r, s);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross2(sub2(c, a), s) / den;
  const u = cross2(sub2(c, a), r) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return add2(a, scale2(r, t));
}

/**
 * Remove self-intersection loops from an offset polygon by repeatedly cutting
 * out the shorter sub-chain between two crossing segments. Turns bow-ties at
 * sharp tips and folded dart wedges into a clean outer envelope.
 */
export function removeSelfIntersections(poly: V2[], maxPasses = 200): V2[] {
  let pts = poly.slice();
  for (let pass = 0; pass < maxPasses; pass++) {
    const n = pts.length;
    if (n < 4 || n > 2500) return pts;
    let found = false;
    outer: for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const X = intersectionPoint(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]);
        if (!X) continue;
        // chain A: i+1 .. j ; chain B: j+1 .. i (wrapping)
        const lenA = j - i;
        const lenB = n - lenA;
        if (lenA <= lenB) {
          pts = [...pts.slice(0, i + 1), X, ...pts.slice(j + 1)];
        } else {
          pts = [X, ...pts.slice(i + 1, j + 1)];
        }
        found = true;
        break outer;
      }
    }
    if (!found) return pts;
  }
  return pts;
}
