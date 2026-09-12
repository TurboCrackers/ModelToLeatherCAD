import { LeatherFamily, ozFromMm } from './database';

export type SeamType = 'turned' | 'butted';

/** Everything the pattern generator needs to know about a specific leather at a specific thickness. */
export interface LeatherSpec {
  family: LeatherFamily;
  thicknessMm: number;
  thicknessOz: number;
  /** Max usable in-plane strain, as a fraction (0.05 = 5%). */
  stretchLimit: number;
  /** Minimum inside radius (mm) the leather bends to along a smooth curve. */
  minBendRadiusMm: number;
  /** Whether a sharp crease fold (radius ≈ 0) is acceptable without grooving. */
  canCreaseFold: boolean;
  /** Neutral axis offset from the grain (outer) surface, mm. Pattern is developed at this depth. */
  neutralAxisDepthMm: number;
  /** Default seam construction. */
  defaultSeamType: SeamType;
  /** Stitches per inch and the resulting hole pitch. */
  stitchesPerInch: number;
  stitchPitchMm: number;
  /** Distance of the stitch line from a cut edge (butted seams), mm. */
  edgeMarginMm: number;
  /** Extra material added outside a turned seam's stitch line, mm. */
  seamAllowanceMm: number;
  /** Round/awl hole diameter and suggested thread diameter, mm. */
  holeDiameterMm: number;
  threadDiameterMm: number;
  /** Approx. weight per square metre, grams. */
  gramsPerSquareMetre: number;
}

export interface SpecOverrides {
  stretchLimit?: number;
  stitchesPerInch?: number;
  edgeMarginMm?: number;
  seamAllowanceMm?: number;
  allowGroovedFolds?: boolean;
  seamType?: SeamType | 'auto';
}

export function buildLeatherSpec(family: LeatherFamily, thicknessMm: number, o: SpecOverrides = {}): LeatherSpec {
  const t = Math.min(Math.max(thicknessMm, family.thicknessRangeMm[0]), family.thicknessRangeMm[1]);

  const stretchLimit = o.stretchLimit ?? family.stretchBase / (1 + family.stretchFalloff * Math.max(0, t - 1));
  const minBendRadiusMm = Math.max(0.3, family.bendRadiusFactor * t);
  const canCreaseFold = !!o.allowGroovedFolds || t <= family.creaseFoldLimitMm;
  const neutralAxisDepthMm = (1 - family.neutralAxisFactor) * t;

  // Stitch pitch: thin leather takes fine stitching, heavy leather coarse.
  // Weak (tear-prone) leathers get a wider pitch so the holes do not link up.
  let spi: number;
  if (t <= 0.9) spi = 10;
  else if (t <= 1.4) spi = 9;
  else if (t <= 2.0) spi = 8;
  else if (t <= 2.8) spi = 7;
  else if (t <= 3.6) spi = 6;
  else if (t <= 4.4) spi = 5;
  else spi = 4;
  if (family.tearStrength < 0.7) spi = Math.max(3, spi - 1);
  spi = o.stitchesPerInch ?? spi;
  const stitchPitchMm = 25.4 / spi;

  // Thread & hole sizing follow thickness.
  let threadDiameterMm: number;
  if (t <= 1.2) threadDiameterMm = 0.45;
  else if (t <= 2.0) threadDiameterMm = 0.6;
  else if (t <= 3.2) threadDiameterMm = 0.8;
  else if (t <= 4.5) threadDiameterMm = 1.0;
  else threadDiameterMm = 1.2;
  const holeDiameterMm = Math.round(threadDiameterMm * 1.6 * 100) / 100;

  // Stitch line offset from the cut edge; roughly 1.2×thickness + 1.5 mm, never
  // less than 2.5 mm, and never closer than 1.5 hole diameters.
  const edgeMarginMm = o.edgeMarginMm ?? Math.max(2.5, 1.5 * holeDiameterMm, Math.round((1.2 * t + 1.5) * 10) / 10);

  // Turned seams need enough allowance to grip while sewing and to turn cleanly.
  const seamAllowanceMm = o.seamAllowanceMm ?? Math.round(Math.max(4, 3.5 + 1.5 * t) * 10) / 10;

  const defaultSeamType: SeamType =
    o.seamType && o.seamType !== 'auto' ? o.seamType : t <= family.turnedSeamMaxMm ? 'turned' : 'butted';

  return {
    family,
    thicknessMm: t,
    thicknessOz: Math.round(ozFromMm(t) * 10) / 10,
    stretchLimit,
    minBendRadiusMm,
    canCreaseFold,
    neutralAxisDepthMm,
    defaultSeamType,
    stitchesPerInch: spi,
    stitchPitchMm,
    edgeMarginMm,
    seamAllowanceMm,
    holeDiameterMm,
    threadDiameterMm,
    gramsPerSquareMetre: Math.round(family.density * t * 1000),
  };
}

/**
 * Given a mesh edge with dihedral angle `theta` (radians, 0 = flat) and the
 * width `h` (mm) of the surface strip the angle is spread over, estimate the
 * radius of the physical bend. For a finely tessellated cylinder h/theta → R.
 */
export function estimateBendRadius(theta: number, h: number): number {
  if (theta < 1e-6) return Infinity;
  return h / theta;
}
