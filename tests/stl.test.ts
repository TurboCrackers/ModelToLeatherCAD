import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { weldMesh, transformMesh, boundingBox } from '../src/geometry/mesh';
import { runPipeline, defaultPipelineSettings } from '../src/pattern/pipeline';
import { buildLeatherSpec } from '../src/leather/physics';
import { getFamily } from '../src/leather/database';
import { exportSvg } from '../src/export/svg';
import { exportPdf } from '../src/export/pdf';
import { polygonSelfIntersects } from '../src/pattern/geometry2d';

describe('Untitled.stl from the repo', () => {
  it('imports, scales to 120 mm and produces a sewable pattern in chrome cowhide', () => {
    const buf = readFileSync('Untitled.stl');
    const geom = new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const pos = geom.getAttribute('position');
    const raw = weldMesh(Array.from(pos.array as Float32Array));
    expect(raw.nf).toBe(960);
    const bb = boundingBox(raw);
    const model = transformMesh(raw, 120 / bb.maxDim);
    const spec = buildLeatherSpec(getFamily('cow-chrome-garment'), 1.2);
    const t0 = performance.now();
    const res = runPipeline(model, spec, defaultPipelineSettings());
    const ms = performance.now() - t0;
    const { pattern } = res;
    console.log('Untitled.stl →', pattern.pieces.length, 'pieces', pattern.seams.length, 'seams', pattern.pieces.reduce((s, p) => s + p.holes.length, 0), 'holes', Math.round(ms), 'ms', res.warnings);
    expect(pattern.pieces.length).toBeGreaterThan(1);
    expect(pattern.pieces.every((p) => !p.overStrained)).toBe(true);
    for (const pc of pattern.pieces) for (const o of pc.cutOutlines) expect(polygonSelfIntersects(o)).toBe(false);
    const svg = exportSvg(pattern, { title: 'Untitled' });
    expect(svg.length).toBeGreaterThan(1000);
    const pdf = exportPdf(pattern, { paper: 'a4', marginMm: 10, overlapMm: 10, title: 'Untitled', dryStretchLimit: spec.stretchLimit, effectiveStretchLimit: spec.stretchLimit });
    const pages = pdf.getNumberOfPages();
    console.log('pdf pages', pages);
    expect(pages).toBeGreaterThan(2);
  });
});
