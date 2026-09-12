import { describe, it, expect } from 'vitest';
import { makeBox, makeCylinder, makeSphere } from '../src/geometry/primitives';
import { buildTopology, orientMesh } from '../src/geometry/mesh';
import { flattenPatch } from '../src/geometry/flatten';
import { segmentMesh, defaultSegmentationParams } from '../src/geometry/segmentation';

describe('flatten', () => {
  it('flattens an open cylinder wall to a rectangle with negligible strain', () => {
    const m = orientMesh(makeCylinder(20, 60, 48, false));
    const topo = buildTopology(m);
    const faces = Array.from({ length: m.nf }, (_, i) => i);
    // a closed tube cannot flatten; cut one column of faces out to open it
    const open = faces.filter((f) => f >= 2);
    const r = flattenPatch(topo, m.positions, open);
    expect(r.flippedFaces).toBe(0);
    expect(r.maxStrain).toBeLessThan(0.01);
    expect(Math.abs(r.area2D - r.area3D) / r.area3D).toBeLessThan(0.01);
  });
});

describe('segmentation', () => {
  it('cuts a box into 6 faces in thick veg-tan and fewer in thin chrome leather', () => {
    const m = orientMesh(makeBox(100, 60, 40));
    const topo = buildTopology(m);
    const thick = segmentMesh(topo, { ...defaultSegmentationParams(m.positions), canCreaseFold: false, stretchLimit: 0.03 });
    expect(thick.patches.length).toBe(6);
    const thin = segmentMesh(topo, { ...defaultSegmentationParams(m.positions), canCreaseFold: true, stretchLimit: 0.1 });
    // creased folds allowed: a box unfolds into a couple of nets with darts, not 6 panels
    expect(thin.patches.length).toBeGreaterThanOrEqual(1);
    expect(thin.patches.length).toBeLessThanOrEqual(3);
    console.log('box thin pieces', thin.patches.length, 'splits', thin.splits, thin.patches.map(p=>[p.faces.length, p.flat.maxStrain.toFixed(4)]));
    for (const p of thin.patches) expect(p.overStrained).toBe(false);
  });
  it('splits a sphere into more pieces for stiffer leather', () => {
    const m = orientMesh(makeSphere(50, 32, 16));
    const topo = buildTopology(m);
    const stiff = segmentMesh(topo, { ...defaultSegmentationParams(m.positions), stretchLimit: 0.03, minBendRadiusMm: 3 });
    const soft = segmentMesh(topo, { ...defaultSegmentationParams(m.positions), stretchLimit: 0.15, minBendRadiusMm: 1 });
    console.log('sphere pieces stiff/soft', stiff.patches.length, soft.patches.length, 'splits', stiff.splits, soft.splits, stiff.warnings, soft.warnings);
    expect(stiff.patches.length).toBeGreaterThan(soft.patches.length);
    expect(soft.patches.filter((p) => p.overStrained).length).toBe(0);
  });
  it('flags a tight cylinder in thick leather', () => {
    const m = orientMesh(makeCylinder(3, 40, 24, false));
    const topo = buildTopology(m);
    const r = segmentMesh(topo, { ...defaultSegmentationParams(m.positions), minBendRadiusMm: 8 });
    expect(r.warnings.some((w) => w.includes('tighter'))).toBe(true);
  });
});
