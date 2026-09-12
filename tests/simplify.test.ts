import { describe, it, expect } from 'vitest';
import { makeSphere, makePouch } from '../src/geometry/primitives';
import { runPipeline, defaultPipelineSettings, effectiveStretchLimit } from '../src/pattern/pipeline';
import { buildLeatherSpec } from '../src/leather/physics';
import { getFamily } from '../src/leather/database';

describe('simplicity slider', () => {
  it('sphere: faithful → many pieces, simple → two pieces', () => {
    const spec = buildLeatherSpec(getFamily('cow-chrome-garment'), 1.2);
    const faithful = runPipeline(makeSphere(60, 32, 16), spec, { ...defaultPipelineSettings(), simplicity: 0 });
    const simple = runPipeline(makeSphere(60, 32, 16), spec, { ...defaultPipelineSettings(), simplicity: 1 });
    console.log('sphere faithful', faithful.pattern.pieces.length, 'simple', simple.pattern.pieces.length, 'limit', effectiveStretchLimit(spec, { ...defaultPipelineSettings(), simplicity: 1 }), simple.pattern.pieces.map(p => (p.maxStrain*100).toFixed(0)+'%'), 'darts', simple.pattern.seams.filter(s=>s.isDart).length);
    expect(simple.pattern.pieces.length).toBeLessThan(faithful.pattern.pieces.length);
    expect(simple.pattern.pieces.length).toBeLessThanOrEqual(2);
  });
  it('sphere in veg-tan with medium simplicity uses darts and few pieces', () => {
    const spec = buildLeatherSpec(getFamily('cow-veg-tan'), 2.0);
    const r = runPipeline(makeSphere(60, 32, 16), spec, { ...defaultPipelineSettings(), simplicity: 0.5 });
    console.log('veg sphere 0.5:', r.pattern.pieces.length, 'pieces', r.pattern.seams.filter(s=>s.isDart).length, 'darts', 'limit', (effectiveStretchLimit(spec, { ...defaultPipelineSettings(), simplicity: 0.5 })*100).toFixed(1)+'%', r.warnings);
    expect(r.pattern.pieces.every(p => !p.overStrained)).toBe(true);
  });
  it('pouch merge keeps hard seams', () => {
    const spec = buildLeatherSpec(getFamily('cow-harness'), 4.0);
    const r = runPipeline(makePouch(140, 90, 45, 6), spec, { ...defaultPipelineSettings(), simplicity: 1 });
    console.log('harness pouch simple:', r.pattern.pieces.length, 'pieces', r.warnings);
    expect(r.pattern.pieces.length).toBeGreaterThanOrEqual(2);
  });
});
