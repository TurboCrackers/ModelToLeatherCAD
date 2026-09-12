import { jsPDF } from 'jspdf';
import { PatternSet } from '../pattern/pattern';
import { toLayout } from '../pattern/layout';
import { V2 } from '../geometry/vec';
import { buildInstructions } from './instructions';

export type PaperSize = 'a4' | 'a3' | 'a2' | 'letter' | 'tabloid' | 'fit';

export interface PdfOptions {
  paper: PaperSize;
  marginMm: number;
  overlapMm: number;
  title: string;
  /** dry stretch limit of the leather and the limit the pattern was generated with */
  dryStretchLimit?: number;
  effectiveStretchLimit?: number;
  includeInstructions?: boolean;
}

const PAPER_MM: Record<Exclude<PaperSize, 'fit'>, [number, number]> = {
  a4: [210, 297],
  a3: [297, 420],
  a2: [420, 594],
  letter: [215.9, 279.4],
  tabloid: [279.4, 431.8],
};

interface Drawer {
  poly(pts: V2[], closed: boolean): void;
  circle(c: V2, r: number): void;
  text(s: string, p: V2, size: number, align?: 'left' | 'center'): void;
}

/** Draw the whole pattern through a coordinate transform (sheet mm → page mm). */
function drawPattern(set: PatternSet, doc: jsPDF, tf: (p: V2) => V2, scale: number, withLabels: boolean): void {
  const map = (pc: PatternSet['pieces'][number], p: V2): V2 => { const l = toLayout(pc, p); return tf([l[0], set.sheet.h - l[1]]); };
  const d: Drawer = {
    poly(pts, closed) {
      for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        doc.line(a[0], a[1], b[0], b[1]);
      }
    },
    circle(c, r) { doc.circle(c[0], c[1], r, 'S'); },
    text(s, p, size, align = 'center') { doc.setFontSize(size); doc.text(s, p[0], p[1], { align }); },
  };
  // cut lines
  doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.25 * scale); doc.setLineDashPattern([], 0);
  for (const pc of set.pieces) for (const o of pc.cutOutlines) if (o.length > 2) d.poly(o.map((p) => map(pc, p)), true);
  // notches
  for (const pc of set.pieces) for (const [a, b] of pc.notches) d.poly([map(pc, a), map(pc, b)], false);
  // stitch lines for turned seams
  doc.setDrawColor(140, 140, 140); doc.setLineWidth(0.15 * scale); doc.setLineDashPattern([1.5 * scale, 1 * scale], 0);
  for (const pc of set.pieces) pc.loops.forEach((lp, li) => {
    if (lp.edges.some((e) => e.seamId >= 0 && set.seams[e.seamId].allowanceMm > 0)) d.poly(pc.outlines[li].map((p) => map(pc, p)), true);
  });
  // folds
  doc.setDrawColor(31, 111, 235); doc.setLineWidth(0.2 * scale); doc.setLineDashPattern([3 * scale, 1.5 * scale, 0.5 * scale, 1.5 * scale], 0);
  for (const pc of set.pieces) for (const [a, b] of pc.foldLines) d.poly([map(pc, a), map(pc, b)], false);
  // holes
  doc.setLineDashPattern([], 0); doc.setDrawColor(208, 52, 44); doc.setLineWidth(0.2 * scale);
  const r = (set.spec.holeDiameterMm / 2) * scale;
  for (const pc of set.pieces) for (const h of pc.holes) d.circle(map(pc, h.p), r);
  // labels
  if (withLabels) {
    doc.setTextColor(40, 40, 40);
    for (const pc of set.pieces) {
      const c = map(pc, pc.centroid);
      d.text(pc.name, [c[0], c[1] + 2 * scale], 20 * scale);
      for (const l of pc.seamLabels) d.text(l.text, map(pc, l.p), 8 * scale);
    }
  }
}

