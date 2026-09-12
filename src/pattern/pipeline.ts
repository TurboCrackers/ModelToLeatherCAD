import { TriMesh, buildTopology, orientMesh, offsetMesh, MeshTopology } from '../geometry/mesh';
import { segmentMesh, SegmentationResult, defaultSegmentationParams } from '../geometry/segmentation';
import { buildPattern, PatternSet, PatternOptions } from './pattern';
import { layoutPieces, LayoutOptions } from './layout';
import { LeatherSpec, SeamType } from '../leather/physics';

export type SurfaceMode = 'outer' | 'inner' | 'mid';

export interface PipelineSettings {
  surfaceMode: SurfaceMode;
  creaseAngleDeg: number;
  stretchLimitOverride: number | null;
  /**
   * 0 = faithful: dry leather, simple separate pieces. 1 = simplest pattern: few large pieces,
   * darts instead of splits, and strain up to what wet forming allows.
   */
  simplicity: number;
  maxSplits: number;
  seamType: SeamType | 'auto';
  seamTypeOverrides: Map<string, SeamType>;
  rawEdgeAllowanceMm: number;
  forcedSeamEdges: Set<number>;
  forbiddenSeamEdges: Set<number>;
  layout: LayoutOptions;
}

export const defaultPipelineSettings = (): PipelineSettings => ({
  surfaceMode: 'outer',
  creaseAngleDeg: 40,
  stretchLimitOverride: null,
  simplicity: 0,
  maxSplits: 150,
  seamType: 'auto',
  seamTypeOverrides: new Map(),
  rawEdgeAllowanceMm: 0,
  forcedSeamEdges: new Set(),
  forbiddenSeamEdges: new Set(),
  layout: { gapMm: 8, sheetWidthMm: 0, marginMm: 10 },
});

export interface PipelineResult {
  topo: MeshTopology;
  developed: Float64Array;
  seg: SegmentationResult;
  pattern: PatternSet;
  warnings: string[];
}

/** Wet forming lets leather take far more strain than the dry limit; the simplicity slider trades that in. */
export const MAX_FORMED_STRAIN = 0.45;
export function effectiveStretchLimit(spec: LeatherSpec, s: PipelineSettings): number {
  const base = s.stretchLimitOverride ?? spec.stretchLimit;
  const factor = 1 + 7 * Math.max(0, Math.min(1, s.simplicity)) ** 1.5;
  return Math.min(MAX_FORMED_STRAIN, base * factor);
}

/** Model (mm) → developed neutral surface → segmentation → pattern → layout. */
export function runPipeline(model: TriMesh, spec: LeatherSpec, s: PipelineSettings, onProgress?: (m: string) => void): PipelineResult {
  onProgress?.('Building topology…');
  const topo = buildTopology(orientMesh(model));
  // Develop the neutral surface: the model is assumed to be the OUTER (grain)
  // surface by default, so the neutral axis sits inward.
  const depth = s.surfaceMode === 'outer' ? -spec.neutralAxisDepthMm : s.surfaceMode === 'inner' ? spec.thicknessMm - spec.neutralAxisDepthMm : 0;
  const developed = offsetMesh(topo, depth).positions;
  const params = {
    ...defaultSegmentationParams(developed),
    minBendRadiusMm: spec.minBendRadiusMm,
    canCreaseFold: spec.canCreaseFold,
    creaseAngleDeg: s.creaseAngleDeg,
    stretchLimit: effectiveStretchLimit(spec, s),
    preferDarts: s.simplicity >= 0.35,
    mergePieces: true,
    maxSplits: s.maxSplits,
    forcedSeamEdges: s.forcedSeamEdges,
    forbiddenSeamEdges: s.forbiddenSeamEdges,
    onProgress,
  };
  const seg = segmentMesh(topo, params);
  onProgress?.('Placing seams and stitch holes…');
  const popts: PatternOptions = {
    defaultSeamType: s.seamType === 'auto' ? spec.defaultSeamType : s.seamType,
    seamTypeOverrides: s.seamTypeOverrides,
    rawEdgeAllowanceMm: s.rawEdgeAllowanceMm,
  };
  const pattern = buildPattern(topo, seg, developed, topo.mesh.positions, spec, popts);
  layoutPieces(pattern, s.layout);
  return { topo, developed, seg, pattern, warnings: [...seg.warnings, ...pattern.warnings] };
}
