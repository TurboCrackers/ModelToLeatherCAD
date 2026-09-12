import './style.css';
import { el, option, labeled, section, downloadBlob } from './ui/dom';
import { LEATHER_FAMILIES, familiesFor, getFamily, thicknessOptionsMm, ozFromMm, Animal, LeatherFamily } from './leather/database';
import { buildLeatherSpec, LeatherSpec, SpecOverrides, SeamType } from './leather/physics';
import { TriMesh, boundingBox, transformMesh, buildTopology, orientMesh } from './geometry/mesh';
import { loadModelFile } from './geometry/loaders';
import { makeBox, makeCylinder, makeSphere, makePouch, makeTorus } from './geometry/primitives';
import { shortestEdgePath } from './geometry/paths';
import { simplifyIndices } from './pattern/smooth';
import { V3 } from './geometry/vec';
import { runPipeline, defaultPipelineSettings, PipelineResult, PipelineSettings, effectiveStretchLimit, MAX_FORMED_STRAIN } from './pattern/pipeline';
import { seamKey } from './pattern/pattern';
import { exportSvg } from './export/svg';
import { exportPdf, PaperSize } from './export/pdf';
import { Viewer, PickInfo, patchColor } from './viewer/scene';

type Tool = 'select' | 'cut' | 'move' | 'points' | 'holes' | 'join' | 'seamtype';
const UNIT_SCALE: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };

class App {
  rawModel: TriMesh | null = null;
  modelName = 'model';
  unitScale = 1;
  familyId = 'cow-veg-tan';
  thicknessMm = 1.6;
  overrides: SpecOverrides = {};
  settings: PipelineSettings = defaultPipelineSettings();
  result: PipelineResult | null = null;
  viewer!: Viewer;
  tool: Tool = 'select';
  cutStart: number | null = null;
  selectedPatch: number | null = null;
  selectedSeam: number | null = null;
  autoUpdate = true;
  // DOM refs
  refs: Record<string, HTMLElement> = {};
  private computing = false;
  private pendingRecompute = false;
  /** frame the camera on the next result (only after loading a model, never on edits) */
  private fitCameraNext = true;

  get spec(): LeatherSpec { return buildLeatherSpec(getFamily(this.familyId), this.thicknessMm, this.overrides); }
  get family(): LeatherFamily { return getFamily(this.familyId); }
  get model(): TriMesh | null { return this.rawModel ? transformMesh(this.rawModel, this.unitScale) : null; }

