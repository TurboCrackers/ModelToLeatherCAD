import { MeshTopology, CutMesh, otherFace } from '../geometry/mesh';
import { SegmentationResult, Patch, EDGE_FOLD } from '../geometry/segmentation';
import { LeatherSpec, SeamType } from '../leather/physics';
import { V2, V3, sub2, add2, scale2, perp2, norm2, len2, sub3, add3, scale3, norm3, dot3, lerp3 } from '../geometry/vec';
import { signedArea, polygonCentroid, offsetPolygon, polygonSelfIntersects, removeSelfIntersections } from './geometry2d';

export interface BoundaryEdge {
  cutEdge: number;
  origEdge: number;
  from: number; // cut vertex ids, travel order (patch on the left)
  to: number;
  face: number;
  /** patch across this edge, -1 for a raw mesh boundary */
  neighborPatch: number;
  seamId: number; // -1 if raw
}

export interface Loop {
  edges: BoundaryEdge[];
  isOuter: boolean;
}

export interface SeamSide {
  patchId: number;
  loopIndex: number;
  /** index of the first loop edge of this run and the number of edges (wraps around) */
  start: number;
  count: number;
}

export interface Seam {
  id: number;
  label: string;
  type: SeamType;
  isDart: boolean;
  origEdges: number[];
  /** developed 3D chain points in side-A travel order */
  chain3D: V3[];
  /** same chain on the displayed model surface */
  chainDisplay: V3[];
  arc: number[];
  length: number;
  sideA: SeamSide;
  sideB: SeamSide;
  /** arc-length positions of stitch holes */
  holeArc: number[];
  pitch: number;
  allowanceMm: number;
  insetMm: number;
}

export interface Hole {
  seamId: number;
  /** piece-local 2D */
  p: V2;
  /** 3D position on the displayed model surface */
  p3: V3;
}

export interface Piece {
  id: number;
  name: string;
  patch: Patch;
  /** piece-local 2D coordinates per cut vertex (index = flat local index) */
  uv: Float64Array;
  loops: Loop[];
  /** stitch-line outline polygons (index 0 outer) in piece-local coords */
  outlines: V2[][];
  /** cut outlines after seam allowance */
  cutOutlines: V2[][];
  holes: Hole[];
  foldLines: Array<[V2, V2]>;
  seamLabels: Array<{ seamId: number; p: V2; text: string }>;
  notches: Array<[V2, V2]>;
  areaMm2: number;
  centroid: V2;
  overStrained: boolean;
  tightBend: boolean;
  maxStrain: number;
  /** placement in the layout sheet */
  layout: { angle: number; tx: number; ty: number };
}

export interface PatternOptions {
  defaultSeamType: SeamType;
  seamTypeOverrides: Map<string, SeamType>;
  /** allowance added to raw (unsewn) edges, e.g. for hems. */
  rawEdgeAllowanceMm: number;
}

export interface PatternSet {
  pieces: Piece[];
  seams: Seam[];
  spec: LeatherSpec;
  warnings: string[];
  sheet: { w: number; h: number };
  totalAreaMm2: number;
}

