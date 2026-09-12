import { MeshTopology, CutMesh, otherFace } from '../geometry/mesh';
import { SegmentationResult, Patch, EDGE_FOLD } from '../geometry/segmentation';
import { LeatherSpec, SeamType } from '../leather/physics';
import { V2, V3, add2, scale2, perp2, len2, sub3, add3, scale3, norm3 } from '../geometry/vec';
import { signedArea, polygonCentroid, offsetPolygon, polygonSelfIntersects, removeSelfIntersections, pointAtArc } from './geometry2d';
import { planSmoothing, applySmoothing, SmoothPlan, polylineLength, arcFractions, pointAtFraction } from './smooth';

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
  /** slit sewn to itself (both runs meet at a tip) */
  isDart: boolean;
  /** joins two ends of the same piece (a band closed into a ring) */
  isClosure: boolean;
  origEdges: number[];
  /** developed 3D chain points in side-A travel order */
  chain3D: V3[];
  /** same chain on the displayed model surface */
  chainDisplay: V3[];
  /** smoothing decided on the shared chain and applied identically to both sides */
  plan: SmoothPlan;
  /** smoothed display-surface curve (assembled state) */
  smoothDisplay: V3[];
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

export interface PieceRun {
  seamId: number; // -1 for a raw edge
  /** piece-local 2D points, loop travel order */
  pts2: V2[];
  /** matching points on the displayed 3D surface */
  pts3: V3[];
}

export interface Hole {
  seamId: number;
  /** index along the seam's full hole list (stable id for deletions) */
  index: number;
  side: 'A' | 'B';
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
  /** smoothed boundary runs in loop order: the drawn seam / raw-edge curves */
  runs: PieceRun[];
  /** boundary cut-vertices snapped onto the smooth curves (display 3D), for the viewer */
  boundaryDisplay: Map<number, V3>;
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
  /** smooth the zig-zag mesh-edge seams into curves with corners where needed */
  smoothCutLines: boolean;
  /** holes removed by the user, as `${seamKey}:${index}` */
  deletedHoles?: Set<string>;
}

export interface PatternSet {
  pieces: Piece[];
  seams: Seam[];
  spec: LeatherSpec;
  warnings: string[];
  sheet: { w: number; h: number };
  totalAreaMm2: number;
}

