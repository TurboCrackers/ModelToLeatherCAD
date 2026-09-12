import './style.css';
import { el, option, labeled, section, downloadBlob } from './ui/dom';
import { LEATHER_FAMILIES, familiesFor, getFamily, thicknessOptionsMm, ozFromMm, Animal, LeatherFamily } from './leather/database';
import { buildLeatherSpec, LeatherSpec, SpecOverrides, SeamType } from './leather/physics';
import { TriMesh, boundingBox, transformMesh, buildTopology, orientMesh } from './geometry/mesh';
import { loadModelFile } from './geometry/loaders';
import { makeBox, makeCylinder, makeSphere, makePouch, makeTorus } from './geometry/primitives';
import { shortestEdgePath } from './geometry/paths';
import { runPipeline, defaultPipelineSettings, PipelineResult, PipelineSettings, effectiveStretchLimit } from './pattern/pipeline';
import { seamKey } from './pattern/pattern';
import { exportSvg } from './export/svg';
import { exportPdf, PaperSize } from './export/pdf';
import { Viewer, PickInfo, patchColor } from './viewer/scene';

type Tool = 'select' | 'cut' | 'join' | 'seamtype';
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

  get spec(): LeatherSpec { return buildLeatherSpec(getFamily(this.familyId), this.thicknessMm, this.overrides); }
  get family(): LeatherFamily { return getFamily(this.familyId); }
  get model(): TriMesh | null { return this.rawModel ? transformMesh(this.rawModel, this.unitScale) : null; }

  mount(root: HTMLElement): void {
    root.append(this.buildHeader(), this.buildLeft(), this.buildCenter(), this.buildRight(), this.buildStatus());
    this.viewer = new Viewer(this.refs.viewport);
    this.viewer.onPick = (p) => this.onPick(p);
    this.refreshLeatherUI();
    this.setStatus('Load a model (STL, OBJ, PLY, glTF) or pick a sample shape to begin.');
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
    const units = el('select', { onChange: () => { this.unitScale = UNIT_SCALE[units.value]; this.refreshModelStats(); this.scheduleRecompute('full'); } }, ...['mm', 'cm', 'm', 'in'].map((u) => option(u, u, u === 'mm')));
    const longest = el('input', { type: 'number', step: 'any', min: 1, onChange: () => {
      if (!this.rawModel) return;
      const raw = boundingBox(this.rawModel).maxDim;
      const v = parseFloat(longest.value);
      if (v > 0 && raw > 0) { this.unitScale = v / raw; this.scheduleRecompute('full'); this.refreshModelStats(); }
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
    const reset = el('button', { onClick: () => { this.settings.forcedSeamEdges.clear(); this.settings.forbiddenSeamEdges.clear(); this.settings.seamTypeOverrides.clear(); this.recompute('full'); } }, 'Reset manual edits');

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
    const tog = (key: 'seams' | 'holes' | 'folds' | 'labels', label: string) => {
      const c = el('input', { type: 'checkbox', checked: true, onChange: () => this.viewer.setVisibility({ [key]: c.checked }) });
      return el('label', {}, c, label);
    };
    const empty = el('div', { class: 'empty' }, 'Import a model or choose a sample shape.\nThe 3D editor shows seams, stitch holes and folds; drag the slider to explode the model into its pattern.');
    this.refs.empty = empty;
    const drop = el('div', { class: 'dropzone' }, 'Drop a 3D model file');
    const center = el('main', { class: 'center' }, viewport, empty,
      el('div', { class: 'overlay-top' },
        el('div', { class: 'tools' }, toolBtn('select', 'Select', 'Click a piece or seam to inspect it'), toolBtn('cut', 'Cut', 'Click two points on the model to add a seam along the shortest path'), toolBtn('join', 'Join', 'Click a seam to remove it (pieces merge if the leather allows)'), toolBtn('seamtype', 'Seam type', 'Click a seam to toggle turned / butted')),
        tip),
      el('div', { class: 'overlay-bottom' },
        el('div', { class: 'col' }, slider, el('div', { class: 'stages' }, el('span', {}, 'Assembled'), el('span', {}, 'Exploded'), el('span', {}, 'Flat pattern'))),
        el('div', { class: 'toggles' }, tog('seams', 'Seams'), tog('holes', 'Holes'), tog('folds', 'Folds'), tog('labels', 'Labels'))),
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
    this.settings.forcedSeamEdges.clear(); this.settings.forbiddenSeamEdges.clear(); this.settings.seamTypeOverrides.clear();
    this.cutStart = null;
    this.refs.empty.style.display = 'none';
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
        this.viewer.setResult(res);
        this.viewer.setExplode(parseFloat((this.refs.slider as HTMLInputElement).value));
        this.refreshLists();
        this.refreshPreview();
        const ms = Math.round(performance.now() - t0);
        this.setStatus(`${res.pattern.pieces.length} pieces, ${res.pattern.seams.length} seams, ${res.pattern.pieces.reduce((s, p) => s + p.holes.length, 0)} stitch holes · ${(res.pattern.totalAreaMm2 / 100).toFixed(0)} cm² of ${this.spec.family.name} · ${ms} ms`);
        this.refs.warnings.textContent = res.warnings.join('  ·  ');
        this.refs.warnings.title = res.warnings.join('\n');
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
      el('span', { class: pc.overStrained ? 'warn' : '' }, `${(pc.maxStrain * 100).toFixed(1)}%${pc.overStrained ? ' ⚠' : ''}${pc.tightBend ? ' ↻' : ''}`),
    )));
    this.refs.seams.replaceChildren(...seams.map((s) => {
      const sel = el('select', { onChange: (e: Event) => { e.stopPropagation(); this.setSeamType(s.id, sel.value as SeamType); }, onClick: (e: Event) => e.stopPropagation() }, option('turned', 'turned', s.type === 'turned'), option('butted', 'butted', s.type === 'butted'));
      return el('div', { class: 'item' + (this.selectedSeam === s.id ? ' selected' : ''), onClick: () => this.select(null, s.id) },
        el('span', { class: 'grow' }, `${s.isDart ? 'Dart D' : 'Seam '}${s.label}: ${pieces[s.sideA.patchId].name}${s.isDart ? '' : ' ↔ ' + pieces[s.sideB.patchId].name} · ${s.length.toFixed(0)} mm · ${s.holeArc.length} holes`),
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
    for (const k of ['select', 'cut', 'join', 'seamtype'] as Tool[]) this.refs['tool_' + k].classList.toggle('active', k === t);
    const tips: Record<Tool, string> = {
      select: 'Select: click a piece or a seam to inspect it. Drag to orbit, wheel to zoom, right-drag to pan.',
      cut: 'Cut: click a start point, then an end point on the model. A seam is added along the shortest mesh path and the pattern recomputes.',
      join: 'Join: click near a seam to remove it. If the merged piece would exceed the leather stretch limit, it is cut again elsewhere.',
      seamtype: 'Seam type: click near a seam to toggle it between turned (allowance added) and butted (holes inset from the cut edge).',
    };
    this.refs.tip.textContent = tips[t];
  }

  private onPick(p: PickInfo): void {
    if (!this.result) return;
    const size = boundingBox(this.result.topo.mesh).maxDim;
    const nearSeam = p.nearestSeam && p.nearestSeam.dist < size * 0.03 ? p.nearestSeam.id : null;
    switch (this.tool) {
      case 'select':
        this.select(nearSeam === null ? p.patchId : null, nearSeam);
        break;
      case 'cut': {
        if (this.cutStart === null) {
          this.cutStart = p.vertex;
          this.viewer.showPath([], [p.vertex]);
          this.setStatus('Cut: now click the end point.');
        } else {
          const path = shortestEdgePath(this.result.topo, this.cutStart, p.vertex);
          if (!path.length) { this.setStatus('Cut: no path between those points.', true); this.cutStart = null; this.viewer.showPath([], []); return; }
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
