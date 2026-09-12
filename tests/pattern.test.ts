import { describe, it, expect } from 'vitest';
import { makeBox, makeSphere, makePouch } from '../src/geometry/primitives';
import { runPipeline, defaultPipelineSettings } from '../src/pattern/pipeline';
import { buildLeatherSpec } from '../src/leather/physics';
import { getFamily } from '../src/leather/database';
import { exportSvg } from '../src/export/svg';

function check(model: ReturnType<typeof makeBox>, familyId: string, tMm: number) {
  const spec = buildLeatherSpec(getFamily(familyId), tMm);
  const res = runPipeline(model, spec, defaultPipelineSettings());
  const { pattern } = res;
  // every seam has holes on both sides with the same count
  for (const seam of pattern.seams) {
    const a = pattern.pieces[seam.sideA.patchId].holes.filter((h) => h.seamId === seam.id).length;
    const b = pattern.pieces[seam.sideB.patchId].holes.filter((h) => h.seamId === seam.id).length;
    if (seam.isDart) expect(a).toBe(2 * seam.holeArc.length);
    else { expect(a).toBe(seam.holeArc.length); expect(b).toBe(seam.holeArc.length); }
    expect(seam.sideA.count).toBe(seam.origEdges.length);
    expect(seam.sideB.count).toBe(seam.origEdges.length);
  }
  // every boundary edge with a neighbour belongs to a seam
  for (const pc of pattern.pieces) for (const lp of pc.loops) for (const e of lp.edges) if (e.neighborPatch >= 0) expect(e.seamId).toBeGreaterThanOrEqual(0);
  expect(pattern.sheet.w).toBeGreaterThan(0);
  const svg = exportSvg(pattern, { title: 'test' });
  expect(svg.startsWith('<svg')).toBe(true);
  return res;
}

describe('pattern pipeline', () => {
  it('box in 3 mm veg-tan', () => {
    const r = check(makeBox(120, 80, 50), 'cow-veg-tan', 3.2);
    console.log('box veg pieces', r.pattern.pieces.length, 'seams', r.pattern.seams.length, 'sheet', r.pattern.sheet, r.warnings);
    expect(r.pattern.pieces.length).toBe(6);
  });
  it('box in 1 mm lamb (creased folds, darts)', () => {
    const r = check(makeBox(120, 80, 50), 'lamb-nappa', 0.9);
    console.log('box lamb pieces', r.pattern.pieces.length, 'seams', r.pattern.seams.length, 'darts', r.pattern.seams.filter((s) => s.isDart).length, r.warnings);
    expect(r.pattern.pieces.length).toBeLessThanOrEqual(3);
  });
  it('sphere in chrome cow', () => {
    const r = check(makeSphere(60, 32, 16), 'cow-chrome-garment', 1.2);
    console.log('sphere pieces', r.pattern.pieces.length, 'seams', r.pattern.seams.length, 'strain', r.pattern.pieces.map((p) => p.maxStrain.toFixed(3)), r.warnings);
  });
  it('pouch in bridle', () => {
    const r = check(makePouch(140, 90, 40, 12), 'cow-bridle', 2.4);
    console.log('pouch pieces', r.pattern.pieces.length, 'seams', r.pattern.seams.length, r.warnings);
  });
});
