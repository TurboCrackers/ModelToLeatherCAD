/**
 * Leather catalogue.
 *
 * Every family below carries the coefficients needed to derive the physical
 * behaviour of the leather at ANY thickness inside its available range. The
 * numbers are engineering estimates distilled from leathercraft practice
 * (saddlery, bag making, garment work) and published leather test ranges; they
 * are deliberately conservative. Adjust a family here and every downstream
 * calculation (bend radius, stretch tolerance, stitch pitch, seam type) follows.
 *
 * Units: thickness in millimetres. 1 oz = 1/64 in = 0.397 mm.
 */

export type Animal = 'cow' | 'sheep' | 'lamb';
export type Tannage = 'vegetable' | 'chrome' | 'combination' | 'oil' | 'alum';
export type Temper = 'soft' | 'medium' | 'firm' | 'stiff';

export interface LeatherFamily {
  id: string;
  name: string;
  animal: Animal;
  tannage: Tannage;
  temper: Temper;
  description: string;
  typicalUses: string;
  /** Available thickness range in mm (inclusive). */
  thicknessRangeMm: [number, number];
  /** Bulk density g/cm³ (for weight estimates). */
  density: number;
  /**
   * Usable in-plane strain (fraction) at 1 mm thickness before the leather
   * either refuses to conform or takes permanent distortion / wrinkles.
   * Thicker leather stretches less: strain(t) = base * (1 / (1 + falloff*(t-1)))
   */
  stretchBase: number;
  stretchFalloff: number;
  /**
   * Minimum inside bend radius as a multiple of thickness for a dry, unlined
   * piece bent along a smooth curve (grain out) without cracking / heavy
   * wrinkling. Veg-tan is stiff (2–3×), soft chrome is forgiving (~0.5–1×).
   */
  bendRadiusFactor: number;
  /**
   * Maximum thickness (mm) that can take a sharp crease fold (radius ≈ 0)
   * without grooving or skiving. Above this a sharp corner needs a seam
   * unless the user enables grooved folds.
   */
  creaseFoldLimitMm: number;
  /**
   * Position of the neutral axis through the thickness when bent (0 = inner
   * surface, 1 = outer/grain). Fibrous compressible materials sit below 0.5.
   */
  neutralAxisFactor: number;
  /**
   * Maximum thickness that can be turned (sewn inside out and reversed).
   * Above this seams default to butted/edge stitched.
   */
  turnedSeamMaxMm: number;
  /** Relative tear strength (1 = firm full-grain cowhide). Lower → wider stitch pitch. */
  tearStrength: number;
  /** Standard thicknesses commonly sold, in oz. */
  standardOz: number[];
}

const oz = (from: number, to: number, step = 1): number[] => {
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
};

export const OZ_TO_MM = 0.396875;
export const mmFromOz = (o: number): number => o * OZ_TO_MM;
export const ozFromMm = (mm: number): number => mm / OZ_TO_MM;