function identityPlan(n: number): SmoothPlan {
  const corners = Array.from({ length: n }, (_, i) => i);
  return { corners, fractions: Array.from({ length: Math.max(0, n - 1) }, () => [0, 1]), passes: 0 };
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
      id: i, name: pieceName(i), patch, uv, loops, outlines, cutOutlines: [], runs: [], boundaryDisplay: new Map(), holes: [], foldLines: [], seamLabels: [], notches: [],
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
      // walk backwards to the run start (never across a dart tip: the same original edge twice)
      let start = k;
      let guard = 0;
      const inRun = new Set<number>([e.origEdge]);
      while (guard++ < n) {
        const prevIdx = (start - 1 + n) % n;
        const pe = lp.edges[prevIdx];
        if (pe.neighborPatch < 0 || assigned.has(pe.origEdge) || prevIdx === k || inRun.has(pe.origEdge)) break;
        const pp = partnerOf(pi, lj, prevIdx);
        const cp = partnerOf(pi, lj, start);
        if (!pp || !cp || pp.piece !== cp.piece || pp.loop !== cp.loop) break;
        const m = pieces[pp.piece].loops[pp.loop].edges.length;
        if (pp.index !== (cp.index + 1) % m) break;
        start = prevIdx;
        inRun.add(pe.origEdge);
      }
      // the run so far: start .. k (in loop order); then walk forwards from k
      const run: number[] = [];
      for (let i = start; ; i = (i + 1) % n) { run.push(i); if (i === k) break; }
      guard = 0;
      while (guard++ < n) {
        const cur = run[run.length - 1];
        const nextIdx = (cur + 1) % n;
        if (nextIdx === start) break;
        const ne = lp.edges[nextIdx];
        if (ne.neighborPatch < 0 || assigned.has(ne.origEdge) || inRun.has(ne.origEdge)) break;
        const cp = partnerOf(pi, lj, cur), np = partnerOf(pi, lj, nextIdx);
        if (!cp || !np || cp.piece !== np.piece || cp.loop !== np.loop) break;
        const m = pieces[np.piece].loops[np.loop].edges.length;
        if (np.index !== (cp.index - 1 + m) % m) break;
        run.push(nextIdx);
        inRun.add(ne.origEdge);
      }
      const first = partnerOf(pi, lj, run[0])!;
      const last = partnerOf(pi, lj, run[run.length - 1])!;
      const origEdges = run.map((r) => lp.edges[r].origEdge);
      for (const oe of origEdges) assigned.add(oe);
      const id = seams.length;
      const sideA: SeamSide = { patchId: pi, loopIndex: lj, start: run[0], count: run.length };
      const sideB: SeamSide = { patchId: first.piece, loopIndex: first.loop, start: last.index, count: run.length };
      // same piece on both sides: a dart (slit with a tip, the two runs meet in the loop) or a closure
      // seam joining two ends of the piece (e.g. a band wrapped into a ring)
      const samePiece = first.piece === pi && first.loop === lj;
      const runEnd = run[run.length - 1];
      const adjacentRuns = samePiece && (sideB.start === (runEnd + 1) % n || (sideB.start + run.length) % n === run[0]);
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
      const plan: SmoothPlan = opts.smoothCutLines ? planSmoothing(chain3D) : identityPlan(chain3D.length);
      const smooth3D = applySmoothing(chain3D, plan) as V3[];
      const smoothDisplay = applySmoothing(chainDisplay, plan) as V3[];
      const arc = [0];
      for (let i = 1; i < smooth3D.length; i++) arc.push(arc[i - 1] + Math.hypot(...sub3(smooth3D[i], smooth3D[i - 1])));
      const length = arc[arc.length - 1];
      const pitch = spec.stitchPitchMm;
      const holeArc: number[] = []; // filled in once the corner geometry of both sides is known
      const seam: Seam = {
        id, label: `${id + 1}`, type, isDart: adjacentRuns, isClosure: samePiece && !adjacentRuns, origEdges, chain3D, chainDisplay, plan, smoothDisplay, arc, length, sideA, sideB, holeArc, pitch,
        allowanceMm: type === 'turned' ? spec.seamAllowanceMm : 0,
        insetMm: type === 'turned' ? 0 : spec.edgeMarginMm,
      };
      seams.push(seam);
      for (const r of run) lp.edges[r].seamId = id;
      const bl = pieces[first.piece].loops[first.loop];
      for (let i = 0; i < run.length; i++) bl.edges[(last.index + i) % bl.edges.length].seamId = id;
    }
  }));

  // Display-only lift so smoothed curves and hole markers sit just outside the surface
  // (a smooth curve through surface points is a chord and would be hidden by the mesh).
  let dmin = [Infinity, Infinity, Infinity], dmax = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < topo.mesh.nv; v++) for (let k = 0; k < 3; k++) { dmin[k] = Math.min(dmin[k], display[3 * v + k]); dmax[k] = Math.max(dmax[k], display[3 * v + k]); }
  const modelSize = Math.max(dmax[0] - dmin[0], dmax[1] - dmin[1], dmax[2] - dmin[2]) || 1;
  const liftLine = 0.004 * modelSize, liftHole = 0.007 * modelSize;
  const N3 = (cv: number): V3 => { const ov = cut.origVertex[cv]; return [topo.vertexNormals[3 * ov], topo.vertexNormals[3 * ov + 1], topo.vertexNormals[3 * ov + 2]]; };
  const liftAlong = (pts: V3[], normals: V3[], amount: number): V3[] => pts.map((q, i) => { const n = norm3(normals[Math.min(i, normals.length - 1)]); return add3(q, scale3(n, amount)); });

  interface LoopRun { key: string; idx: number[]; pts2?: V2[]; seamId?: number }
  interface SideRun { seamId: number; piece: number; isA: boolean; s2: V2[]; runIdxInLoop: number; loopRuns: LoopRun[] }
  const sideRuns: SideRun[] = [];

  // ---- per piece: smoothed runs → outlines, allowance, folds, labels (holes follow below)
  for (const pc of pieces) {
    const li = pc.patch.flat.localIndex;
    const P = (cv: number): V2 => { const l = li.get(cv)!; return [pc.uv[2 * l], pc.uv[2 * l + 1]]; };
    const D = (cv: number): V3 => { const ov = cut.origVertex[cv]; return [display[3 * ov], display[3 * ov + 1], display[3 * ov + 2]]; };
    const newOutlines: V2[][] = [];
    const newCut: V2[][] = [];
    const uvSnap = new Map<number, V2>();
    pc.loops.forEach((lp) => {
      const n = lp.edges.length;
      // split the loop into runs: consecutive edges of the same seam side, or raw edges
      const sideOf = (k: number): string => {
        const e = lp.edges[k];
        if (e.seamId < 0) return 'raw';
        const sm = seams[e.seamId];
        const inA = (side: SeamSide) => side.patchId === pc.id && side.loopIndex === pc.loops.indexOf(lp) && ((k - side.start + n) % n) < side.count;
        return `${e.seamId}:${inA(sm.sideA) ? 'A' : 'B'}`;
      };
      // start at a run boundary
      let start = 0;
      for (let k = 0; k < n; k++) if (sideOf(k) !== sideOf((k - 1 + n) % n)) { start = k; break; }
      const runs: LoopRun[] = [];
      for (let c = 0; c < n; c++) {
        const k = (start + c) % n;
        const key = sideOf(k);
        if (runs.length && runs[runs.length - 1].key === key) runs[runs.length - 1].idx.push(k);
        else runs.push({ key, idx: [k] });
      }
      const outline: V2[] = [];
      const offs: number[] = [];
      for (const run of runs) {
        const edges = run.idx.map((k) => lp.edges[k]);
        const seamId = edges[0].seamId;
        let pts2: V2[], pts3: V3[];
        if (seamId >= 0) {
          const sm = seams[seamId];
          const isA = run.key.endsWith('A');
          // chain-order 2D points, then the shared plan
          const chainEdges = isA ? edges : edges.slice().reverse();
          const c2: V2[] = [P(isA ? chainEdges[0].from : chainEdges[0].to)];
          for (const e of chainEdges) c2.push(P(isA ? e.to : e.from));
          const s2 = applySmoothing(c2, sm.plan) as V2[];
          const s3 = sm.smoothDisplay;
          const cN: V3[] = [N3(isA ? chainEdges[0].from : chainEdges[0].to)];
          for (const e of chainEdges) cN.push(N3(isA ? e.to : e.from));
          const sN = applySmoothing(cN, sm.plan) as V3[];
          const s3l = liftAlong(s3, sN, liftLine);
          pts2 = isA ? s2 : s2.slice().reverse();
          pts3 = isA ? s3l : s3l.slice().reverse();
          // remember this side for hole placement once every seam's corner geometry is known
          sideRuns.push({ seamId, piece: pc.id, isA, s2, runIdxInLoop: runs.indexOf(run), loopRuns: runs });
          const L2 = polylineLength(s2);
          // label and notches
          const mid = pointAtArc(s2, L2 / 2);
          const midInward = isA ? perp2(mid.dir) : scale2(perp2(mid.dir), -1);
          pc.seamLabels.push({ seamId, p: add2(mid.p, scale2(midInward, sm.insetMm + Math.max(4, spec.edgeMarginMm + 2))), text: sm.isDart ? `D${sm.label}` : sm.isClosure ? `J${sm.label}` : sm.label });
          const notchLen = sm.allowanceMm + 3;
          for (const q of [pointAtArc(s2, 0), pointAtArc(s2, L2)]) {
            const out = isA ? scale2(perp2(q.dir), -1) : perp2(q.dir);
            pc.notches.push([q.p, add2(q.p, scale2(out, notchLen))]);
          }
        } else {
          const c2: V2[] = [P(edges[0].from)];
          const c3: V3[] = [D(edges[0].from)];
          for (const e of edges) { c2.push(P(e.to)); c3.push(D(e.to)); }
          const plan = opts.smoothCutLines ? planSmoothing(c3) : identityPlan(c3.length);
          const cN: V3[] = [N3(edges[0].from)];
          for (const e of edges) cN.push(N3(e.to));
          pts2 = applySmoothing(c2, plan) as V2[];
          pts3 = liftAlong(applySmoothing(c3, plan) as V3[], applySmoothing(cN, plan) as V3[], liftLine);
        }
        pc.runs.push({ seamId, pts2, pts3 });
        run.pts2 = pts2; run.seamId = seamId;
        // snap the mesh boundary vertices of this run onto the smooth curves (loop order); the
        // display curve is lifted slightly off the surface, so pull the snapped vertices back down
        {
          const verts: number[] = [edges[0].from];
          for (const e of edges) verts.push(e.to);
          const raw2 = verts.map((cv) => P(cv));
          const fr = arcFractions(raw2);
          verts.forEach((cv, j) => {
            const q2 = pointAtFraction(pts2, fr[j]) as V2;
            const q3 = pointAtFraction(pts3, fr[j]) as V3;
            uvSnap.set(cv, q2);
            pc.boundaryDisplay.set(cv, add3(q3, scale3(norm3(N3(cv)), -liftLine)));
          });
        }
        const allowance = seamId >= 0 ? seams[seamId].allowanceMm : opts.rawEdgeAllowanceMm;
        for (let i = 0; i < pts2.length - 1; i++) { outline.push(pts2[i]); offs.push(allowance); }
      }
      newOutlines.push(outline);
      const off = offsetPolygon(outline, offs);
      newCut.push(offs.some((o) => o > 0) ? removeSelfIntersections(off) : off);
    });
    pc.outlines = newOutlines;
    pc.cutOutlines = newCut;
    if (opts.smoothCutLines) for (const [cv, q] of uvSnap) { const l = li.get(cv)!; pc.uv[2 * l] = q[0]; pc.uv[2 * l + 1] = q[1]; }
    const outerIdx = pc.loops.findIndex((l) => l.isOuter);
    if (outerIdx >= 0 && newOutlines[outerIdx]) {
      pc.areaMm2 = Math.abs(signedArea(newOutlines[outerIdx])) - newOutlines.filter((_, j) => j !== outerIdx).reduce((a, o) => a + Math.abs(signedArea(o)), 0);
      pc.centroid = polygonCentroid(newOutlines[outerIdx]);
      if (polygonSelfIntersects(newCut[outerIdx] ?? [])) warnings.push(`Piece ${pc.name}: cut outline self-intersects (check seam allowance vs. shape).`);
    }
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
  void len2;

  // ---- stitch holes: one arc-length list per seam, shared by both sides.
  // Hand-stitching practice: rows keep a nominal pitch and stop short of corners. Where a seam
  // meets another seam at a corner the last hole sits one pitch plus the edge margin from the
  // corner (the corner itself is left clear); at a raw edge half a pitch plus the margin.
  const cornerMargin = (sr: SideRun, atRunStart: boolean): number => {
    const seam = seams[sr.seamId];
    const inset = seam.insetMm;
    const runs = sr.loopRuns;
    const n = runs.length;
    const me = runs[sr.runIdxInLoop];
    const other = runs[(sr.runIdxInLoop + (atRunStart ? -1 : 1) + n) % n];
    const rawEnd = Math.max(seam.pitch * 0.6, inset + seam.pitch * 0.5);
    if (!me.pts2 || !other.pts2 || other.seamId === undefined || other.seamId < 0 || other === me) return rawEnd;
    const a = atRunStart ? other.pts2 : me.pts2, b = atRunStart ? me.pts2 : other.pts2;
    if (a.length < 2 || b.length < 2) return rawEnd;
    const d1: V2 = [a[a.length - 1][0] - a[a.length - 2][0], a[a.length - 1][1] - a[a.length - 2][1]];
    const d2: V2 = [b[1][0] - b[0][0], b[1][1] - b[0][1]];
    const turn = Math.abs(Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]));
    if (turn < 0.35) return rawEnd; // straight continuation into the next seam: no corner
    return Math.max(inset, seams[other.seamId].insetMm) + seam.pitch;
  };
  for (const seam of seams) {
    const sides = sideRuns.filter((sr) => sr.seamId === seam.id);
    let mStart = 0, mEnd = 0;
    for (const sr of sides) {
      const startM = cornerMargin(sr, true), endM = cornerMargin(sr, false);
      // side B runs opposite to the chain, so its run start is the seam's end
      if (sr.isA) { mStart = Math.max(mStart, startM); mEnd = Math.max(mEnd, endM); }
      else { mStart = Math.max(mStart, endM); mEnd = Math.max(mEnd, startM); }
    }
    if (!sides.length) mStart = mEnd = Math.max(seam.pitch * 0.6, seam.insetMm + seam.pitch * 0.5);
    const L = seam.length;
    seam.holeArc.length = 0;
    // interior corners of the seam (where it turns sharply, e.g. around a box edge) also
    // interrupt the row: stop one pitch plus the margin on either side of the corner
    const sm3 = seam.smoothDisplay;
    const cornerArcs: number[] = [];
    {
      let acc = 0;
      const arcs: number[] = [0];
      for (let j = 1; j < sm3.length; j++) { acc += Math.hypot(...sub3(sm3[j], sm3[j - 1])); arcs.push(acc); }
      const scaleArc = acc > 0 ? L / acc : 1;
      for (let j = 1; j < sm3.length - 1; j++) {
        const d1 = sub3(sm3[j], sm3[j - 1]), d2 = sub3(sm3[j + 1], sm3[j]);
        const l1 = Math.hypot(...d1), l2 = Math.hypot(...d2);
        if (l1 < 1e-9 || l2 < 1e-9) continue;
        const cosT = (d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) / (l1 * l2);
        if (cosT < Math.cos((35 * Math.PI) / 180)) {
          const a = arcs[j] * scaleArc;
          if (!cornerArcs.length || a - cornerArcs[cornerArcs.length - 1] > seam.pitch) cornerArcs.push(a);
        }
      }
    }
    const cornerGap = seam.insetMm + seam.pitch;
    const bounds = [0, ...cornerArcs, L];
    if (L >= 3 * spec.holeDiameterMm) {
      for (let g = 0; g < bounds.length - 1; g++) {
        const from = bounds[g] + (g === 0 ? mStart : cornerGap);
        const to = bounds[g + 1] - (g === bounds.length - 2 ? mEnd : cornerGap);
        const usable = to - from;
        if (usable < 0) { if (bounds.length === 2) seam.holeArc.push(L / 2); continue; }
        // nominal pitch, row centred between the two margins
        const n = Math.floor(usable / seam.pitch + 1e-6) + 1;
        const s0 = from + (usable - (n - 1) * seam.pitch) / 2;
        for (let k = 0; k < n; k++) seam.holeArc.push(s0 + k * seam.pitch);
      }
    }
    const key = seamKey(seam.origEdges);
    for (const sr of sides) {
      const pc = pieces[sr.piece];
      const L2 = polylineLength(sr.s2), L3 = seam.length || 1;
      seam.holeArc.forEach((sArc, k) => {
        if (opts.deletedHoles?.has(`${key}:${k}`)) return;
        const { p, dir } = pointAtArc(sr.s2, (sArc / L3) * L2);
        const left = perp2(dir);
        const inward = sr.isA ? left : scale2(left, -1);
        pc.holes.push({ seamId: seam.id, index: k, side: sr.isA ? 'A' : 'B', p: add2(p, scale2(inward, seam.insetMm)), p3: [0, 0, 0] });
      });
    }
  }
  for (const pc of pieces) {
    const li = pc.patch.flat.localIndex;
    const D = (cv: number): V3 => { const ov = cut.origVertex[cv]; return [display[3 * ov], display[3 * ov + 1], display[3 * ov + 2]]; };
    // 3D hole markers: locate each 2D hole in the flattened triangles and lift the matching surface point
    {
      const uv = pc.uv;
      const faces = pc.patch.faces;
      const tri = (f: number) => [0, 1, 2].map((k) => ct.mesh.indices[3 * f + k]);
      const uvOf = (cv: number): V2 => { const l = li.get(cv)!; return [uv[2 * l], uv[2 * l + 1]]; };
      for (const h of pc.holes) {
        let best: { f: number; b: [number, number, number]; d: number } | null = null;
        for (const f of faces) {
          const [a, b, c] = tri(f).map(uvOf);
          const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
          if (Math.abs(det) < 1e-12) continue;
          let l1 = ((b[0] - h.p[0]) * (c[1] - h.p[1]) - (c[0] - h.p[0]) * (b[1] - h.p[1])) / det;
          let l2 = ((c[0] - h.p[0]) * (a[1] - h.p[1]) - (a[0] - h.p[0]) * (c[1] - h.p[1])) / det;
          let l3 = 1 - l1 - l2;
          // distance outside the triangle (0 if inside)
          const d = Math.max(0, -l1, -l2, -l3);
          if (!best || d < best.d) {
            if (d > 0) { l1 = Math.max(0, l1); l2 = Math.max(0, l2); l3 = Math.max(0, l3); const sum = l1 + l2 + l3 || 1; l1 /= sum; l2 /= sum; l3 /= sum; }
            best = { f, b: [l1, l2, l3], d };
            if (d === 0) break;
          }
        }
        if (!best) continue;
        const [a, b, c] = tri(best.f).map(D);
        const fn: V3 = norm3([ct.faceNormals[3 * best.f], ct.faceNormals[3 * best.f + 1], ct.faceNormals[3 * best.f + 2]]);
        const q: V3 = [0, 1, 2].map((k) => a[k] * best!.b[0] + b[k] * best!.b[1] + c[k] * best!.b[2]) as V3;
        h.p3 = add3(q, scale3(fn, liftHole));
      }
    }
  }

  const totalAreaMm2 = pieces.reduce((s, p) => s + p.areaMm2, 0);
  return { pieces, seams, spec, warnings, sheet: { w: 0, h: 0 }, totalAreaMm2 };
}
