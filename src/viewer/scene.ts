import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PipelineResult } from '../pattern/pipeline';
import { toLayout } from '../pattern/layout';
import { csrRange, otherFace } from '../geometry/mesh';
import { EDGE_FOLD } from '../geometry/segmentation';
import { V3 } from '../geometry/vec';

export interface PickInfo {
  face: number;
  patchId: number;
  /** original vertex nearest to the click */
  vertex: number;
  point: V3;
  nearestSeam: { id: number; dist: number } | null;
  /** index of a seam-editing handle under the pointer, if any */
  handle?: number;
  /** stitch hole under the pointer (when hole picking is enabled) */
  hole?: { piece: number; holeIndex: number; seamId: number; index: number };
  shift?: boolean;
}

export interface ViewerVisibility {
  seams: boolean;
  holes: boolean;
  folds: boolean;
  labels: boolean;
  thread: boolean;
}

export function patchColor(i: number): THREE.Color {
  const h = (i * 0.61803398875) % 1;
  return new THREE.Color().setHSL(h, 0.55, 0.55);
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export class Viewer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  private root = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private seamLines: THREE.LineSegments | null = null;
  private foldLines: THREE.LineSegments | null = null;
  private holes: THREE.InstancedMesh | null = null;
  private labels: THREE.Sprite[] = [];
  private pathLine: THREE.Line | null = null;
  private highlightLine: THREE.LineSegments | null = null;
  private markers: THREE.Mesh[] = [];
  private handleGroup = new THREE.Group();
  private handleMeshes: THREE.Mesh[] = [];
  private handleVerts: number[] = [];
  private res: PipelineResult | null = null;
  private explode = 0;
  private visibility: ViewerVisibility = { seams: true, holes: true, folds: true, labels: true, thread: true };
  /** when true, stitch holes are picked before the surface */
  pickHoles = false;
  private holeInfo: Array<{ piece: number; holeIndex: number; seamId: number; index: number; side: 'A' | 'B' }> = [];
  private threadPairs: number[] = []; // instance index pairs
  private threadLines: THREE.LineSegments | null = null;
  private selectedSeam: number | null = null;
  // per cut vertex, 3 states × 3 coords
  private s0!: Float32Array;
  private s1!: Float32Array;
  private s2!: Float32Array;
  private cur!: Float32Array;
  // holes
  private h0!: Float32Array;
  private h1!: Float32Array;
  private h2!: Float32Array;
  private holeRadius = 1;
  private seamEdgeIds: number[] = []; // seam id per line segment
  private line0!: Float32Array; // seam line segment endpoints, 3 states
  private line1!: Float32Array;
  private line2!: Float32Array;
  private lineCur!: Float32Array;
  private foldEdgeVerts: number[] = [];
  private pieceVerts: number[][] = [];
  private origToCut: Map<number, number> = new Map();
  private modelSize = 100;
  onPick: ((p: PickInfo) => void) | null = null;
  /** return true to capture the drag (orbit is suspended until pointer up) */
  onDragStart: ((p: PickInfo) => boolean) | null = null;
  onDragMove: ((p: PickInfo | null) => void) | null = null;
  onDragEnd: ((p: PickInfo | null) => void) | null = null;
  private needsRender = true;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x14161a, 1);
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
    this.camera.position.set(200, 150, 250);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => (this.needsRender = true));
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(1, 2, 1.5);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
    dir2.position.set(-2, -1, -1);
    this.scene.add(dir2);
    this.scene.add(this.root);
    this.scene.add(this.handleGroup);
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.resize();
    this.setupPicking();
    const loop = () => {
      requestAnimationFrame(loop);
      this.controls.update();
      if (this.needsRender) {
        this.renderer.render(this.scene, this.camera);
        this.needsRender = false;
      }
    };
    loop();
  }

  private resize(): void {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  /** Raycast the pointer onto the mesh in its current (possibly exploded) state. */
  pickAt(clientX: number, clientY: number): PickInfo | null {
    if (!this.mesh || !this.res) return null;
    const el = this.renderer.domElement;
    const rect = el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    // editing handles take priority over the surface
    if (this.handleMeshes.length) {
      this.handleGroup.updateMatrixWorld(true);
      const hh = ray.intersectObjects(this.handleMeshes, false);
      if (hh.length) {
        const idx = this.handleMeshes.indexOf(hh[0].object as THREE.Mesh);
        const pt = hh[0].point;
        return { face: -1, patchId: -1, vertex: this.handleVerts[idx], point: [pt.x, pt.y, pt.z], nearestSeam: null, handle: idx };
      }
    }
    if (this.pickHoles && this.holes) {
      const hh = ray.intersectObject(this.holes, false);
      if (hh.length && hh[0].instanceId !== undefined) {
        const info = this.holeInfo[hh[0].instanceId];
        const pt = hh[0].point;
        return { face: -1, patchId: info.piece, vertex: -1, point: [pt.x, pt.y, pt.z], nearestSeam: { id: info.seamId, dist: 0 }, hole: info };
      }
    }
    const hits = ray.intersectObject(this.mesh, false);
    if (!hits.length || hits[0].faceIndex === undefined || hits[0].faceIndex === null) return null;
    const face = hits[0].faceIndex as number;
    const pt = hits[0].point;
    const ct = this.res.seg.cut.topo;
    let bestV = -1, bd = Infinity;
    for (let k = 0; k < 3; k++) {
      const cv = ct.mesh.indices[3 * face + k];
      const d = Math.hypot(this.cur[3 * cv] - pt.x, this.cur[3 * cv + 1] - pt.y, this.cur[3 * cv + 2] - pt.z);
      if (d < bd) { bd = d; bestV = cv; }
    }
    let nearest: PickInfo['nearestSeam'] = null;
    const P = new THREE.Vector3().copy(pt), A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    for (let i = 0; i < this.seamEdgeIds.length; i++) {
      if (this.seamEdgeIds[i] < 0) continue;
      A.set(this.lineCur[6 * i], this.lineCur[6 * i + 1], this.lineCur[6 * i + 2]);
      B.set(this.lineCur[6 * i + 3], this.lineCur[6 * i + 4], this.lineCur[6 * i + 5]);
      new THREE.Line3(A, B).closestPointToPoint(P, true, C);
      const d = C.distanceTo(P);
      if (!nearest || d < nearest.dist) nearest = { id: this.seamEdgeIds[i], dist: d };
    }
    return { face, patchId: this.res.seg.faceToPatch[face], vertex: this.res.seg.cut.origVertex[bestV], point: [pt.x, pt.y, pt.z], nearestSeam: nearest };
  }

  private setupPicking(): void {
    const el = this.renderer.domElement;
    let down: [number, number] | null = null;
    let dragging = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = [e.clientX, e.clientY];
      if (this.onDragStart) {
        const p = this.pickAt(e.clientX, e.clientY);
        if (p) p.shift = e.shiftKey;
        if (p && this.onDragStart(p)) {
          dragging = true;
          this.controls.enabled = false;
          el.setPointerCapture(e.pointerId);
        }
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging || !this.onDragMove) return;
      this.onDragMove(this.pickAt(e.clientX, e.clientY));
    });
    el.addEventListener('pointerup', (e) => {
      if (dragging) {
        dragging = false;
        this.controls.enabled = true;
        try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        const pe = this.pickAt(e.clientX, e.clientY);
        if (pe) pe.shift = e.shiftKey;
        this.onDragEnd?.(pe);
        down = null;
        return;
      }
      if (!down) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      down = null;
      if (moved > 4 || !this.onPick) return;
      const p = this.pickAt(e.clientX, e.clientY);
      if (p) { p.shift = e.shiftKey; this.onPick(p); }
    });
  }

  /** Show draggable seam-editing handles at original vertices. */
  setHandles(origVerts: number[], selected: Set<number>, fixed: Set<number>): void {
    this.handleGroup.clear();
    this.handleMeshes = [];
    this.handleVerts = origVerts.slice();
    const rad = this.modelSize * 0.02;
    origVerts.forEach((_, i) => {
      const color = fixed.has(i) ? 0x9aa3b2 : selected.has(i) ? 0x00ff88 : 0xffd166;
      const m = new THREE.Mesh(new THREE.SphereGeometry(rad, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
      m.renderOrder = 30;
      this.handleGroup.add(m);
      this.handleMeshes.push(m);
    });
    this.updateHandlePositions();
    this.needsRender = true;
  }

  private updateHandlePositions(): void {
    if (!this.res) return;
    this.handleMeshes.forEach((m, i) => {
      const cv = this.origToCut.get(this.handleVerts[i]);
      if (cv === undefined) return;
      m.position.set(this.cur[3 * cv], this.cur[3 * cv + 1], this.cur[3 * cv + 2]);
    });
  }

  clear(): void {
    this.root.clear();
    this.mesh = null; this.seamLines = null; this.foldLines = null; this.holes = null; this.labels = []; this.pathLine = null; this.highlightLine = null; this.markers = []; this.threadLines = null; this.holeInfo = []; this.threadPairs = [];
    this.needsRender = true;
  }

  setResult(res: PipelineResult | null, fitCamera = true): void {
    this.clear();
    this.res = res;
    if (!res) return;
    const { topo, seg, pattern } = res;
    const ct = seg.cut.topo;
    const cut = seg.cut;
    const nv = ct.mesh.nv;
    const orig = topo.mesh.positions;
    // model frame
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < topo.mesh.nv; v++) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], orig[3 * v + k]); max[k] = Math.max(max[k], orig[3 * v + k]); }
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
    this.modelSize = size;
    const sheet = pattern.sheet;
    const floorY = min[1] - 0.25 * size;
    const flatPos = (lx: number, ly: number, lift = 0): [number, number, number] => [lx - sheet.w / 2 + center[0], floorY + lift, -(ly - sheet.h / 2) + center[2]];

    // explode direction per patch
    const explodeDir: number[][] = pattern.pieces.map((pc) => {
      const n = [0, 0, 0]; let A = 0; const c = [0, 0, 0];
      for (const f of pc.patch.faces) {
        const a = topo.faceAreas[f]; A += a;
        for (let k = 0; k < 3; k++) { n[k] += topo.faceNormals[3 * f + k] * a; c[k] += topo.faceCentroids[3 * f + k] * a; }
      }
      for (let k = 0; k < 3; k++) c[k] /= A || 1;
      let l = Math.hypot(n[0], n[1], n[2]);
      if (l < 0.25 * A) { n[0] = c[0] - center[0]; n[1] = c[1] - center[1]; n[2] = c[2] - center[2]; l = Math.hypot(n[0], n[1], n[2]); }
      if (l < 1e-9) return [0, 1, 0];
      return [n[0] / l, n[1] / l, n[2] / l];
    });
    const explodeDist = 0.35 * size;

    // vertex → patch
    const vertPatch = new Int32Array(nv).fill(-1);
    for (let v = 0; v < nv; v++) { const fs = csrRange(ct.vertexFaces, v); if (fs.length) vertPatch[v] = seg.faceToPatch[fs[0]]; }
    this.s0 = new Float32Array(3 * nv); this.s1 = new Float32Array(3 * nv); this.s2 = new Float32Array(3 * nv); this.cur = new Float32Array(3 * nv);
    this.origToCut = new Map();
    this.pieceVerts = pattern.pieces.map(() => []);
    for (let v = 0; v < nv; v++) {
      const ov = cut.origVertex[v];
      if (!this.origToCut.has(ov)) this.origToCut.set(ov, v);
      const p = vertPatch[v];
      for (let k = 0; k < 3; k++) this.s0[3 * v + k] = orig[3 * ov + k];
      const d = p >= 0 ? explodeDir[p] : [0, 0, 0];
      for (let k = 0; k < 3; k++) this.s1[3 * v + k] = this.s0[3 * v + k] + d[k] * explodeDist;
      if (p >= 0) {
        const pc = pattern.pieces[p];
        const li = pc.patch.flat.localIndex.get(v);
        if (li !== undefined) {
          const l = toLayout(pc, [pc.uv[2 * li], pc.uv[2 * li + 1]]);
          const f = flatPos(l[0], l[1]);
          this.s2[3 * v] = f[0]; this.s2[3 * v + 1] = f[1]; this.s2[3 * v + 2] = f[2];
        }
        this.pieceVerts[p].push(v);
      }
    }
    // boundary vertices snapped onto the smooth seam curves (assembled/exploded states)
    for (const pc of pattern.pieces) for (const [cv, q] of pc.boundaryDisplay) {
      const d = explodeDir[pc.id];
      for (let k = 0; k < 3; k++) { this.s0[3 * cv + k] = q[k]; this.s1[3 * cv + k] = q[k] + d[k] * explodeDist; }
    }
    // mesh
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.cur, 3));
    const colors = new Float32Array(3 * nv);
    for (let v = 0; v < nv; v++) {
      const p = vertPatch[v];
      const c = p >= 0 ? patchColor(p) : new THREE.Color(0x888888);
      colors[3 * v] = c.r; colors[3 * v + 1] = c.g; colors[3 * v + 2] = c.b;
    }
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.setIndex(new THREE.BufferAttribute(Uint32Array.from(ct.mesh.indices), 1));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.75, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.mesh = new THREE.Mesh(geom, mat);
    this.root.add(this.mesh);

    // seam / raw-edge lines from the smoothed pattern runs (3 states per point), fold lines from mesh edges
    this.seamEdgeIds = []; this.foldEdgeVerts = [];
    const l0: number[] = [], l1: number[] = [], l2: number[] = [];
    for (const pc of pattern.pieces) {
      const d = explodeDir[pc.id];
      for (const run of pc.runs) {
        for (let i = 0; i < run.pts2.length - 1; i++) {
          for (const j of [i, i + 1]) {
            const p3 = run.pts3[j];
            l0.push(p3[0], p3[1], p3[2]);
            l1.push(p3[0] + d[0] * explodeDist, p3[1] + d[1] * explodeDist, p3[2] + d[2] * explodeDist);
            const l = toLayout(pc, run.pts2[j]);
            const f = flatPos(l[0], l[1], 0.2);
            l2.push(f[0], f[1], f[2]);
          }
          this.seamEdgeIds.push(run.seamId);
        }
      }
    }
    this.line0 = Float32Array.from(l0); this.line1 = Float32Array.from(l1); this.line2 = Float32Array.from(l2);
    for (let e = 0; e < ct.ne; e++) {
      const oe = cut.origEdge[e];
      if (ct.edgeFaces[2 * e + 1] >= 0 && seg.edgeClass[oe] === EDGE_FOLD) this.foldEdgeVerts.push(ct.edgeVerts[2 * e], ct.edgeVerts[2 * e + 1]);
    }
    void otherFace;
    const seamGeom = new THREE.BufferGeometry();
    seamGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.line0.length), 3));
    const seamColors = new Float32Array(this.line0.length);
    for (let i = 0; i < this.seamEdgeIds.length; i++) {
      const id = this.seamEdgeIds[i];
      const c = id >= 0 ? (pattern.seams[id].type === 'turned' ? new THREE.Color(0xffd166) : new THREE.Color(0xff7b54)) : new THREE.Color(0xdddddd);
      for (let j = 0; j < 2; j++) { seamColors[6 * i + 3 * j] = c.r; seamColors[6 * i + 3 * j + 1] = c.g; seamColors[6 * i + 3 * j + 2] = c.b; }
    }
    seamGeom.setAttribute('color', new THREE.BufferAttribute(seamColors, 3));
    this.seamLines = new THREE.LineSegments(seamGeom, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.root.add(this.seamLines);
    const foldGeom = new THREE.BufferGeometry();
    foldGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * this.foldEdgeVerts.length), 3));
    this.foldLines = new THREE.LineSegments(foldGeom, new THREE.LineBasicMaterial({ color: 0x4ea1ff }));
    this.root.add(this.foldLines);

    // holes
    const holeList: Array<{ p3: V3; patch: number; p2: [number, number] }> = [];
    this.holeInfo = [];
    pattern.pieces.forEach((pc) => pc.holes.forEach((h, hi) => { holeList.push({ p3: h.p3, patch: pc.id, p2: toLayout(pc, h.p) }); this.holeInfo.push({ piece: pc.id, holeIndex: hi, seamId: h.seamId, index: h.index, side: h.side }); }));
    // matched pairs (same seam, same index, opposite sides) for the thread visualisation
    const bySeam = new Map<string, number>();
    this.threadPairs = [];
    this.holeInfo.forEach((info, i) => {
      const k = `${info.seamId}:${info.index}`;
      const other = bySeam.get(k);
      if (other !== undefined && this.holeInfo[other].side !== info.side) this.threadPairs.push(other, i);
      else bySeam.set(k, i);
    });
    const nh = holeList.length;
    this.h0 = new Float32Array(3 * nh); this.h1 = new Float32Array(3 * nh); this.h2 = new Float32Array(3 * nh);
    holeList.forEach((h, i) => {
      const d = explodeDir[h.patch];
      for (let k = 0; k < 3; k++) { this.h0[3 * i + k] = h.p3[k]; this.h1[3 * i + k] = h.p3[k] + d[k] * explodeDist; }
      const f = flatPos(h.p2[0], h.p2[1], 0.3);
      this.h2[3 * i] = f[0]; this.h2[3 * i + 1] = f[1]; this.h2[3 * i + 2] = f[2];
    });
    this.holeRadius = Math.max(pattern.spec.holeDiameterMm / 2, size * 0.004);
    if (nh) {
      this.holes = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff2e2e }), nh);
      this.holes.visible = this.visibility.holes;
      this.root.add(this.holes);
    }
    if (this.threadPairs.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * this.threadPairs.length), 3));
      this.threadLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xf1e3c4, transparent: true, opacity: 1, depthTest: false }));
      this.threadLines.renderOrder = 12;
      this.threadLines.visible = this.visibility.thread;
      this.root.add(this.threadLines);
    }
    // labels
    this.labels = pattern.pieces.map((pc) => {
      const sp = makeLabel(pc.name, patchColor(pc.id));
      sp.scale.setScalar(size * 0.08);
      this.root.add(sp);
      return sp;
    });
    this.highlightLine = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 }));
    this.root.add(this.highlightLine);
    this.updatePositions();
    if (fitCamera) this.fitCamera(min as V3, max as V3, floorY);
    else this.needsRender = true;
  }

  private fitCamera(min: V3, max: V3, floorY: number): void {
    const sheet = this.res!.pattern.sheet;
    // frame the model when assembled/exploded, the whole sheet when showing the flat pattern
    const flat = this.explode > 1;
    const c = flat
      ? new THREE.Vector3((min[0] + max[0]) / 2, (floorY + max[1]) / 2, (min[2] + max[2]) / 2)
      : new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    const r = flat
      ? 0.5 * Math.hypot(Math.max(max[0] - min[0], sheet.w), max[1] - floorY, Math.max(max[2] - min[2], sheet.h)) * 1.15
      : 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 1.9;
    const dist = r / Math.sin((this.camera.fov * Math.PI) / 360);
    this.camera.position.copy(c).add(new THREE.Vector3(0.6, 0.55, 0.85).normalize().multiplyScalar(dist));
    this.camera.near = dist / 200; this.camera.far = dist * 20; this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.update();
    this.needsRender = true;
  }

  setExplode(t: number): void {
    this.explode = Math.max(0, Math.min(2, t));
    this.updatePositions();
  }

  setVisibility(v: Partial<ViewerVisibility>): void {
    this.visibility = { ...this.visibility, ...v };
    if (this.seamLines) this.seamLines.visible = this.visibility.seams;
    if (this.foldLines) this.foldLines.visible = this.visibility.folds;
    if (this.holes) this.holes.visible = this.visibility.holes;
    if (this.threadLines) this.threadLines.visible = this.visibility.thread && this.explode < 0.3;
    for (const l of this.labels) l.visible = this.visibility.labels;
    this.needsRender = true;
  }

  highlight(patch: number | null, seam: number | null): void {
    this.selectedSeam = seam;
    if (!this.res || !this.mesh) return;
    const colors = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const ct = this.res.seg.cut.topo;
    for (let v = 0; v < ct.mesh.nv; v++) {
      const fs = csrRange(ct.vertexFaces, v);
      const p = fs.length ? this.res.seg.faceToPatch[fs[0]] : -1;
      const c = patchColor(p);
      if (patch !== null && p === patch) c.offsetHSL(0, 0.2, 0.2);
      else if (patch !== null) c.offsetHSL(0, -0.3, -0.15);
      colors.setXYZ(v, c.r, c.g, c.b);
    }
    colors.needsUpdate = true;
    this.updateHighlightLine();
    this.needsRender = true;
  }

  private updateHighlightLine(): void {
    if (!this.highlightLine) return;
    const pts: number[] = [];
    if (this.selectedSeam !== null) {
      for (let i = 0; i < this.seamEdgeIds.length; i++) {
        if (this.seamEdgeIds[i] !== this.selectedSeam) continue;
        for (let k = 0; k < 6; k++) pts.push(this.lineCur[6 * i + k]);
      }
    }
    this.highlightLine.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pts), 3));
    this.highlightLine.geometry = g;
  }

  /** Preview a candidate cut path (original vertex ids) and marker points. */
  showPath(origVertices: number[], markerVertices: number[]): void {
    if (this.pathLine) { this.root.remove(this.pathLine); this.pathLine = null; }
    for (const m of this.markers) this.root.remove(m);
    this.markers = [];
    if (!this.res) return;
    const pts: number[] = [];
    for (const ov of origVertices) {
      const cv = this.origToCut.get(ov);
      if (cv === undefined) continue;
      pts.push(this.cur[3 * cv], this.cur[3 * cv + 1], this.cur[3 * cv + 2]);
    }
    if (pts.length >= 6) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pts), 3));
      this.pathLine = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x00ff88 }));
      this.root.add(this.pathLine);
    }
    for (const ov of markerVertices) {
      const cv = this.origToCut.get(ov);
      if (cv === undefined) continue;
      const m = new THREE.Mesh(new THREE.SphereGeometry(this.modelSize * 0.012, 12, 8), new THREE.MeshBasicMaterial({ color: 0x00ff88 }));
      m.position.set(this.cur[3 * cv], this.cur[3 * cv + 1], this.cur[3 * cv + 2]);
      this.root.add(m);
      this.markers.push(m);
    }
    this.needsRender = true;
  }

  private updatePositions(): void {
    if (!this.res || !this.mesh) return;
    const t = this.explode;
    const a = t <= 1 ? smooth(t) : 1;
    const b = t <= 1 ? 0 : smooth(t - 1);
    const n = this.cur.length;
    for (let i = 0; i < n; i++) {
      const e = this.s0[i] + (this.s1[i] - this.s0[i]) * a;
      this.cur[i] = e + (this.s2[i] - e) * b;
    }
    (this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
    // lines
    const fill = (line: THREE.LineSegments | null, verts: number[]) => {
      if (!line) return;
      const arr = (line.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      for (let i = 0; i < verts.length; i++) { const v = verts[i]; arr[3 * i] = this.cur[3 * v]; arr[3 * i + 1] = this.cur[3 * v + 1]; arr[3 * i + 2] = this.cur[3 * v + 2]; }
      (line.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      line.geometry.computeBoundingSphere();
    };
    if (this.seamLines) {
      const arr = (this.seamLines.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      for (let i = 0; i < arr.length; i++) {
        const e = this.line0[i] + (this.line1[i] - this.line0[i]) * a;
        arr[i] = e + (this.line2[i] - e) * b;
      }
      this.lineCur = arr;
      (this.seamLines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      this.seamLines.geometry.computeBoundingSphere();
    }
    fill(this.foldLines, this.foldEdgeVerts);
    // holes
    if (this.holes) {
      const m = new THREE.Matrix4();
      const nh = this.holes.count;
      for (let i = 0; i < nh; i++) {
        const x0 = this.h0[3 * i] + (this.h1[3 * i] - this.h0[3 * i]) * a, y0 = this.h0[3 * i + 1] + (this.h1[3 * i + 1] - this.h0[3 * i + 1]) * a, z0 = this.h0[3 * i + 2] + (this.h1[3 * i + 2] - this.h0[3 * i + 2]) * a;
        const x = x0 + (this.h2[3 * i] - x0) * b, y = y0 + (this.h2[3 * i + 1] - y0) * b, z = z0 + (this.h2[3 * i + 2] - z0) * b;
        m.makeScale(this.holeRadius, this.holeRadius, this.holeRadius).setPosition(x, y, z);
        this.holes.setMatrixAt(i, m);
      }
      this.holes.instanceMatrix.needsUpdate = true;
      this.holes.computeBoundingSphere();
      if (this.threadLines) {
        // links between matched holes: shown while assembled, fading out over the first 30% of the explode
        const arr = (this.threadLines.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
        const pos = (i: number, k: number) => { const e = this.h0[3 * i + k] + (this.h1[3 * i + k] - this.h0[3 * i + k]) * a; return e + (this.h2[3 * i + k] - e) * b; };
        for (let q = 0; q < this.threadPairs.length; q++) for (let k = 0; k < 3; k++) arr[3 * q + k] = pos(this.threadPairs[q], k);
        (this.threadLines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        this.threadLines.geometry.computeBoundingSphere();
        const fade = Math.max(0, 1 - t / 0.3);
        (this.threadLines.material as THREE.LineBasicMaterial).opacity = fade;
        this.threadLines.visible = this.visibility.thread && fade > 0;
      }
    }
    // labels at piece centroids
    this.labels.forEach((sp, p) => {
      const vs = this.pieceVerts[p];
      if (!vs.length) return;
      let x = 0, y = 0, z = 0;
      for (const v of vs) { x += this.cur[3 * v]; y += this.cur[3 * v + 1]; z += this.cur[3 * v + 2]; }
      sp.position.set(x / vs.length, y / vs.length + this.modelSize * 0.02, z / vs.length);
    });
    this.updateHighlightLine();
    this.updateHandlePositions();
    this.needsRender = true;
  }
}

function makeLabel(text: string, color: THREE.Color): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath(); ctx.arc(64, 64, 52, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#' + color.getHexString(); ctx.lineWidth = 6; ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 60px Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(canvas);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.renderOrder = 10;
  return sp;
}