function pieceName(i: number): string {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

/** Seam identity key from the sorted original edge ids: stable across recomputes for overrides. */
export function seamKey(origEdges: number[]): string {
  const s = origEdges.slice().sort((a, b) => a - b);
  return `${s[0]}-${s[s.length - 1]}-${s.length}`;
}

function extractLoops(ct: MeshTopology, faces: Int32Array, cut: CutMesh, faceToPatch: Int32Array): Loop[] {
  const idx = ct.mesh.indices;
  const inSet = new Uint8Array(ct.mesh.nf);
  for (const f of faces) inSet[f] = 1;
  // key: face*3+k for boundary half-edges
  const pending = new Set<number>();
  for (const f of faces) for (let k = 0; k < 3; k++) {
    const e = ct.faceEdges[3 * f + k];
    if (otherFace(ct, e, f) < 0) pending.add(3 * f + k);
  }
  const loops: Loop[] = [];
  const makeEdge = (f: number, k: number): BoundaryEdge => {
    const e = ct.faceEdges[3 * f + k];
    const oe = cut.origEdge[e];
    const partners = cut.cutEdgesOfOrig[oe];
    let neighbor = -1;
    for (const pe of partners) if (pe !== e) neighbor = faceToPatch[ct.edgeFaces[2 * pe]];
    return { cutEdge: e, origEdge: oe, from: idx[3 * f + k], to: idx[3 * f + ((k + 1) % 3)], face: f, neighborPatch: neighbor, seamId: -1 };
  };
  while (pending.size) {
    const startKey = pending.values().next().value as number;
    const edges: BoundaryEdge[] = [];
    let key = startKey;
    let guard = 0;
    do {
      pending.delete(key);
      const f = Math.floor(key / 3), k = key % 3;
      edges.push(makeEdge(f, k));
      // rotate around vertex b = corner k+1 of f to find the next boundary half-edge
      const b = idx[3 * f + ((k + 1) % 3)];
      let cf = f;
      let found = -1;
      for (let it = 0; it < 10000; it++) {
        let kb = 0;
        for (; kb < 3; kb++) if (idx[3 * cf + kb] === b) break;
        const e = ct.faceEdges[3 * cf + kb]; // edge (b -> next) in face cf
        const g = otherFace(ct, e, cf);
        if (g < 0) { found = 3 * cf + kb; break; }
        cf = g;
      }
      if (found < 0) break;
      key = found;
    } while (key !== startKey && guard++ < 1e6);
    loops.push({ edges, isOuter: false });
  }
  return loops;
}

export function buildPattern(topo: MeshTopology, seg: SegmentationResult, developed: Float64Array, display: Float64Array, spec: LeatherSpec, opts: PatternOptions): PatternSet {
  const warnings: string[] = [];
  const { cut, patches, faceToPatch } = seg;
  const ct = cut.topo;

  // ---- pieces: loops + local 2D
  const pieces: Piece[] = patches.map((patch, i) => {
    const uv = Float64Array.from(patch.flat.uv);
    const loops = extractLoops(ct, patch.faces, cut, faceToPatch);
    const li = patch.flat.localIndex;
    const poly = (loop: Loop): V2[] => loop.edges.map((e) => { const l = li.get(e.from)!; return [uv[2 * l], uv[2 * l + 1]] as V2; });
    // orientation: outer loop must be CCW (grain side up)
    let outerIdx = 0, best = -1;
    loops.forEach((lp, j) => { const a = Math.abs(signedArea(poly(lp))); if (a > best) { best = a; outerIdx = j; } });
    if (loops.length && signedArea(poly(loops[outerIdx])) < 0) for (let k = 0; k < uv.length; k += 2) uv[k] = -uv[k];
    loops.forEach((lp, j) => (lp.isOuter = j === outerIdx));
    // centre
    let cx = 0, cy = 0;
    const nv = uv.length / 2;
    for (let k = 0; k < nv; k++) { cx += uv[2 * k]; cy += uv[2 * k + 1]; }
    cx /= nv || 1; cy /= nv || 1;
    for (let k = 0; k < nv; k++) { uv[2 * k] -= cx; uv[2 * k + 1] -= cy; }
    const outlines = loops.map(poly);
    const areaMm2 = outlines.length ? Math.abs(signedArea(outlines[outerIdx])) - outlines.filter((_, j) => j !== outerIdx).reduce((s, o) => s + Math.abs(signedArea(o)), 0) : 0;
    return {
      id: i, name: pieceName(i), patch, uv, loops, outlines, cutOutlines: [], holes: [], foldLines: [], seamLabels: [], notches: [],
      areaMm2, centroid: outlines.length ? polygonCentroid(outlines[outerIdx]) : [0, 0], overStrained: patch.overStrained, tightBend: patch.tightBend,
      maxStrain: patch.flat.maxStrain, layout: { angle: 0, tx: 0, ty: 0 },
    };
  });

  // ---- seam pairing by original edge occurrences
  const occ = new Map<number, Array<{ piece: number; loop: number; index: number }>>();
  pieces.forEach((pc, pi) => pc.loops.forEach((lp, lj) => lp.edges.forEach((e, k) => {
    let arr = occ.get(e.origEdge);
    if (!arr) occ.set(e.origEdge, (arr = []));
    arr.push({ piece: pi, loop: lj, index: k });
  })));
  const seams: Seam[] = [];
  const assigned = new Set<number>();
  const partnerOf = (pi: number, lj: number, k: number) => {
    const e = pieces[pi].loops[lj].edges[k];
    const arr = occ.get(e.origEdge) ?? [];
    return arr.find((o) => !(o.piece === pi && o.loop === lj && o.index === k)) ?? null;
  };
  pieces.forEach((pc, pi) => pc.loops.forEach((lp, lj) => {
    const n = lp.edges.length;
    for (let k = 0; k < n; k++) {
      const e = lp.edges[k];
      if (e.neighborPatch < 0 || assigned.has(e.origEdge)) continue;
      const p0 = partnerOf(pi, lj, k);
      if (!p0) continue;
      // walk backwards to the run start
      let start = k;
      let guard = 0;
      while (guard++ < n) {
        const prevIdx = (start - 1 + n) % n;
        const pe = lp.edges[prevIdx];
        if (pe.neighborPatch < 0 || assigned.has(pe.origEdge) || prevIdx === k) break;
        const pp = partnerOf(pi, lj, prevIdx);
        const cp = partnerOf(pi, lj, start);
        if (!pp || !cp || pp.piece !== cp.piece || pp.loop !== cp.loop) break;
        const m = pieces[pp.piece].loops[pp.loop].edges.length;
        if (pp.index !== (cp.index + 1) % m) break;
        start = prevIdx;
      }
      // walk forwards to collect the run
      const run: number[] = [start];
      guard = 0;
      while (guard++ < n) {
        const cur = run[run.length - 1];
        const nextIdx = (cur + 1) % n;
        if (nextIdx === start) break;
        const ne = lp.edges[nextIdx];
        if (ne.neighborPatch < 0 || assigned.has(ne.origEdge)) break;
        const cp = partnerOf(pi, lj, cur), np = partnerOf(pi, lj, nextIdx);
        if (!cp || !np || cp.piece !== np.piece || cp.loop !== np.loop) break;
        const m = pieces[np.piece].loops[np.loop].edges.length;
        if (np.index !== (cp.index - 1 + m) % m) break;
        run.push(nextIdx);
      }
      const first = partnerOf(pi, lj, run[0])!;
      const last = partnerOf(pi, lj, run[run.length - 1])!;
      const origEdges = run.map((r) => lp.edges[r].origEdge);
      for (const oe of origEdges) assigned.add(oe);
      const id = seams.length;
      const sideA: SeamSide = { patchId: pi, loopIndex: lj, start: run[0], count: run.length };
      const sideB: SeamSide = { patchId: first.piece, loopIndex: first.loop, start: last.index, count: run.length };
      const key = seamKey(origEdges);
      const type = opts.seamTypeOverrides.get(key) ?? opts.defaultSeamType;
      // 3D chain along side A
      const chain3D: V3[] = [];
      const chainDisplay: V3[] = [];
      const pushV = (cv: number) => {
        const ov = cut.origVertex[cv];
        chain3D.push([developed[3 * ov], developed[3 * ov + 1], developed[3 * ov + 2]]);
        chainDisplay.push([display[3 * ov], display[3 * ov + 1], display[3 * ov + 2]]);
      };
      pushV(lp.edges[run[0]].from);
      for (const r of run) pushV(lp.edges[r].to);
      const arc = [0];
      for (let i = 1; i < chain3D.length; i++) arc.push(arc[i - 1] + Math.hypot(...sub3(chain3D[i], chain3D[i - 1])));
      const length = arc[arc.length - 1];
      const pitch = spec.stitchPitchMm;
      const endMargin = Math.min(pitch, Math.max(pitch * 0.5, spec.edgeMarginMm * 0.8));
      const usable = Math.max(0, length - 2 * endMargin);
      let count = Math.floor(usable / pitch + 1e-6) + 1;
      if (length < 2 * spec.holeDiameterMm * 1.5) count = 0;
      const holeArc: number[] = [];
      if (count > 0) {
        const span = (count - 1) * pitch;
        const s0 = (length - span) / 2;
        for (let i = 0; i < count; i++) holeArc.push(s0 + i * pitch);
      }
      const seam: Seam = {
        id, label: `${id + 1}`, type, isDart: first.piece === pi, origEdges, chain3D, chainDisplay, arc, length, sideA, sideB, holeArc, pitch,
        allowanceMm: type === 'turned' ? spec.seamAllowanceMm : 0,
        insetMm: type === 'turned' ? 0 : spec.edgeMarginMm,
      };
      seams.push(seam);
      for (const r of run) lp.edges[r].seamId = id;
      const bl = pieces[first.piece].loops[first.loop];
      for (let i = 0; i < run.length; i++) bl.edges[(last.index + i) % bl.edges.length].seamId = id;
    }
  }));

  // ---- per piece: holes, allowance outline, folds, labels
  const holeRadius = spec.holeDiameterMm / 2;
  for (const pc of pieces) {
    const li = pc.patch.flat.localIndex;
    const P = (cv: number): V2 => { const l = li.get(cv)!; return [pc.uv[2 * l], pc.uv[2 * l + 1]]; };
    pc.cutOutlines = pc.loops.map((lp) => {
      const poly = lp.edges.map((e) => P(e.from));
      const offs = lp.edges.map((e) => {
        if (e.seamId < 0) return opts.rawEdgeAllowanceMm;
        return seams[e.seamId].allowanceMm;
      });
      const off = offsetPolygon(poly, offs);
      return offs.some((o) => o > 0) ? removeSelfIntersections(off) : off;
    });
    if (pc.cutOutlines.length && polygonSelfIntersects(pc.cutOutlines[pc.loops.findIndex((l) => l.isOuter)] ?? []))
      warnings.push(`Piece ${pc.name}: cut outline self-intersects (check seam allowance vs. shape).`);
    // folds
    const seen = new Set<number>();
    for (const f of pc.patch.faces) for (let k = 0; k < 3; k++) {
      const ce = ct.faceEdges[3 * f + k];
      if (seen.has(ce)) continue;
      seen.add(ce);
      if (otherFace(ct, ce, f) < 0) continue;
      if (seg.edgeClass[cut.origEdge[ce]] !== EDGE_FOLD) continue;
      pc.foldLines.push([P(ct.edgeVerts[2 * ce]), P(ct.edgeVerts[2 * ce + 1])]);
    }
  }
  for (const seam of seams) {
    for (const side of [seam.sideA, seam.sideB]) {
      const pc = pieces[side.patchId];
      const lp = pc.loops[side.loopIndex];
      const n = lp.edges.length;
      const li = pc.patch.flat.localIndex;
      const P = (cv: number): V2 => { const l = li.get(cv)!; return [pc.uv[2 * l], pc.uv[2 * l + 1]]; };
      // side-A travel order polyline and matching 3D arc per edge
      const isA = side === seam.sideA;
      const runEdges: BoundaryEdge[] = [];
      for (let i = 0; i < side.count; i++) runEdges.push(lp.edges[(side.start + i) % n]);
      // For side B the loop runs opposite to the chain; build the 2D polyline in chain order.
      const pts2: V2[] = [];
      const inward: V2[] = [];
      if (isA) {
        pts2.push(P(runEdges[0].from));
        for (const e of runEdges) pts2.push(P(e.to));
      } else {
        const rev = runEdges.slice().reverse();
        pts2.push(P(rev[0].to));
        for (const e of rev) pts2.push(P(e.from));
      }
      // inward normal per chain segment: left of travel in this piece's own loop direction
      for (let i = 0; i < pts2.length - 1; i++) {
        const d = norm2(sub2(pts2[i + 1], pts2[i]));
        const left = perp2(d);
        inward.push(isA ? left : scale2(left, -1));
      }
      const placeAt = (s: number): { p: V2; i: number; f: number } => {
        let i = 0;
        while (i < seam.arc.length - 2 && s > seam.arc[i + 1]) i++;
        const segLen = seam.arc[i + 1] - seam.arc[i];
        const f = segLen > 0 ? Math.min(1, Math.max(0, (s - seam.arc[i]) / segLen)) : 0;
        const p: V2 = [pts2[i][0] + (pts2[i + 1][0] - pts2[i][0]) * f, pts2[i][1] + (pts2[i + 1][1] - pts2[i][1]) * f];
        return { p, i, f };
      };
      const faceInward3 = (edgeIdx: number): V3 => {
        const e = isA ? runEdges[edgeIdx] : runEdges[runEdges.length - 1 - edgeIdx];
        const f = e.face;
        const a = seam.chainDisplay[edgeIdx], b = seam.chainDisplay[edgeIdx + 1];
        const dir = norm3(sub3(b, a));
        const c: V3 = [ct.faceCentroids[3 * f], ct.faceCentroids[3 * f + 1], ct.faceCentroids[3 * f + 2]];
        // centroid of the developed face: use the original developed positions via cut vertices
        const cv = [ct.mesh.indices[3 * f], ct.mesh.indices[3 * f + 1], ct.mesh.indices[3 * f + 2]].map((v) => cut.origVertex[v]);
        const cd: V3 = [0, 0, 0];
        for (const ov of cv) { cd[0] += display[3 * ov] / 3; cd[1] += display[3 * ov + 1] / 3; cd[2] += display[3 * ov + 2] / 3; }
        void c;
        const mid = lerp3(a, b, 0.5);
        let w = sub3(cd, mid);
        w = sub3(w, scale3(dir, dot3(w, dir)));
        return norm3(w);
      };
      for (const s of seam.holeArc) {
        const { p, i, f } = placeAt(s);
        const p2 = add2(p, scale2(inward[i], seam.insetMm));
        const p3base = lerp3(seam.chainDisplay[i], seam.chainDisplay[i + 1], f);
        const p3 = add3(p3base, scale3(faceInward3(i), seam.insetMm));
        pc.holes.push({ seamId: seam.id, p: p2, p3 });
      }
      // label at mid-run, pushed inside
      const mid = placeAt(seam.length / 2);
      const labelP = add2(mid.p, scale2(inward[mid.i], seam.insetMm + Math.max(4, spec.edgeMarginMm + 2)));
      pc.seamLabels.push({ seamId: seam.id, p: labelP, text: seam.isDart ? `D${seam.label}` : seam.label });
      // notches at both ends, drawn outward across the cut line
      const notchLen = seam.allowanceMm + 3;
      for (const s of [0, seam.length]) {
        const { p, i } = placeAt(s);
        const out = scale2(inward[i], -1);
        pc.notches.push([p, add2(p, scale2(out, notchLen))]);
      }
    }
  }
  void holeRadius; void len2;

  const totalAreaMm2 = pieces.reduce((s, p) => s + p.areaMm2, 0);
  return { pieces, seams, spec, warnings, sheet: { w: 0, h: 0 }, totalAreaMm2 };
}
