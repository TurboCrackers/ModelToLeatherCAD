import { it } from 'vitest';
import { makeSphere } from '../src/geometry/primitives';
import { runPipeline, defaultPipelineSettings } from '../src/pattern/pipeline';
import { buildLeatherSpec } from '../src/leather/physics';
import { getFamily } from '../src/leather/database';
it('perf 64x32 sphere', () => {
  const spec = buildLeatherSpec(getFamily('cow-veg-tan'), 2.0);
  const t0 = performance.now();
  const r = runPipeline(makeSphere(80, 64, 32), spec, defaultPipelineSettings());
  console.log('perf: faces', r.topo.mesh.nf, 'pieces', r.pattern.pieces.length, 'cuts', r.seg.splits, Math.round(performance.now() - t0), 'ms', r.warnings);
});
