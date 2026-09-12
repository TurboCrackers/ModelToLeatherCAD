import { PatternSet, Seam } from '../pattern/pattern';
import { LeatherSpec } from '../leather/physics';

export interface InstructionSection {
  title: string;
  lines: string[];
}

const mm = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)} mm`;

function needleAndTools(spec: LeatherSpec): string[] {
  const t = spec.thicknessMm;
  const iron = `${spec.stitchesPerInch} SPI pricking iron / stitching chisel (${spec.stitchPitchMm.toFixed(2)} mm pitch)`;
  const punch = `${spec.holeDiameterMm} mm round hole punch or diamond awl`;
  const needles = t <= 1.5 ? "John James size 004 harness needles (or fine glover's needles for garment leather)" : t <= 3 ? 'John James size 002 harness needles' : 'John James size 000/00 harness needles';
  const thread = `${spec.threadDiameterMm} mm waxed polyester or linen thread (e.g. Ritza 25 "Tiger" ${spec.threadDiameterMm} mm)`;
  const lines = [
    `Thread: ${thread}. Allow about 4× the seam length per saddle-stitched seam.`,
    `Needles: ${needles}.`,
    `Holes: ${iron}; or mark with the printed circles and punch each hole with a ${punch}.`,
    `Cutting: rotary cutter or round knife on a cutting mat; awl or silver pen to transfer the pattern.`,
  ];
  if (spec.family.tannage === 'vegetable') lines.push('Edges: bevel and burnish veg-tan edges with water/gum tragacanth after sewing; dampen only the pieces that need forming.');
  else lines.push('Edges: this leather does not burnish; finish raw edges with edge paint or a turned hem.');
  return lines;
}

function seamHow(seam: Seam, set: PatternSet): string {
  const a = set.pieces[seam.sideA.patchId].name, b = set.pieces[seam.sideB.patchId].name;
  const holes = seam.holeArc.length;
  const head = seam.isDart
    ? `Dart D${seam.label} on piece ${a}: ${mm(seam.length)}, ${holes} holes per side.`
    : seam.isClosure
      ? `Closure J${seam.label}: join the two ends of piece ${a} into a ring, ${mm(seam.length)}, ${holes} holes per side.`
      : `Seam ${seam.label}: piece ${a} to piece ${b}, ${mm(seam.length)}, ${holes} holes per side.`;
  const how = seam.type === 'turned'
    ? seam.isDart
      ? `Fold the piece grain-to-grain along the dart so the two rows of holes line up, stitch through the matched holes on the dashed stitch line, then open the piece out; the wedge folds to the flesh side (do not cut the wedge).`
      : `Place the two pieces grain side to grain side with the notches aligned at both ends, stitch through the matched holes along the dashed stitch line (${mm(seam.allowanceMm)} allowance outside it), then turn right side out.`
    : seam.isDart
      ? `Cut out the wedge, bring the two cut edges together edge-to-edge and saddle stitch through the matched holes (${mm(seam.insetMm)} from the edge).`
      : `Butt the two cut edges together flush with the notches aligned, and saddle stitch through the matched holes set ${mm(seam.insetMm)} in from the edges. For a stronger joint skive and overlap one edge instead, keeping the same hole rows.`;
  return `${head} ${how}`;
}

/** Order seams: darts on each piece first, then seams that attach a new piece (largest piece first), then closing seams. */
export function assemblyOrder(set: PatternSet): Seam[] {
  const { pieces, seams } = set;
  const out: Seam[] = [];
  const used = new Set<number>();
  for (const s of seams) if (s.isDart || s.isClosure) { out.push(s); used.add(s.id); }
  const attached = new Set<number>();
  const byArea = pieces.slice().sort((a, b) => b.areaMm2 - a.areaMm2);
  if (byArea.length) attached.add(byArea[0].id);
  let progress = true;
  while (progress) {
    progress = false;
    // pick the longest seam between an attached and an unattached piece
    let best: Seam | null = null;
    for (const s of seams) {
      if (used.has(s.id) || s.isDart || s.isClosure) continue;
      const a = attached.has(s.sideA.patchId), b = attached.has(s.sideB.patchId);
      if (a !== b && (!best || s.length > best.length)) best = s;
    }
    if (!best && attached.size < pieces.length) {
      // start a new sub-assembly with the largest unattached piece
      const next = byArea.find((p) => !attached.has(p.id));
      if (next) { attached.add(next.id); progress = true; continue; }
    }
    if (best) {
      out.push(best); used.add(best.id);
      attached.add(best.sideA.patchId); attached.add(best.sideB.patchId);
      progress = true;
    }
  }
  for (const s of seams) if (!used.has(s.id)) out.push(s);
  return out;
}

export function buildInstructions(set: PatternSet, dryLimit: number, effectiveLimit: number, title: string): InstructionSection[] {
  const spec = set.spec;
  const f = spec.family;
  const areaCm2 = set.totalAreaMm2 / 100;
  const sections: InstructionSection[] = [];

  sections.push({
    title: 'Leather specification',
    lines: [
      `${f.name} — ${f.animal}, ${f.tannage} tanned, ${f.temper} temper. ${f.description}`,
      `Thickness ${spec.thicknessMm} mm (${spec.thicknessOz} oz). Approx. ${spec.gramsPerSquareMetre} g/m².`,
      `Pattern area ${areaCm2.toFixed(0)} cm² (${(areaCm2 / 929).toFixed(2)} sq ft). Buy at least ${(areaCm2 * 1.3 / 929).toFixed(2)} sq ft to allow for nesting waste and flaws; layout sheet ${set.sheet.w.toFixed(0)} × ${set.sheet.h.toFixed(0)} mm.`,
      `Derived working values: usable stretch ${(dryLimit * 100).toFixed(1)}% dry, minimum inside bend radius ${spec.minBendRadiusMm.toFixed(1)} mm, ${spec.canCreaseFold ? 'sharp folds are fine without grooving' : 'sharp folds need a groove / skive (otherwise they were turned into seams)'}, neutral axis ${spec.neutralAxisDepthMm.toFixed(2)} mm below the grain (already built into the pattern).`,
      `Stitching: ${spec.stitchesPerInch} stitches per inch (${spec.stitchPitchMm.toFixed(2)} mm), hole Ø ${spec.holeDiameterMm} mm, thread Ø ${spec.threadDiameterMm} mm, stitch line ${spec.edgeMarginMm} mm from butted edges, ${spec.seamAllowanceMm} mm allowance on turned seams.`,
    ],
  });
  sections.push({ title: 'Tools and consumables', lines: needleAndTools(spec) });

  const formed = set.pieces.filter((p) => p.maxStrain > dryLimit);
  const cutLines = [
    `Print every tile page at 100% (no "fit to page") and check the scale bar. Tape the tiles together along the dashed overlap guides using the crop marks and tile numbers.`,
    `Lay the pattern on the grain side of the leather, avoiding the belly and any flaws. Trace the solid outlines, then cut. Transfer every red circle: prick through the paper with an awl, then punch or chisel the holes. Mark the short notch ticks at the seam ends and the blue dash-dot fold lines.`,
    `Piece list: ${set.pieces.map((p) => `${p.name} (${(p.areaMm2 / 100).toFixed(0)} cm², ${p.holes.length} holes)`).join('; ')}.`,
  ];
  if (formed.length) {
    cutLines.push(`Forming required: pieces ${formed.map((p) => `${p.name} (${(p.maxStrain * 100).toFixed(0)}% stretch)`).join(', ')} exceed the dry stretch of this leather (${(dryLimit * 100).toFixed(1)}%; the pattern allows up to ${(effectiveLimit * 100).toFixed(0)}%). ${f.tannage === 'vegetable' ? 'Case the leather (soak briefly, let it return to near-natural colour) and stretch/mould it over a form or the assembled body while sewing; let it dry fully in shape.' : 'Dampen the flesh side, stretch the piece over the assembled body while sewing and let it dry in place; steam helps chrome-tanned leather relax.'}`);
  }
  sections.push({ title: 'Cutting and marking', lines: cutLines });

  const order = assemblyOrder(set);
  const steps = order.map((s, i) => `Step ${i + 1}. ${seamHow(s, set)}`);
  steps.push(`Finish: check that every hole is used (both sides of a seam always have the same number of holes), tap the seams flat with a smooth hammer, then finish the edges. ${set.seams.some((s) => s.type === 'turned') ? 'Turned seams: trim the allowance to about half before turning if the leather is bulky.' : ''}`);
  sections.push({ title: `Assembly order (${set.seams.length} seams)`, lines: steps });

  sections.push({
    title: 'Legend',
    lines: [
      'Solid black line: cut. Red circles: stitch holes (Ø as specified). Grey dashed line: stitch line of a turned seam. Blue dash-dot line: fold (do not cut). Short ticks: seam ends — match them across the two pieces. Numbers: seam numbers, identical on both sides of a seam; D = dart (slit sewn to itself), J = closure joining two ends of one piece.',
      `Generated for "${title}" by Model to Leather CAD.`,
    ],
  });
  return sections;
}
