import { describe, it, expect } from 'vitest';
import { makeSphere, makeTorus } from '../src/geometry/primitives';
import { runPipeline, defaultPipelineSettings } from '../src/pattern/pipeline';
import { buildLeatherSpec } from '../src/leather/physics';
import { getFamily } from '../src/leather/database';

describe('regular gores', () => {
  it('sphere in chrome cow becomes equal gores', () => {
    const spec = buildLeatherSpec(getFamily('cow-chrome-garment'), 1.2);
    const t0 = performance.now();
    const r = runPipeline(makeSphere(60, 32, 16), spec, defaultPipelineSettings());
    const areas = r.pattern.pieces.map((p) => p.areaMm2);
    const mean = areas.reduce((a, b) => a + b, 0) / areas.length;
    const cv = Math.sqrt(areas.reduce((a, b) => a + (b - mean) ** 2, 0) / areas.length) / mean;
    console.log('gores', r.pattern.pieces.length, 'area cv', cv.toFixed(3), 'strain', r.pattern.pieces.map((p) => (p.maxStrain * 100).toFixed(1)), Math.round(performance.now() - t0), 'ms', r.warnings);
    expect(cv).toBeLessThan(0.25);
    expect(r.pattern.pieces.every((p) => !p.overStrained)).toBe(true);
  });
  it('torus in veg-tan gets regular sectors', () => {
    const spec = buildLeatherSpec(getFamily('cow-veg-tan'), 1.6);
    const t0 = performance.now();
    const r = runPipeline(makeTorus(60, 22, 20, 40), spec, defaultPipelineSettings());
    console.log('torus pieces', r.pattern.pieces.length, Math.round(performance.now() - t0), 'ms', r.warnings);
    expect(r.pattern.pieces.length).toBeGreaterThan(2);
  });
});