export function exportPdf(set: PatternSet, opts: PdfOptions): jsPDF {
  const sheetW = set.sheet.w, sheetH = set.sheet.h;
  const fit = opts.paper === 'fit';
  const pageWH: [number, number] = opts.paper === "fit" ? [sheetW + 2 * opts.marginMm, sheetH + 2 * opts.marginMm + 30] : PAPER_MM[opts.paper];
  const landscape = !fit && sheetW > sheetH && pageWH[0] < pageWH[1];
  const page: [number, number] = landscape ? [pageWH[1], pageWH[0]] : pageWH;
  const doc = new jsPDF({ unit: 'mm', format: page, orientation: page[0] > page[1] ? 'landscape' : 'portrait', compress: true });
  const m = opts.marginMm;
  const cw = page[0] - 2 * m, ch = page[1] - 2 * m;

  // ---- page 1: overview + specification
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(0, 0, 0);
  doc.text(opts.title, m, m + 6);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  const s = set.spec;
  const lines = [
    `Leather: ${s.family.name} (${s.family.animal}, ${s.family.tannage} tanned, ${s.family.temper} temper)`,
    `Thickness: ${s.thicknessMm} mm (${s.thicknessOz} oz)   Weight approx. ${s.gramsPerSquareMetre} g/m2`,
    `Min. bend radius ${s.minBendRadiusMm.toFixed(1)} mm   Stretch limit ${(s.stretchLimit * 100).toFixed(1)}%   Neutral axis ${s.neutralAxisDepthMm.toFixed(2)} mm below grain`,
    `Stitching: ${s.stitchesPerInch} SPI, pitch ${s.stitchPitchMm.toFixed(2)} mm, hole dia. ${s.holeDiameterMm} mm, thread ${s.threadDiameterMm} mm`,
    `Edge margin (butted seams) ${s.edgeMarginMm} mm   Seam allowance (turned seams) ${s.seamAllowanceMm} mm   Default seam: ${s.defaultSeamType}`,
    `Pieces: ${set.pieces.length}   Seams: ${set.seams.length}   Leather area ${(set.totalAreaMm2 / 100).toFixed(0)} cm2   Layout ${sheetW.toFixed(0)} x ${sheetH.toFixed(0)} mm`,
  ];
  lines.forEach((t, i) => doc.text(t, m, m + 14 + i * 4.5));
  let y = m + 14 + lines.length * 4.5 + 3;
  doc.setFontSize(8);
  doc.text('Pieces: ' + set.pieces.map((p) => `${p.name} ${(p.areaMm2 / 100).toFixed(0)} cm2${p.overStrained ? ' (!)' : ''}`).join('   '), m, y, { maxWidth: cw });
  y += 8;
  doc.text('Seams: ' + set.seams.map((sm) => `${sm.isDart ? 'D' : sm.isClosure ? 'J' : ''}${sm.label}: ${sm.type}, ${sm.length.toFixed(0)} mm, ${sm.holeArc.length} holes, ${set.pieces[sm.sideA.patchId].name}-${set.pieces[sm.sideB.patchId].name}`).join('   '), m, y, { maxWidth: cw });
  y += 14;
  doc.text('Legend: solid black = cut line, red circles = stitch holes, grey dashed = stitch line (turned seams), blue dash-dot = fold line, ticks = seam ends. D = dart (sewn to itself).', m, y, { maxWidth: cw });
  y += 8;
  // overview thumbnail
  const availH = page[1] - m - y;
  const sc = Math.min(cw / sheetW, availH / sheetH, 1);
  const ox = m, oy = y;
  drawPattern(set, doc, (p) => [ox + p[0] * sc, oy + p[1] * sc], sc, true);
  doc.setDrawColor(180, 180, 180); doc.setLineWidth(0.2); doc.setLineDashPattern([], 0);
  doc.rect(ox, oy, sheetW * sc, sheetH * sc);
  if (!fit) {
    // tile grid on the overview
    const step = [cw - opts.overlapMm, ch - opts.overlapMm];
    const cols = Math.max(1, Math.ceil((sheetW - opts.overlapMm) / step[0]));
    const rows = Math.max(1, Math.ceil((sheetH - opts.overlapMm) / step[1]));
    doc.setDrawColor(31, 111, 235); doc.setLineDashPattern([1, 1], 0);
    doc.setFontSize(7); doc.setTextColor(31, 111, 235);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x0 = c * step[0], y0 = r * step[1];
      doc.rect(ox + x0 * sc, oy + y0 * sc, cw * sc, ch * sc);
      doc.text(`${r + 1}-${c + 1}`, ox + (x0 + 3) * sc, oy + (y0 + 4) * sc);
    }
    // ---- tiled 1:1 pages
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      doc.addPage(page, page[0] > page[1] ? 'landscape' : 'portrait');
      const x0 = c * step[0], y0 = r * step[1];
      doc.saveGraphicsState();
      doc.rect(m, m, cw, ch, null);
      doc.clip();
      doc.discardPath();
      drawPattern(set, doc, (p) => [m + p[0] - x0, m + p[1] - y0], 1, true);
      doc.restoreGraphicsState();
      // frame, crop marks, overlap guides and tile id
      doc.setDrawColor(150, 150, 150); doc.setLineWidth(0.2); doc.setLineDashPattern([], 0);
      doc.rect(m, m, cw, ch);
      doc.setLineDashPattern([2, 2], 0);
      if (c < cols - 1) doc.line(m + cw - opts.overlapMm, m, m + cw - opts.overlapMm, m + ch);
      if (r < rows - 1) doc.line(m, m + ch - opts.overlapMm, m + cw, m + ch - opts.overlapMm);
      doc.setLineDashPattern([], 0);
      doc.setFontSize(8); doc.setTextColor(0, 0, 0);
      doc.text(`${opts.title} — tile ${r + 1}-${c + 1} of ${rows}x${cols} — print at 100% — ${s.family.name} ${s.thicknessMm} mm`, m, m - 2);
      // 50 mm scale check
      doc.setLineWidth(0.4);
      doc.line(m, page[1] - m + 3, m + 50, page[1] - m + 3);
      doc.line(m, page[1] - m + 2, m, page[1] - m + 4);
      doc.line(m + 50, page[1] - m + 2, m + 50, page[1] - m + 4);
      doc.setFontSize(7); doc.text('50 mm', m + 52, page[1] - m + 4);
    }
  } else {
    doc.addPage(page, page[0] > page[1] ? 'landscape' : 'portrait');
    drawPattern(set, doc, (p) => [m + p[0], m + p[1]], 1, true);
    doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.4); doc.setLineDashPattern([], 0);
    doc.line(m, m + sheetH + 6, m + 100, m + sheetH + 6);
    doc.line(m, m + sheetH + 5, m, m + sheetH + 7);
    doc.line(m + 100, m + sheetH + 5, m + 100, m + sheetH + 7);
    doc.setFontSize(8); doc.setTextColor(0, 0, 0);
    doc.text('100 mm scale check — print at 100%', m + 103, m + sheetH + 7);
  }
  if (opts.includeInstructions ?? true) {
    const dry = opts.dryStretchLimit ?? s.stretchLimit;
    const eff = opts.effectiveStretchLimit ?? dry;
    const sections = buildInstructions(set, dry, eff, opts.title);
    doc.addPage(page, page[0] > page[1] ? 'landscape' : 'portrait');
    let yy = m + 6;
    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text('Making instructions', m, yy); yy += 9;
    for (const sec of sections) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
      if (yy > page[1] - m - 20) { doc.addPage(page, page[0] > page[1] ? 'landscape' : 'portrait'); yy = m + 6; }
      doc.text(sec.title, m, yy); yy += 6;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      for (const line of sec.lines) {
        const wrapped = doc.splitTextToSize(line, cw) as string[];
        const h = wrapped.length * 4.2 + 2;
        if (yy + h > page[1] - m) { doc.addPage(page, page[0] > page[1] ? 'landscape' : 'portrait'); yy = m + 6; }
        doc.text(wrapped, m, yy);
        yy += h;
      }
      yy += 3;
    }
  }
  return doc;
}