  mount(root: HTMLElement): void {
    root.append(this.buildHeader(), this.buildLeft(), this.buildCenter(), this.buildRight(), this.buildStatus());
    this.viewer = new Viewer(this.refs.viewport);
    this.viewer.onPick = (p) => this.onPick(p);
    this.viewer.onDragStart = (p) => this.onDragStart(p);
    this.viewer.onDragMove = (p) => this.onDragMove(p);
    this.viewer.onDragEnd = (p) => this.onDragEnd(p);
    this.refreshLeatherUI();
    this.setStatus('Load a model (STL, OBJ, PLY, glTF) or pick a sample shape to begin.');
    window.addEventListener('keydown', (e) => {
      if (this.tool !== 'points' || !this.edit) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deletePoints(); }
      else if (e.key === 's' || e.key === 'S') { e.preventDefault(); this.smoothPoints(); }
      else if (e.key === 'a' || e.key === 'A') { e.preventDefault(); this.selectAllPoints(); }
      else if (e.key === 'Escape') { this.edit.selected.clear(); this.refreshHandles(); }
    });
  }

  // ───────────────────────── UI construction
  private buildHeader(): HTMLElement {
    return el('header', {}, el('h1', {}, 'Model → Leather CAD'), el('span', { class: 'sub' }, '3D model to leather pattern with physically informed cuts, matched stitch holes, SVG/PDF export'));
  }

  private buildLeft(): HTMLElement {
    const file = el('input', { type: 'file', accept: '.stl,.obj,.ply,.gltf,.glb', onChange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) this.loadFile(f); } });
    const samples = el('div', { class: 'chips' },
      el('button', { onClick: () => this.setModel(makeBox(120, 80, 50), 'box') }, 'Box'),
      el('button', { onClick: () => this.setModel(makeCylinder(35, 110, 48), 'cylinder') }, 'Cylinder'),
      el('button', { onClick: () => this.setModel(makeSphere(60, 32, 16), 'sphere') }, 'Sphere'),
      el('button', { onClick: () => this.setModel(makePouch(140, 90, 45, 14), 'pouch') }, 'Pouch'),
      el('button', { onClick: () => this.setModel(makeTorus(60, 22, 20, 40), 'torus') }, 'Torus'),
    );
    const units = el('select', { onChange: () => { this.unitScale = UNIT_SCALE[units.value]; this.fitCameraNext = true; this.refreshModelStats(); this.scheduleRecompute('full'); } }, ...['mm', 'cm', 'm', 'in'].map((u) => option(u, u, u === 'mm')));
    const longest = el('input', { type: 'number', step: 'any', min: 1, onChange: () => {
      if (!this.rawModel) return;
      const raw = boundingBox(this.rawModel).maxDim;
      const v = parseFloat(longest.value);
      if (v > 0 && raw > 0) { this.unitScale = v / raw; this.fitCameraNext = true; this.scheduleRecompute('full'); this.refreshModelStats(); }
    } });
    this.refs.units = units; this.refs.longest = longest;
    this.refs.modelStats = el('div', { class: 'desc' }, 'No model loaded.');

    // leather
    const animal = el('select', { onChange: () => { const fams = familiesFor(animal.value as Animal); this.familyId = fams[0].id; this.refreshLeatherUI(); this.scheduleRecompute('full'); } }, option('cow', 'Cow'), option('sheep', 'Sheep'), option('lamb', 'Lamb'));
    const family = el('select', { onChange: () => { this.familyId = family.value; this.refreshLeatherUI(); this.scheduleRecompute('full'); } });
    const thickness = el('select', { onChange: () => { this.thicknessMm = parseFloat(thickness.value); this.refreshLeatherUI(); this.scheduleRecompute('full'); } });
    this.refs.animal = animal; this.refs.family = family; this.refs.thickness = thickness;
    this.refs.familyDesc = el('div', { class: 'desc' });
    this.refs.props = el('table', { class: 'props' });
    const grooved = el('input', { type: 'checkbox', onChange: () => { this.overrides.allowGroovedFolds = grooved.checked; this.refreshLeatherUI(); this.scheduleRecompute('full'); } });

    // pattern settings
    const simplicity = el('input', { type: 'range', min: 0, max: 100, step: 1, value: 0, onInput: () => { this.settings.simplicity = parseFloat(simplicity.value) / 100; this.refreshSimplicityLabel(); }, onChange: () => this.scheduleRecompute('full') });
    this.refs.simplicity = simplicity;
    this.refs.simplicityLabel = el('span', { class: 'hint' });
    const seamType = el('select', { onChange: () => { this.settings.seamType = seamType.value as any; this.scheduleRecompute('pattern'); } }, option('auto', 'Auto (from leather thickness)'), option('turned', 'Turned (sewn inside-out, allowance added)'), option('butted', 'Butted / edge-stitched (holes inset from cut edge)'));
    const surface = el('select', { onChange: () => { this.settings.surfaceMode = surface.value as any; this.scheduleRecompute('full'); } }, option('outer', 'Outer (grain) surface'), option('inner', 'Inner (flesh) surface'), option('mid', 'Mid-thickness'));
    const crease = el('input', { type: 'number', value: 40, min: 10, max: 90, step: 1, onChange: () => { this.settings.creaseAngleDeg = parseFloat(crease.value) || 40; this.scheduleRecompute('full'); } });
    const stretch = el('input', { type: 'number', step: 0.5, min: 0, max: 50, placeholder: 'leather default', onChange: () => { const v = parseFloat(stretch.value); this.settings.stretchLimitOverride = isFinite(v) && stretch.value !== '' ? v / 100 : null; this.scheduleRecompute('full'); } });
    const maxSplits = el('input', { type: 'number', value: 150, min: 0, max: 500, step: 1, onChange: () => { this.settings.maxSplits = parseInt(maxSplits.value) || 0; this.scheduleRecompute('full'); } });
    const hem = el('input', { type: 'number', value: 0, min: 0, max: 50, step: 0.5, onChange: () => { this.settings.rawEdgeAllowanceMm = parseFloat(hem.value) || 0; this.scheduleRecompute('pattern'); } });
    const spi = el('input', { type: 'number', step: 0.5, min: 2, max: 14, placeholder: 'auto', onChange: () => { const v = parseFloat(spi.value); this.overrides.stitchesPerInch = isFinite(v) && spi.value !== '' ? v : undefined; this.refreshLeatherUI(); this.scheduleRecompute('pattern'); } });
    const margin = el('input', { type: 'number', step: 0.5, min: 1, max: 20, placeholder: 'auto', onChange: () => { const v = parseFloat(margin.value); this.overrides.edgeMarginMm = isFinite(v) && margin.value !== '' ? v : undefined; this.refreshLeatherUI(); this.scheduleRecompute('pattern'); } });
    const allowance = el('input', { type: 'number', step: 0.5, min: 0, max: 30, placeholder: 'auto', onChange: () => { const v = parseFloat(allowance.value); this.overrides.seamAllowanceMm = isFinite(v) && allowance.value !== '' ? v : undefined; this.refreshLeatherUI(); this.scheduleRecompute('pattern'); } });
    const sheetW = el('input', { type: 'number', value: 0, min: 0, step: 10, onChange: () => { this.settings.layout.sheetWidthMm = parseFloat(sheetW.value) || 0; this.scheduleRecompute('pattern'); } });
    const gap = el('input', { type: 'number', value: 8, min: 0, step: 1, onChange: () => { this.settings.layout.gapMm = parseFloat(gap.value) || 0; this.scheduleRecompute('pattern'); } });
    const smoothCb = el('input', { type: 'checkbox', checked: true, onChange: () => { this.settings.smoothCutLines = smoothCb.checked; this.scheduleRecompute('pattern'); } });
    const refine = el('input', { type: 'number', value: 3000, min: 0, max: 60000, step: 1000, onChange: () => { this.settings.refineTargetFaces = parseInt(refine.value) || 0; this.settings.forcedSeamEdges.clear(); this.settings.forbiddenSeamEdges.clear(); this.scheduleRecompute('full'); } });
    const regular = el('input', { type: 'checkbox', checked: true, onChange: () => { this.settings.regularSeams = regular.checked; this.scheduleRecompute('full'); } });
    const goreAxis = el('select', { onChange: () => { this.settings.goreAxis = goreAxis.value as any; this.scheduleRecompute('full'); } }, option('auto', 'Auto (flattest direction / Y)'), option('x', 'X axis'), option('y', 'Y axis'), option('z', 'Z axis'));
    const auto = el('input', { type: 'checkbox', checked: true, onChange: () => (this.autoUpdate = auto.checked) });
    const recompute = el('button', { class: 'primary', onClick: () => this.recompute('full') }, 'Recompute pattern');
    const reset = el('button', { onClick: () => { this.settings.forcedSeamEdges.clear(); this.settings.forbiddenSeamEdges.clear(); this.settings.seamTypeOverrides.clear(); this.settings.deletedHoles.clear(); this.settings.manualMode = false; this.recompute('full'); } }, 'Reset manual edits');

    // lists
    this.refs.pieces = el('div', { class: 'list' });
    this.refs.seams = el('div', { class: 'list' });

    // export
    const paper = el('select', {}, option('a4', 'A4 — 1:1 tiles to tape together', true), option('a3', 'A3 — 1:1 tiles'), option('a2', 'A2 — 1:1 tiles'), option('letter', 'US Letter — 1:1 tiles'), option('tabloid', 'Tabloid — 1:1 tiles'), option('fit', 'One large page (1:1, plotter)'));
    this.refs.paper = paper;
    const svgBtn = el('button', { class: 'primary', onClick: () => this.exportSvg() }, 'Export SVG');
    const pdfBtn = el('button', { class: 'primary', onClick: () => this.exportPdf() }, 'Export PDF');

    return el('aside', { class: 'left' },
      section('Model',
        labeled('Import 3D model', file, 'STL, OBJ, PLY, glTF/GLB. Or drag a file onto the 3D view.'),
        el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Sample shapes'), samples),
        el('div', { class: 'row' }, labeled('Model units', units), labeled('Longest dimension (mm)', longest)),
        this.refs.modelStats,
      ),
      section('Leather',
        el('div', { class: 'row' }, labeled('Animal', animal), labeled('Thickness', thickness)),
        labeled('Leather type', family),
        this.refs.familyDesc,
        this.refs.props,
        el('label', { class: 'row', style: { fontSize: '12px' } }, grooved, el('span', { style: { flex: 6 } }, 'Allow grooved / skived sharp folds in thick leather')),
      ),
      section('Pattern settings',
        el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Pattern style: faithful ↔ simple'), simplicity,
          el('div', { class: 'stages', style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--muted)' } }, el('span', {}, 'Many flat pieces, dry leather'), el('span', {}, 'Few big pieces, darts, wet-formed')),
          this.refs.simplicityLabel),
        labeled('Seam construction', seamType),
        labeled('The model surface represents the', surface, 'Bend allowance develops the neutral axis of the leather; thick leather patterns shrink on curves.'),
        el('div', { class: 'row' }, labeled('Crease angle (°)', crease, 'Dihedral above this is a fold/corner'), labeled('Stretch limit (%)', stretch)),
        el('div', { class: 'row' }, labeled('Stitches per inch', spi), labeled('Edge margin (mm)', margin), labeled('Allowance (mm)', allowance)),
        el('div', { class: 'row' }, labeled('Raw-edge hem (mm)', hem), labeled('Max auto cuts', maxSplits)),
        el('div', { class: 'row' }, el('label', { class: 'row', style: { fontSize: '12px', alignItems: 'center' } }, regular, el('span', { style: { flex: 6 } }, 'Regular seams: cut curved regions into equal gores')), labeled('Gore axis', goreAxis)),
        el('div', { class: 'row' }, labeled('Refine mesh to ≥ triangles', refine, 'Subdivides coarse models so cuts can follow smooth paths. More = slower.'), el('label', { class: 'row', style: { fontSize: '12px', alignItems: 'center' } }, smoothCb, el('span', { style: { flex: 6 } }, 'Smooth cut lines (corners kept)'))),
        el('div', { class: 'row' }, labeled('Sheet width (mm, 0 = auto)', sheetW), labeled('Piece gap (mm)', gap)),
        el('div', { class: 'row' }, recompute, reset),
        el('label', { class: 'row', style: { fontSize: '12px' } }, auto, el('span', { style: { flex: 6 } }, 'Recompute automatically when settings change')),
      ),
      section('Pieces', this.refs.pieces),
      section('Seams', this.refs.seams),
      section('Export',
        labeled('PDF paper', paper, 'Page 1: overview + specification. Then 1:1 tiles with overlap guides, crop marks and a scale bar, followed by making instructions (leather spec, tools, cutting, assembly order).'),
        el('div', { class: 'row' }, svgBtn, pdfBtn),
      ),
    );
  }

  private buildCenter(): HTMLElement {
    const viewport = el('div', { style: { position: 'absolute', inset: '0' } });
    this.refs.viewport = viewport;
    const toolBtn = (t: Tool, label: string, title: string) => {
      const b = el('button', { title, onClick: () => this.setTool(t) }, label);
      this.refs['tool_' + t] = b;
      return b;
    };
    const tip = el('div', { class: 'tip' });
    this.refs.tip = tip;
    const slider = el('input', { type: 'range', min: 0, max: 2, step: 0.001, value: 0, onInput: () => this.viewer.setExplode(parseFloat(slider.value)) });
    this.refs.slider = slider;
    const tog = (key: 'seams' | 'holes' | 'folds' | 'labels' | 'thread', label: string) => {
      const c = el('input', { type: 'checkbox', checked: true, onChange: () => this.viewer.setVisibility({ [key]: c.checked }) });
      return el('label', {}, c, label);
    };
    const empty = el('div', { class: 'empty' }, 'Import a model or choose a sample shape.\nThe 3D editor shows seams, stitch holes and folds; drag the slider to explode the model into its pattern.');
    this.refs.empty = empty;
    const drop = el('div', { class: 'dropzone' }, 'Drop a 3D model file');
    const center = el('main', { class: 'center' }, viewport, empty,
      el('div', { class: 'overlay-top' },
        el('div', { class: 'tools' }, toolBtn('select', 'Select', 'Click a piece or seam to inspect it'), toolBtn('cut', 'Cut', 'Drag across the model (or click two points) to add a seam along the shortest path'), toolBtn('move', 'Move', 'Drag a seam to re-route it through the pointer; its ends stay put'), toolBtn('points', 'Points', 'Click a seam to edit its points: drag, multi-select, delete, smooth'), toolBtn('holes', 'Holes', 'Click a stitch hole to remove it and its partner'), toolBtn('join', 'Join', 'Click a seam to remove it (pieces merge if the leather allows)'), toolBtn('seamtype', 'Seam type', 'Click a seam to toggle turned / butted')),
        tip,
        (this.refs.pointActions = el('div', { class: 'tools', style: { display: 'none' } },
          el('button', { title: 'Smooth the selected points (all interior points if none selected). Key: S', onClick: () => this.smoothPoints() }, 'Smooth'),
          el('button', { title: 'Remove the selected points. Key: Delete', onClick: () => this.deletePoints() }, 'Delete'),
          el('button', { title: 'Select every movable point. Key: A', onClick: () => this.selectAllPoints() }, 'Select all'),
          el('button', { title: 'Add more points along the seam', onClick: () => this.densifyPoints() }, 'More points'))),
        (this.refs.holeActions = el('div', { class: 'tools', style: { display: 'none' } },
          el('button', { title: 'Bring back every deleted stitch hole', onClick: () => { this.settings.deletedHoles.clear(); this.recompute('pattern'); } }, 'Restore holes')))),
      el('div', { class: 'overlay-bottom' },
        el('div', { class: 'col' }, slider, el('div', { class: 'stages' }, el('span', {}, 'Assembled'), el('span', {}, 'Exploded'), el('span', {}, 'Flat pattern'))),
        el('div', { class: 'toggles' }, tog('seams', 'Seams'), tog('holes', 'Holes'), tog('thread', 'Thread'), tog('folds', 'Folds'), tog('labels', 'Labels'))),
      drop);
    center.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('active'); });
    center.addEventListener('dragleave', () => drop.classList.remove('active'));
    center.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('active'); const f = e.dataTransfer?.files?.[0]; if (f) this.loadFile(f); });
    this.setTool('select');
    return center;
  }

  private buildRight(): HTMLElement {
    this.refs.previewHead = el('div', { class: 'preview-head' }, 'Pattern preview');
    this.refs.preview = el('div', { class: 'preview' });
    return el('aside', { class: 'right' }, this.refs.previewHead, this.refs.preview);
  }

  private buildStatus(): HTMLElement {
    this.refs.status = el('span', {});
    this.refs.warnings = el('span', { class: 'warn' });
    return el('footer', { class: 'status' }, this.refs.status, this.refs.warnings);
  }

  // ───────────────────────── model handling
  async loadFile(f: File): Promise<void> {
    try {
      this.setStatus(`Loading ${f.name}…`);
      const m = await loadModelFile(f);
      this.unitScale = UNIT_SCALE[m.unitsGuess];
      (this.refs.units as HTMLSelectElement).value = m.unitsGuess;
      this.setModel(m.mesh, f.name.replace(/\.[^.]+$/, ''), false);
    } catch (err) {
      this.setStatus(`Could not load file: ${(err as Error).message}`, true);
    }
  }

  setModel(mesh: TriMesh, name: string, resetUnits = true): void {
    this.rawModel = mesh;
    this.modelName = name;
    if (resetUnits) { this.unitScale = 1; (this.refs.units as HTMLSelectElement).value = 'mm'; }
    this.settings.forcedSeamEdges.clear(); this.settings.forbiddenSeamEdges.clear(); this.settings.seamTypeOverrides.clear(); this.settings.deletedHoles.clear(); this.settings.manualMode = false;
    this.cutStart = null;
    this.refs.empty.style.display = 'none';
    this.fitCameraNext = true;
    const bb = boundingBox(mesh);
    if (bb.maxDim * this.unitScale < 20) this.setStatus(`Model is only ${(bb.maxDim * this.unitScale).toFixed(2)} mm across in the assumed units; set the longest dimension if that is wrong.`);
    this.refreshModelStats();
    this.recompute('full');
  }

  private refreshModelStats(): void {
    if (!this.rawModel) return;
    const bb = boundingBox(this.rawModel);
    const s = this.unitScale;
    (this.refs.longest as HTMLInputElement).value = (bb.maxDim * s).toFixed(1);
    this.refs.modelStats.textContent = `${this.modelName}: ${this.rawModel.nf.toLocaleString()} triangles, ${this.rawModel.nv.toLocaleString()} vertices · ${(bb.size[0] * s).toFixed(1)} × ${(bb.size[1] * s).toFixed(1)} × ${(bb.size[2] * s).toFixed(1)} mm`;
  }

  private refreshSimplicityLabel(): void {
    const spec = this.spec;
    const eff = effectiveStretchLimit(spec, this.settings);
    const dry = this.settings.stretchLimitOverride ?? spec.stretchLimit;
    this.refs.simplicityLabel.textContent = eff > dry + 1e-6
      ? `Allows up to ${(eff * 100).toFixed(0)}% stretch (dry limit ${(dry * 100).toFixed(1)}%): pieces above the dry limit must be dampened / wet-formed while sewing. Pieces are merged and darts are preferred over splits.`
      : `Pieces flatten within the leather's dry stretch limit (${(dry * 100).toFixed(1)}%). Small pieces are merged into neighbours when the leather allows.`;
  }

  // ───────────────────────── leather UI
  private refreshLeatherUI(): void {
    const fam = this.family;
    const animal = this.refs.animal as HTMLSelectElement;
    animal.value = fam.animal;
    const family = this.refs.family as HTMLSelectElement;
    family.replaceChildren(...familiesFor(fam.animal).map((f) => option(f.id, f.name, f.id === fam.id)));
    const thick = this.refs.thickness as HTMLSelectElement;
    const opts = thicknessOptionsMm(fam);
    if (!opts.some((t) => Math.abs(t - this.thicknessMm) < 1e-6)) {
      // keep nearest available thickness
      this.thicknessMm = opts.reduce((a, b) => (Math.abs(b - this.thicknessMm) < Math.abs(a - this.thicknessMm) ? b : a), opts[0]);
    }
    thick.replaceChildren(...opts.map((t) => option(String(t), `${t.toFixed(2)} mm (${(Math.round(ozFromMm(t) * 2) / 2).toFixed(1)} oz)`, Math.abs(t - this.thicknessMm) < 1e-6)));
    this.refs.familyDesc.textContent = `${fam.description} Uses: ${fam.typicalUses}`;
    const s = this.spec;
    const row = (k: string, v: string) => el('tr', {}, el('td', {}, k), el('td', {}, v));
    this.refs.props.replaceChildren(
      row('Tannage / temper', `${fam.tannage} / ${fam.temper}`),
      row('Usable stretch', `${(s.stretchLimit * 100).toFixed(1)} %`),
      row('Min. bend radius', `${s.minBendRadiusMm.toFixed(1)} mm`),
      row('Sharp crease fold', s.canCreaseFold ? 'OK without grooving' : 'needs groove or seam'),
      row('Neutral axis depth', `${s.neutralAxisDepthMm.toFixed(2)} mm below grain`),
      row('Default seam', s.defaultSeamType === 'turned' ? 'turned' : 'butted / edge stitched'),
      row('Stitch pitch', `${s.stitchPitchMm.toFixed(2)} mm (${s.stitchesPerInch} SPI)`),
      row('Hole Ø / thread Ø', `${s.holeDiameterMm} / ${s.threadDiameterMm} mm`),
      row('Edge margin', `${s.edgeMarginMm} mm`),
      row('Turned allowance', `${s.seamAllowanceMm} mm`),
      row('Weight', `${s.gramsPerSquareMetre} g/m²`),
      row('Tear strength', `${Math.round(fam.tearStrength * 100)} % of firm cowhide`),
    );
    this.refreshSimplicityLabel();
  }

  // ───────────────────────── compute
  scheduleRecompute(level: 'full' | 'pattern'): void {
    if (!this.autoUpdate || !this.rawModel) return;
    this.recompute(level);
  }

  recompute(_level: 'full' | 'pattern'): void {
    const model = this.model;
    if (!model) return;
    if (this.computing) { this.pendingRecompute = true; return; }
    this.computing = true;
    this.setStatus('Computing pattern…');
    // let the status paint before the synchronous work
    requestAnimationFrame(() => setTimeout(() => {
      try {
        const t0 = performance.now();
        const res = runPipeline(model, this.spec, this.settings, (m) => this.setStatus(m));
        this.result = res;
        this.viewer.setResult(res, this.fitCameraNext);
        this.fitCameraNext = false;
        this.viewer.setExplode(parseFloat((this.refs.slider as HTMLInputElement).value));
        this.reattachEditor();
        this.refreshLists();
        this.refreshPreview();
        const ms = Math.round(performance.now() - t0);
        this.setStatus(`${res.pattern.pieces.length} pieces, ${res.pattern.seams.length} seams, ${res.pattern.pieces.reduce((s, p) => s + p.holes.length, 0)} stitch holes · ${(res.pattern.totalAreaMm2 / 100).toFixed(0)} cm² of ${this.spec.family.name} · ${ms} ms`);
        const warnings = [...res.warnings];
        const limit = effectiveStretchLimit(this.spec, this.settings);
        // pieces the leather physically cannot make
        const broken = new Map<number, string>();
        for (const p of res.pattern.pieces) {
          const reasons: string[] = [];
          if (!Number.isFinite(p.maxStrain) || p.patch.flat.area2D === 0) reasons.push('is a closed surface and cannot be flattened');
          if (p.flipped > 0) reasons.push('folds over itself when flattened');
          if (p.selfOverlap) reasons.push('overlaps itself when flat');
          if (p.maxStrain > MAX_FORMED_STRAIN) reasons.push(`would need ${(p.maxStrain * 100).toFixed(0)}% stretch, beyond even wet forming (${(MAX_FORMED_STRAIN * 100).toFixed(0)}%)`);
          if (reasons.length) broken.set(p.id, reasons.join(', '));
        }
        for (const e of res.seg.breakingEdges) {
          for (const f of [res.topo.edgeFaces[2 * e], res.topo.edgeFaces[2 * e + 1]]) {
            if (f < 0) continue;
            const pid = res.seg.faceToPatch[f];
            if (!broken.has(pid)) broken.set(pid, 'contains a fold the leather cannot make (see below)');
          }
        }
        const over = res.pattern.pieces.filter((p) => p.overStrained && !broken.has(p.id));
        if (broken.size) warnings.unshift(`BREAKS: ${Array.from(broken).map(([id, why]) => `piece ${res.pattern.pieces[id].name} ${why}`).join('; ')}. Move or add a seam there.`);
        if (over.length) warnings.push(`Over the ${(limit * 100).toFixed(1)}% stretch limit: ${over.map((p) => `${p.name} (${(p.maxStrain * 100).toFixed(0)}%)`).join(', ')}${this.settings.manualMode ? ' — move a seam, add a cut, or raise the limit' : ''}.`);
        if (this.settings.manualMode) warnings.push('Manual seam mode: your seams are kept as placed and automatic cutting is off. "Reset manual edits" returns to automatic.');
        const breaks = warnings.filter((w) => w.startsWith('BREAKS:'));
        const rest = warnings.filter((w) => !w.startsWith('BREAKS:'));
        this.refs.warnings.replaceChildren(
          ...(breaks.length ? [el('span', { class: 'err' }, '⚠ These edits break the leather: ' + breaks.map((w) => w.slice(8)).join(' '))] : []),
          rest.length ? el('span', {}, (breaks.length ? '  ·  ' : '') + rest.join('  ·  ')) : '',
        );
        this.refs.warnings.title = warnings.join('\n');
        this.viewer.setBroken(new Set(broken.keys()));
      } catch (err) {
        console.error(err);
        this.setStatus(`Error: ${(err as Error).message}`, true);
      } finally {
        this.computing = false;
        if (this.pendingRecompute) { this.pendingRecompute = false; this.recompute('full'); }
      }
    }, 0));
  }

  private refreshLists(): void {
    const res = this.result;
    if (!res) return;
    const { pieces, seams } = res.pattern;
    this.refs.pieces.replaceChildren(...pieces.map((pc) => el('div', { class: 'item' + (this.selectedPatch === pc.id ? ' selected' : ''), onClick: () => this.select(pc.id, null) },
      el('span', { class: 'swatch', style: { background: '#' + patchColor(pc.id).getHexString() } }),
      el('span', { class: 'grow' }, `${pc.name} · ${(pc.areaMm2 / 100).toFixed(1)} cm² · ${pc.holes.length} holes`),
      el('span', { class: pc.selfOverlap || pc.flipped > 0 || pc.maxStrain > MAX_FORMED_STRAIN ? 'err' : pc.overStrained ? 'warn' : '' }, `${(pc.maxStrain * 100).toFixed(1)}%${pc.selfOverlap || pc.flipped > 0 || pc.maxStrain > MAX_FORMED_STRAIN ? ' ✖ breaks' : pc.overStrained ? ' ⚠' : ''}${pc.tightBend ? ' ↻' : ''}`),
    )));
    this.refs.seams.replaceChildren(...seams.map((s) => {
      const sel = el('select', { onChange: (e: Event) => { e.stopPropagation(); this.setSeamType(s.id, sel.value as SeamType); }, onClick: (e: Event) => e.stopPropagation() }, option('turned', 'turned', s.type === 'turned'), option('butted', 'butted', s.type === 'butted'));
      return el('div', { class: 'item' + (this.selectedSeam === s.id ? ' selected' : ''), onClick: () => this.select(null, s.id) },
        el('span', { class: 'grow' }, `${s.isDart ? 'Dart D' : s.isClosure ? 'Closure J' : 'Seam '}${s.label}: ${pieces[s.sideA.patchId].name}${s.isDart || s.isClosure ? '' : ' ↔ ' + pieces[s.sideB.patchId].name} · ${s.length.toFixed(0)} mm · ${s.holeArc.length} holes`),
        sel);
    }));
  }

  private refreshPreview(): void {
    if (!this.result) return;
    const svg = exportSvg(this.result.pattern, { title: this.modelName });
    this.refs.preview.innerHTML = svg;
    const { w, h } = this.result.pattern.sheet;
    this.refs.previewHead.replaceChildren('Pattern preview · ', el('b', {}, `${w.toFixed(0)} × ${h.toFixed(0)} mm`), ` · ${this.result.pattern.pieces.length} pieces`);
  }

  select(patch: number | null, seam: number | null): void {
    this.selectedPatch = patch;
    this.selectedSeam = seam;
    this.viewer.highlight(patch, seam);
    this.refreshLists();
    if (this.result && seam !== null) {
      const s = this.result.pattern.seams[seam];
      const key = seamKey(s.origEdges);
      const forced = s.origEdges.every((e) => this.settings.forcedSeamEdges.has(e));
      this.setStatus(`Seam ${s.label}: ${s.type}${forced ? ' (manual)' : ''}, ${s.length.toFixed(1)} mm, ${s.holeArc.length} holes at ${s.pitch.toFixed(2)} mm, ${s.type === 'turned' ? `allowance ${s.allowanceMm} mm` : `holes inset ${s.insetMm} mm`}${s.isDart ? ' · dart sewn to itself' : ''} · key ${key}`);
    } else if (this.result && patch !== null) {
      const p = this.result.pattern.pieces[patch];
      this.setStatus(`Piece ${p.name}: ${p.patch.faces.length} faces, ${(p.areaMm2 / 100).toFixed(1)} cm², max strain ${(p.maxStrain * 100).toFixed(1)}% (limit ${((this.settings.stretchLimitOverride ?? this.spec.stretchLimit) * 100).toFixed(1)}%)${p.overStrained ? ' — exceeds the leather stretch limit' : ''}${p.tightBend ? ' — bends tighter than the leather allows' : ''}`);
    }
  }

  setSeamType(seamId: number, type: SeamType): void {
    if (!this.result) return;
    const s = this.result.pattern.seams[seamId];
    this.settings.seamTypeOverrides.set(seamKey(s.origEdges), type);
    this.recompute('pattern');
  }

  // ───────────────────────── tools
  setTool(t: Tool): void {
    this.tool = t;
    this.cutStart = null;
    this.viewer?.showPath([], []);
    for (const k of ['select', 'cut', 'move', 'points', 'holes', 'join', 'seamtype'] as Tool[]) this.refs['tool_' + k].classList.toggle('active', k === t);
    if (t !== 'points') this.stopEditingPoints();
    this.refs.pointActions.style.display = t === 'points' ? '' : 'none';
    this.refs.holeActions.style.display = t === 'holes' ? '' : 'none';
    if (this.viewer) this.viewer.pickHoles = t === 'holes';
    const tips: Record<Tool, string> = {
      select: 'Select: click a piece or a seam to inspect it. Drag to orbit, wheel to zoom, right-drag to pan.',
      cut: 'Cut: press on the model, drag, release (or click two points). A seam follows the shortest surface path; other seams stay where they are.',
      move: 'Move: press on a seam and drag. The seam re-routes through the pointer, keeping its two ends; release to apply. Right-drag orbits.',
      points: 'Points: click a seam to show its points. Click a point (shift-click to add), drag selected points together, Delete removes them, S smooths them, A selects all. Grey end points are junctions and stay fixed.',
      holes: 'Holes: click a stitch hole to delete it together with its matching hole on the other side of the seam. "Restore holes" brings them all back.',
      join: 'Join: click near a seam to remove it. If the merged piece exceeds the leather stretch limit it is flagged so you can place a better seam.',
      seamtype: 'Seam type: click near a seam to toggle it between turned (allowance added) and butted (holes inset from the cut edge).',
    };
    this.refs.tip.textContent = tips[t];
  }

  private onPick(p: PickInfo): void {
    if (!this.result) return;
    const size = boundingBox(this.result.topo.mesh).maxDim;
    const nearSeam = p.nearestSeam && p.nearestSeam.dist < size * 0.05 ? p.nearestSeam.id : null;
    switch (this.tool) {
      case 'select':
        this.select(nearSeam === null ? p.patchId : null, nearSeam);
        break;
      case 'holes': {
        if (!p.hole) { this.setStatus('Holes: click directly on a red stitch hole.'); break; }
        const seam = this.result.pattern.seams[p.hole.seamId];
        this.settings.deletedHoles.add(`${seamKey(seam.origEdges)}:${p.hole.index}`);
        this.setStatus(`Removed hole ${p.hole.index + 1} of seam ${seam.label} on both sides (${this.settings.deletedHoles.size} deleted).`);
        this.recompute('pattern');
        break;
      }
      case 'points': {
        if (p.handle !== undefined) { this.clickHandle(p.handle, !!p.shift); break; }
        if (nearSeam !== null) this.startEditingPoints(nearSeam);
        else this.stopEditingPoints();
        break;
      }
      case 'cut': {
        if (this.cutStart === null) {
          this.cutStart = p.vertex;
          this.viewer.showPath([], [p.vertex]);
          this.setStatus('Cut: now click the end point.');
        } else {
          const path = shortestEdgePath(this.result.topo, this.cutStart, p.vertex);
          if (!path.length) { this.setStatus('Cut: no path between those points.', true); this.cutStart = null; this.viewer.showPath([], []); return; }
          this.freezeSeams();
          for (const e of path) { this.settings.forcedSeamEdges.add(e); this.settings.forbiddenSeamEdges.delete(e); }
          this.cutStart = null;
          this.viewer.showPath([], []);
          this.recompute('full');
        }
        break;
      }
      case 'join': {
        if (nearSeam === null) { this.setStatus('Join: click closer to a seam line.'); return; }
        const s = this.result.pattern.seams[nearSeam];
        this.freezeSeams(s.id);
        for (const e of s.origEdges) { this.settings.forbiddenSeamEdges.add(e); this.settings.forcedSeamEdges.delete(e); }
        this.recompute('full');
        break;
      }
      case 'seamtype': {
        if (nearSeam === null) { this.setStatus('Seam type: click closer to a seam line.'); return; }
        const s = this.result.pattern.seams[nearSeam];
        this.setSeamType(s.id, s.type === 'turned' ? 'butted' : 'turned');
        break;
      }
    }
  }

  // ───────────────────────── drag editing
  private drag: { kind: 'cut'; start: number } | { kind: 'move'; seamId: number; a: number; b: number; oldEdges: number[] } | { kind: 'points'; primary: number; startVertex: number; startPos: Map<number, V3>; moved: boolean; shift: boolean } | null = null;
  private dragPath: number[] = [];
  /** seam point editing state (Points tool) */
  private edit: { seamId: number; handles: number[]; selected: Set<number>; pendingEdges: number[] | null } | null = null;
  private tentativeHandles: number[] | null = null;

  private vertexPos(v: number): V3 {
    const P = this.result!.topo.mesh.positions;
    return [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
  }

  private nearestVertex(p: V3): number {
    const P = this.result!.topo.mesh.positions;
    let best = 0, bd = Infinity;
    for (let v = 0; v < this.result!.topo.mesh.nv; v++) {
      const d = (P[3 * v] - p[0]) ** 2 + (P[3 * v + 1] - p[1]) ** 2 + (P[3 * v + 2] - p[2]) ** 2;
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  /** Handles for a seam: its shape-defining vertices (simplified chain), topped up to a usable density. */
  private chooseHandles(seamId: number): number[] {
    const seam = this.result!.pattern.seams[seamId];
    const verts = this.pathVertices(seam.origEdges);
    if (verts.length < 2) return verts;
    const pts = verts.map((v) => this.vertexPos(v));
    const lens: number[] = [];
    for (let i = 1; i < pts.length; i++) lens.push(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
    const median = lens.slice().sort((a, b) => a - b)[Math.floor(lens.length / 2)] || 1;
    const keep = new Set(simplifyIndices(pts, 1.5 * median));
    // top up so there is a handle at least every ~1/8 of the seam
    const target = Math.max(2, Math.min(verts.length, 9));
    if (keep.size < target) for (let k = 0; k < target; k++) keep.add(Math.round((k / (target - 1)) * (verts.length - 1)));
    return Array.from(keep).sort((a, b) => a - b).map((i) => verts[i]);
  }

  private startEditingPoints(seamId: number): void {
    this.edit = { seamId, handles: this.chooseHandles(seamId), selected: new Set(), pendingEdges: null };
    this.select(null, seamId);
    this.refreshHandles();
  }

  private stopEditingPoints(): void {
    if (!this.edit) return;
    this.edit = null;
    this.viewer?.setHandles([], new Set(), new Set());
  }

  private refreshHandles(): void {
    if (!this.edit) return;
    const n = this.edit.handles.length;
    this.viewer.setHandles(this.edit.handles, this.edit.selected, new Set([0, n - 1]));
  }

  private clickHandle(i: number, shift: boolean): void {
    if (!this.edit) return;
    const n = this.edit.handles.length;
    if (i === 0 || i === n - 1) { this.setStatus('End points are junctions with other seams and stay fixed.'); return; }
    if (shift) { if (this.edit.selected.has(i)) this.edit.selected.delete(i); else this.edit.selected.add(i); }
    else { this.edit.selected.clear(); this.edit.selected.add(i); }
    this.refreshHandles();
    this.setStatus(`${this.edit.selected.size} point(s) selected. Drag to move, Delete to remove, S to smooth.`);
  }

  private selectAllPoints(): void {
    if (!this.edit) return;
    for (let i = 1; i < this.edit.handles.length - 1; i++) this.edit.selected.add(i);
    this.refreshHandles();
  }

  private deletePoints(): void {
    if (!this.edit || !this.edit.selected.size) return;
    const n = this.edit.handles.length;
    this.edit.handles = this.edit.handles.filter((_, i) => i === 0 || i === n - 1 || !this.edit!.selected.has(i));
    this.edit.selected.clear();
    this.rebuildEditedSeam();
  }

  private smoothPoints(): void {
    if (!this.edit) return;
    const h = this.edit.handles;
    const n = h.length;
    if (n < 3) return;
    const targets = this.edit.selected.size ? Array.from(this.edit.selected) : Array.from({ length: n - 2 }, (_, i) => i + 1);
    const pos = h.map((v) => this.vertexPos(v));
    const next = h.slice();
    for (const i of targets) {
      if (i <= 0 || i >= n - 1) continue;
      const q: V3 = [0, 1, 2].map((k) => (pos[i - 1][k] + 2 * pos[i][k] + pos[i + 1][k]) / 4) as V3;
      next[i] = this.nearestVertex(q);
    }
    this.edit.handles = next;
    this.rebuildEditedSeam();
  }

  private densifyPoints(): void {
    if (!this.edit) return;
    const seam = this.result!.pattern.seams[this.edit.seamId];
    const verts = this.pathVertices(seam.origEdges);
    const idx = this.edit.handles.map((v) => verts.indexOf(v)).filter((i) => i >= 0).sort((a, b) => a - b);
    const out = new Set<number>(idx);
    for (let k = 0; k < idx.length - 1; k++) if (idx[k + 1] - idx[k] >= 2) out.add(Math.floor((idx[k] + idx[k + 1]) / 2));
    this.edit.handles = Array.from(out).sort((a, b) => a - b).map((i) => verts[i]);
    this.edit.selected.clear();
    this.refreshHandles();
  }

  /** Re-route the edited seam through its handles (shortest paths between consecutive handles). */
  private rebuildEditedSeam(): void {
    if (!this.edit || !this.result) return;
    const seam = this.result.pattern.seams[this.edit.seamId];
    const edges: number[] = [];
    const h = this.edit.handles;
    for (let i = 0; i < h.length - 1; i++) {
      if (h[i] === h[i + 1]) continue;
      const path = shortestEdgePath(this.result.topo, h[i], h[i + 1]);
      if (!path.length) { this.setStatus('Could not route the seam between two points.', true); return; }
      edges.push(...path);
    }
    if (!edges.length) return;
    this.freezeSeams(seam.id);
    for (const e of seam.origEdges) { this.settings.forcedSeamEdges.delete(e); this.settings.forbiddenSeamEdges.add(e); }
    for (const e of edges) { this.settings.forbiddenSeamEdges.delete(e); this.settings.forcedSeamEdges.add(e); }
    this.edit.pendingEdges = edges;
    this.recompute('full');
  }

  /** After a recompute, re-attach the editor to the rebuilt seam. */
  private reattachEditor(): void {
    if (!this.edit || !this.result) return;
    const target = this.edit.pendingEdges ? new Set(this.edit.pendingEdges) : new Set(this.result.pattern.seams[this.edit.seamId]?.origEdges ?? []);
    let best: { id: number; hits: number } | null = null;
    for (const s of this.result.pattern.seams) {
      let hits = 0;
      for (const e of s.origEdges) if (target.has(e)) hits++;
      if (hits && (!best || hits > best.hits)) best = { id: s.id, hits };
    }
    if (!best) { this.stopEditingPoints(); return; }
    this.edit.seamId = best.id;
    this.edit.pendingEdges = null;
    // keep only handles that still lie on the seam
    const onSeam = new Set(this.pathVertices(this.result.pattern.seams[best.id].origEdges));
    this.edit.handles = this.edit.handles.filter((v) => onSeam.has(v));
    if (this.edit.handles.length < 3) this.edit.handles = this.chooseHandles(best.id);
    this.edit.selected.clear();
    this.select(null, best.id);
    this.refreshHandles();
  }

  /** Pin every current seam so an edit changes only what the user touched. */
  private freezeSeams(exceptSeam: number | null = null): void {
    if (!this.result) return;
    this.settings.manualMode = true;
    for (const s of this.result.pattern.seams) {
      if (s.id === exceptSeam) continue;
      for (const e of s.origEdges) if (!this.settings.forbiddenSeamEdges.has(e)) this.settings.forcedSeamEdges.add(e);
    }
  }

  /** Ordered original vertices along an ordered edge list. */
  private pathVertices(edges: number[]): number[] {
    if (!this.result || !edges.length) return [];
    const ev = this.result.topo.edgeVerts;
    if (edges.length === 1) return [ev[2 * edges[0]], ev[2 * edges[0] + 1]];
    const shared = (e1: number, e2: number) => (ev[2 * e1] === ev[2 * e2] || ev[2 * e1] === ev[2 * e2 + 1] ? ev[2 * e1] : ev[2 * e1 + 1]);
    const first = shared(edges[0], edges[1]);
    const verts = [ev[2 * edges[0]] === first ? ev[2 * edges[0] + 1] : ev[2 * edges[0]], first];
    for (let i = 1; i < edges.length; i++) { const e = edges[i]; const prev = verts[verts.length - 1]; verts.push(ev[2 * e] === prev ? ev[2 * e + 1] : ev[2 * e]); }
    return verts;
  }

  private onDragStart(p: PickInfo): boolean {
    if (!this.result) return false;
    if (this.tool === 'points') {
      if (p.handle === undefined || !this.edit) return false;
      const n = this.edit.handles.length;
      if (p.handle === 0 || p.handle === n - 1) return false;
      // selection is decided on the first real move (or on release, as a click)
      this.drag = { kind: 'points', primary: p.handle, startVertex: this.edit.handles[p.handle], startPos: new Map(), moved: false, shift: !!p.shift };
      this.tentativeHandles = null;
      return true;
    }
    if (this.tool === 'cut') {
      this.drag = { kind: 'cut', start: p.vertex };
      this.dragPath = [];
      this.viewer.showPath([], [p.vertex]);
      return true;
    }
    if (this.tool === 'move') {
      const size = boundingBox(this.result.topo.mesh).maxDim;
      if (!p.nearestSeam || p.nearestSeam.dist > size * 0.05) return false;
      const seam = this.result.pattern.seams[p.nearestSeam.id];
      const verts = this.pathVertices(seam.origEdges);
      if (verts.length < 2) return false;
      this.drag = { kind: 'move', seamId: seam.id, a: verts[0], b: verts[verts.length - 1], oldEdges: seam.origEdges.slice() };
      this.select(null, seam.id);
      this.setStatus(`Moving seam ${seam.label}: drag to re-route it, release to apply.`);
      return true;
    }
    return false;
  }

  private onDragMove(p: PickInfo | null): void {
    if (!this.drag || !this.result || !p) return;
    if (this.drag.kind === 'points') {
      if (!this.edit || p.vertex < 0) return;
      const d = this.drag;
      if (p.vertex === d.startVertex && !d.moved) return;
      if (!d.moved) {
        // first real move: make sure the dragged handle is part of the selection
        if (!this.edit.selected.has(d.primary)) { if (!d.shift) this.edit.selected.clear(); this.edit.selected.add(d.primary); this.refreshHandles(); }
        for (const i of this.edit.selected) d.startPos.set(i, this.vertexPos(this.edit.handles[i]));
      }
      d.moved = true;
      const from = this.vertexPos(d.startVertex), to = this.vertexPos(p.vertex);
      const delta: V3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const handles = this.edit.handles.slice();
      for (const [i, sp] of d.startPos) handles[i] = i === d.primary ? p.vertex : this.nearestVertex([sp[0] + delta[0], sp[1] + delta[1], sp[2] + delta[2]]);
      this.tentativeHandles = handles;
      const verts: number[] = [];
      for (let i = 0; i < handles.length - 1; i++) {
        const path = shortestEdgePath(this.result.topo, handles[i], handles[i + 1]);
        const pv = this.pathVertices(path);
        verts.push(...(verts.length ? pv.slice(1) : pv));
      }
      this.viewer.showPath(verts, Array.from(d.startPos.keys()).map((i) => handles[i]));
      return;
    }
    if (this.drag.kind === 'cut') {
      this.dragPath = shortestEdgePath(this.result.topo, this.drag.start, p.vertex);
      this.viewer.showPath(this.pathVertices(this.dragPath), [this.drag.start, p.vertex]);
    } else {
      const { a, b } = this.drag;
      const p1 = shortestEdgePath(this.result.topo, a, p.vertex);
      const p2 = shortestEdgePath(this.result.topo, p.vertex, b);
      this.dragPath = [...p1, ...p2];
      this.viewer.showPath([...this.pathVertices(p1), ...this.pathVertices(p2).slice(1)], [a, p.vertex, b]);
    }
  }

  private onDragEnd(p: PickInfo | null): void {
    const d = this.drag;
    this.drag = null;
    this.viewer.showPath([], []);
    if (!d || !this.result) return;
    if (d.kind === 'points') {
      if (!this.edit) return;
      if (!d.moved || !this.tentativeHandles) { this.clickHandle(d.primary, !!(p && p.shift)); return; }
      this.edit.handles = this.tentativeHandles;
      this.tentativeHandles = null;
      this.rebuildEditedSeam();
      return;
    }
    if (d.kind === 'cut') {
      if (!p || p.vertex === d.start) {
        // treated as a click: fall back to the two-click flow
        this.cutStart = d.start;
        this.viewer.showPath([], [d.start]);
        this.setStatus('Cut: now click (or drag to) the end point.');
        return;
      }
      const path = this.dragPath.length ? this.dragPath : shortestEdgePath(this.result.topo, d.start, p.vertex);
      if (!path.length) { this.setStatus('Cut: no path between those points.', true); return; }
      this.freezeSeams();
      for (const e of path) { this.settings.forcedSeamEdges.add(e); this.settings.forbiddenSeamEdges.delete(e); }
      this.cutStart = null;
      this.recompute('full');
    } else {
      if (!p || !this.dragPath.length) { this.setStatus('Move cancelled.'); return; }
      this.freezeSeams(d.seamId);
      for (const e of d.oldEdges) { this.settings.forcedSeamEdges.delete(e); this.settings.forbiddenSeamEdges.add(e); }
      for (const e of this.dragPath) { this.settings.forbiddenSeamEdges.delete(e); this.settings.forcedSeamEdges.add(e); }
      this.recompute('full');
    }
  }

  // ───────────────────────── export
  exportSvg(): void {
    if (!this.result) return;
    const svg = exportSvg(this.result.pattern, { title: `${this.modelName} — ${this.spec.family.name} ${this.spec.thicknessMm} mm` });
    downloadBlob(`${this.modelName}-${this.familyId}-${this.thicknessMm}mm.svg`, new Blob([svg], { type: 'image/svg+xml' }));
  }

  exportPdf(): void {
    if (!this.result) return;
    const paper = (this.refs.paper as HTMLSelectElement).value as PaperSize;
    const doc = exportPdf(this.result.pattern, { paper, marginMm: 10, overlapMm: 10, title: `${this.modelName} leather pattern`, dryStretchLimit: this.settings.stretchLimitOverride ?? this.spec.stretchLimit, effectiveStretchLimit: effectiveStretchLimit(this.spec, this.settings), includeInstructions: true });
    doc.save(`${this.modelName}-${this.familyId}-${this.thicknessMm}mm.pdf`);
  }

  setStatus(msg: string, isError = false): void {
    this.refs.status.textContent = msg;
    this.refs.status.className = isError ? 'err' : '';
  }
}

const app = new App();
app.mount(document.getElementById('app')!);
(window as any).leatherApp = app;
void LEATHER_FAMILIES; void buildTopology; void orientMesh;