export const LEATHER_FAMILIES: LeatherFamily[] = [
  // ───────────────────────── COW ─────────────────────────
  {
    id: 'cow-veg-tan',
    name: 'Vegetable-tanned cowhide (tooling)',
    animal: 'cow', tannage: 'vegetable', temper: 'firm',
    description: 'Classic bark-tanned hide. Firm, holds tooling and moulding, cracks if bent tight while dry.',
    typicalUses: 'Wallets, belts, sheaths, holsters, moulded cases.',
    thicknessRangeMm: [0.6, 5.6], density: 0.95,
    stretchBase: 0.045, stretchFalloff: 0.35,
    bendRadiusFactor: 2.5, creaseFoldLimitMm: 1.6, neutralAxisFactor: 0.44,
    turnedSeamMaxMm: 1.4, tearStrength: 1.0,
    standardOz: oz(2, 14),
  },
  {
    id: 'cow-bridle',
    name: 'Bridle leather',
    animal: 'cow', tannage: 'vegetable', temper: 'firm',
    description: 'Veg-tan stuffed with waxes and tallow. Dense, slightly more supple than plain veg-tan.',
    typicalUses: 'Belts, straps, bridles, structured bags.',
    thicknessRangeMm: [1.2, 5.2], density: 1.0,
    stretchBase: 0.035, stretchFalloff: 0.30,
    bendRadiusFactor: 2.0, creaseFoldLimitMm: 2.0, neutralAxisFactor: 0.45,
    turnedSeamMaxMm: 1.4, tearStrength: 1.05,
    standardOz: oz(3, 13),
  },
  {
    id: 'cow-harness',
    name: 'Harness leather',
    animal: 'cow', tannage: 'vegetable', temper: 'stiff',
    description: 'Heavily hot-stuffed veg-tan for load bearing. Very stiff, minimal stretch.',
    typicalUses: 'Harness, heavy straps, saddlery.',
    thicknessRangeMm: [2.0, 5.6], density: 1.02,
    stretchBase: 0.028, stretchFalloff: 0.30,
    bendRadiusFactor: 2.6, creaseFoldLimitMm: 1.6, neutralAxisFactor: 0.45,
    turnedSeamMaxMm: 1.2, tearStrength: 1.1,
    standardOz: oz(5, 14),
  },
  {
    id: 'cow-latigo',
    name: 'Latigo',
    animal: 'cow', tannage: 'combination', temper: 'medium',
    description: 'Combination tanned and heavily oiled/waxed. Weather resistant, more flexible than veg-tan.',
    typicalUses: 'Saddle strings, straps, rugged bags.',
    thicknessRangeMm: [1.2, 4.8], density: 0.98,
    stretchBase: 0.065, stretchFalloff: 0.30,
    bendRadiusFactor: 1.5, creaseFoldLimitMm: 2.4, neutralAxisFactor: 0.45,
    turnedSeamMaxMm: 1.8, tearStrength: 1.0,
    standardOz: oz(3, 12),
  },
  {
    id: 'cow-pullup',
    name: 'Pull-up / Chromexcel-type (combination)',
    animal: 'cow', tannage: 'combination', temper: 'medium',
    description: 'Combination tanned, hot stuffed with oils and waxes. Supple with good body.',
    typicalUses: 'Bags, boots, wallets, watch straps.',
    thicknessRangeMm: [0.8, 3.2], density: 0.96,
    stretchBase: 0.085, stretchFalloff: 0.28,
    bendRadiusFactor: 1.2, creaseFoldLimitMm: 2.4, neutralAxisFactor: 0.46,
    turnedSeamMaxMm: 2.0, tearStrength: 0.95,
    standardOz: oz(2, 8),
  },
  {
    id: 'cow-chrome-garment',
    name: 'Chrome-tanned cowhide (garment / upholstery)',
    animal: 'cow', tannage: 'chrome', temper: 'soft',
    description: 'Mineral tanned, soft and elastic. Bends tight without damage, does not hold moulding.',
    typicalUses: 'Jackets, upholstery, soft bags, linings.',
    thicknessRangeMm: [0.6, 2.4], density: 0.88,
    stretchBase: 0.13, stretchFalloff: 0.25,
    bendRadiusFactor: 0.8, creaseFoldLimitMm: 3.0, neutralAxisFactor: 0.47,
    turnedSeamMaxMm: 2.2, tearStrength: 0.9,
    standardOz: oz(1.5, 6, 0.5),
  },
  {
    id: 'cow-oil-tan',
    name: 'Oil-tanned cowhide',
    animal: 'cow', tannage: 'oil', temper: 'medium',
    description: 'Chrome retanned and saturated with oils. Pliable, water resistant, matte surface.',
    typicalUses: 'Work boots, tool rolls, bags.',
    thicknessRangeMm: [1.0, 3.6], density: 0.94,
    stretchBase: 0.09, stretchFalloff: 0.28,
    bendRadiusFactor: 1.0, creaseFoldLimitMm: 2.6, neutralAxisFactor: 0.46,
    turnedSeamMaxMm: 2.0, tearStrength: 0.95,
    standardOz: oz(3, 9),
  },
  {
    id: 'cow-nubuck',
    name: 'Cowhide nubuck',
    animal: 'cow', tannage: 'chrome', temper: 'soft',
    description: 'Chrome tanned full grain buffed to a nap. Behaves like soft chrome leather.',
    typicalUses: 'Shoes, bags, garments.',
    thicknessRangeMm: [0.8, 2.4], density: 0.86,
    stretchBase: 0.10, stretchFalloff: 0.25,
    bendRadiusFactor: 0.9, creaseFoldLimitMm: 3.0, neutralAxisFactor: 0.47,
    turnedSeamMaxMm: 2.2, tearStrength: 0.85,
    standardOz: oz(2, 6),
  },
  {
    id: 'cow-suede-split',
    name: 'Cowhide suede (split)',
    animal: 'cow', tannage: 'chrome', temper: 'soft',
    description: 'Flesh split of the hide. Loose fibre structure: stretchy but tears easily; needs a wider stitch pitch.',
    typicalUses: 'Linings, garments, pouches.',
    thicknessRangeMm: [0.6, 2.4], density: 0.75,
    stretchBase: 0.12, stretchFalloff: 0.25,
    bendRadiusFactor: 0.7, creaseFoldLimitMm: 3.0, neutralAxisFactor: 0.48,
    turnedSeamMaxMm: 2.4, tearStrength: 0.6,
    standardOz: oz(1.5, 6, 0.5),
  },
  {
    id: 'cow-shrunken-grain',
    name: 'Shrunken grain / pebbled cowhide',
    animal: 'cow', tannage: 'chrome', temper: 'medium',
    description: 'Chrome tanned with the grain shrunk for a pebbled texture. Medium temper, good body.',
    typicalUses: 'Bags, briefcases, accessories.',
    thicknessRangeMm: [1.0, 2.6], density: 0.9,
    stretchBase: 0.09, stretchFalloff: 0.28,
    bendRadiusFactor: 1.0, creaseFoldLimitMm: 2.6, neutralAxisFactor: 0.46,
    turnedSeamMaxMm: 2.0, tearStrength: 0.95,
    standardOz: oz(2.5, 6.5, 0.5),
  },
  // ───────────────────────── SHEEP ─────────────────────────
  {
    id: 'sheep-nappa',
    name: 'Sheepskin nappa',
    animal: 'sheep', tannage: 'chrome', temper: 'soft',
    description: 'Chrome tanned, drum dyed and soft. Very stretchy and light; weak against tearing.',
    typicalUses: 'Garments, gloves, linings, soft pouches.',
    thicknessRangeMm: [0.5, 1.4], density: 0.8,
    stretchBase: 0.18, stretchFalloff: 0.2,
    bendRadiusFactor: 0.6, creaseFoldLimitMm: 3.0, neutralAxisFactor: 0.48,
    turnedSeamMaxMm: 3.0, tearStrength: 0.55,
    standardOz: oz(1.5, 3.5, 0.5),
  },
  {
    id: 'sheep-cabretta',
    name: 'Cabretta (hair sheep)',
    animal: 'sheep', tannage: 'chrome', temper: 'soft',
    description: 'Hair-sheep skin with a tighter fibre than wool sheep. Thin, strong for its weight, elastic.',
    typicalUses: 'Gloves, fine garments.',
    thicknessRangeMm: [0.5, 1.1], density: 0.85,
    stretchBase: 0.2, stretchFalloff: 0.2,
    bendRadiusFactor: 0.5, creaseFoldLimitMm: 3.0, neutralAxisFactor: 0.48,
    turnedSeamMaxMm: 3.0, tearStrength: 0.7,
    standardOz: oz(1.5, 2.5, 0.5),
  },
  {
    id: 'sheep-chamois',
    name: 'Sheep chamois (oil tanned)',
    animal: 'sheep', tannage: 'oil', temper: 'soft',
    description: 'Cod-oil tanned split. Extremely soft and stretchy, absorbs water, low tear strength.',
    typicalUses: 'Polishing cloths, linings, soft bags.',
    thicknessRangeMm: [0.5, 1.4], density: 0.7,
    stretchBase: 0.25, stretchFalloff: 0.2,
    bendRadiusFactor: 0.5, creaseFoldLimitMm: 3.0, neutralAxisFactor: 0.48,
    turnedSeamMaxMm: 3.0, tearStrength: 0.5,
    standardOz: oz(1.5, 3.5, 0.5),
  },
  {
    id: 'sheep-suede',
    name: 'Sheepskin suede',
    animal: 'sheep', tannage: 'chrome', temper: 'soft',
    description: 'Sheep leather finished on the flesh side. Soft, elastic, low tear strength.',
    typicalUses: 'Garments, linings, pouches.',
    thicknessRangeMm: [0.5, 1.4], density: 0.72,
    stretchBase: 0.16, stretchFalloff: 0.2,
    bendRadiusFactor: 0.6, creaseFoldLimitMm: 3.0, neutralAxisFactor: 0.48,
    turnedSeamMaxMm: 3.0, tearStrength: 0.5,
    standardOz: oz(1.5, 3.5, 0.5),
  },
  {
    id: 'sheep-shearling',
    name: 'Sheepskin shearling (wool on)',
    animal: 'sheep', tannage: 'chrome', temper: 'soft',
    description: 'Wool-on skin. Thickness here is the skin only; add wool pile when nesting pieces.',
    typicalUses: 'Slippers, collars, linings, outerwear.',
    thicknessRangeMm: [0.9, 2.2], density: 0.8,
    stretchBase: 0.12, stretchFalloff: 0.2,
    bendRadiusFactor: 1.0, creaseFoldLimitMm: 3.0, neutralAxisFactor: 0.47,
    turnedSeamMaxMm: 2.2, tearStrength: 0.65,
    standardOz: oz(2.5, 5.5, 0.5),
  },
  {
    id: 'sheep-veg-skiver',
    name: 'Vegetable-tanned sheepskin (skiver / roan)',
    animal: 'sheep', tannage: 'vegetable', temper: 'medium',
    description: 'Thin veg-tan sheep used in bookbinding. Takes tooling, moderately stiff for its weight.',
    typicalUses: 'Bookbinding, boxes, linings, desk accessories.',
    thicknessRangeMm: [0.4, 1.2], density: 0.85,
    stretchBase: 0.06, stretchFalloff: 0.3,
    bendRadiusFactor: 1.5, creaseFoldLimitMm: 1.6, neutralAxisFactor: 0.45,
    turnedSeamMaxMm: 1.2, tearStrength: 0.6,
    standardOz: oz(1, 3, 0.5),
  },
  // ───────────────────────── LAMB ─────────────────────────
  {
    id: 'lamb-nappa',
    name: 'Lambskin nappa',
    animal: 'lamb', tannage: 'chrome', temper: 'soft',
    description: 'Fine grained, buttery soft chrome-tanned lamb. Highly elastic, delicate.',
    typicalUses: 'Luxury garments, gloves, small leather goods.',
    thicknessRangeMm: [0.4, 1.0], density: 0.8,
    stretchBase: 0.22, stretchFalloff: 0.2,
    bendRadiusFactor: 0.5, creaseFoldLimitMm: 3.0, neutralAxisFactor: 0.48,
    turnedSeamMaxMm: 3.0, tearStrength: 0.5,
    standardOz: oz(1, 2.5, 0.5),
  },
  {
    id: 'lamb-plonge',
    name: 'Lambskin plongé',
    animal: 'lamb', tannage: 'chrome', temper: 'soft',
    description: 'Very lightweight, drapey lamb with a slick finish. Maximum stretch, minimum body.',
    typicalUses: 'Draped garments, linings.',
    thicknessRangeMm: [0.4, 0.8], density: 0.78,
    stretchBase: 0.25, stretchFalloff: 0.2,
    bendRadiusFactor: 0.5, creaseFoldLimitMm: 3.0, neutralAxisFactor: 0.48,
    turnedSeamMaxMm: 3.0, tearStrength: 0.45,
    standardOz: oz(1, 2, 0.5),
  },
  {
    id: 'lamb-suede',
    name: 'Lambskin suede',
    animal: 'lamb', tannage: 'chrome', temper: 'soft',
    description: 'Lamb finished on the flesh side. Velvety, elastic, low tear strength.',
    typicalUses: 'Garments, linings, jewellery pouches.',
    thicknessRangeMm: [0.4, 1.0], density: 0.7,
    stretchBase: 0.18, stretchFalloff: 0.2,
    bendRadiusFactor: 0.5, creaseFoldLimitMm: 3.0, neutralAxisFactor: 0.48,
    turnedSeamMaxMm: 3.0, tearStrength: 0.45,
    standardOz: oz(1, 2.5, 0.5),
  },
  {
    id: 'lamb-shearling',
    name: 'Lamb shearling (wool on)',
    animal: 'lamb', tannage: 'chrome', temper: 'soft',
    description: 'Lightweight wool-on lamb. Skin thickness only; wool adds bulk at seams.',
    typicalUses: 'Slippers, hats, linings, trims.',
    thicknessRangeMm: [0.8, 1.8], density: 0.8,
    stretchBase: 0.13, stretchFalloff: 0.2,
    bendRadiusFactor: 0.9, creaseFoldLimitMm: 3.0, neutralAxisFactor: 0.47,
    turnedSeamMaxMm: 1.8, tearStrength: 0.6,
    standardOz: oz(2, 4.5, 0.5),
  },
  {
    id: 'lamb-veg',
    name: 'Vegetable-tanned lambskin',
    animal: 'lamb', tannage: 'vegetable', temper: 'medium',
    description: 'Thin veg-tan lamb, slightly papery hand. Used for fine bookbinding and gloves.',
    typicalUses: 'Bookbinding, gloves, linings.',
    thicknessRangeMm: [0.4, 1.0], density: 0.85,
    stretchBase: 0.07, stretchFalloff: 0.3,
    bendRadiusFactor: 1.4, creaseFoldLimitMm: 1.6, neutralAxisFactor: 0.45,
    turnedSeamMaxMm: 1.0, tearStrength: 0.55,
    standardOz: oz(1, 2.5, 0.5),
  },
];

export function getFamily(id: string): LeatherFamily {
  const f = LEATHER_FAMILIES.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown leather family: ${id}`);
  return f;
}

export function familiesFor(animal: Animal): LeatherFamily[] {
  return LEATHER_FAMILIES.filter((f) => f.animal === animal);
}

/** All thicknesses (mm) selectable for a family, in 0.5 oz steps across its range. */
export function thicknessOptionsMm(f: LeatherFamily): number[] {
  const out: number[] = [];
  const [lo, hi] = f.thicknessRangeMm;
  const startOz = Math.ceil(ozFromMm(lo) * 2) / 2;
  for (let o = startOz; mmFromOz(o) <= hi + 1e-6; o += 0.5) out.push(Math.round(mmFromOz(o) * 100) / 100);
  if (out.length === 0) out.push(lo);
  return out;
}
