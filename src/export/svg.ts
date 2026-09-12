import { PatternSet } from '../pattern/pattern';
import { toLayout } from '../pattern/layout';
import { V2 } from '../geometry/vec';

export interface SvgOptions {
  title?: string;
  showLabels?: boolean;
  showStitchLine?: boolean;
  showFolds?: boolean;
  showNotches?: boolean;
  /** stroke colours */
  colors?: Partial<typeof DEFAULT_COLORS>;
}

export const DEFAULT_COLORS = {
  cut: '#000000',
  stitch: '#d0342c',
  stitchLine: '#8a8a8a',
  fold: '#1f6feb',
  label: '#333333',
  notch: '#000000',
  frame: '#bbbbbb',
};

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();

/** Layout coordinates → SVG (y down, grain side up). */
export function layoutToSvg(set: PatternSet, p: V2): V2 {
  return [p[0], set.sheet.h - p[1]];
}

export function exportSvg(set: PatternSet, opts: SvgOptions = {}): string {
  const c = { ...DEFAULT_COLORS, ...(opts.colors ?? {}) };
  const showLabels = opts.showLabels ?? true;
  const showStitchLine = opts.showStitchLine ?? true;
  const showFolds = opts.showFolds ?? true;
  const showNotches = opts.showNotches ?? true;
  const W = set.sheet.w, H = set.sheet.h + 22; // room for the title block
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(W)}mm" height="${fmt(H)}mm" viewBox="0 0 ${fmt(W)} ${fmt(H)}">`);
  parts.push(`<title>${escapeXml(opts.title ?? 'Leather pattern')}</title>`);
  parts.push(`<desc>${escapeXml(`${set.spec.family.name}, ${set.spec.thicknessMm} mm (${set.spec.thicknessOz} oz). Stitch pitch ${set.spec.stitchPitchMm.toFixed(2)} mm (${set.spec.stitchesPerInch} SPI), hole Ø ${set.spec.holeDiameterMm} mm. Units: mm, 1:1.`)}</desc>`);
  const poly = (pts: V2[], piece: PatternSet['pieces'][number]) => pts.map((p) => layoutToSvg(set, toLayout(piece, p))).map((p) => `${fmt(p[0])},${fmt(p[1])}`).join(' ');
  const r = set.spec.holeDiameterMm / 2;

  parts.push(`<g id="cut" fill="none" stroke="${c.cut}" stroke-width="0.25" stroke-linejoin="round">`);
  for (const pc of set.pieces) for (const o of pc.cutOutlines) if (o.length > 2) parts.push(`<polygon points="${poly(o, pc)}"/>`);
  parts.push('</g>');

  if (showStitchLine) {
    parts.push(`<g id="stitch-lines" fill="none" stroke="${c.stitchLine}" stroke-width="0.15" stroke-dasharray="1.5 1">`);
    for (const pc of set.pieces) {
      pc.loops.forEach((lp, li) => {
        const o = pc.outlines[li];
        // only draw where the outline differs from the cut (turned seams)
        const hasAllowance = lp.edges.some((e) => e.seamId >= 0 && set.seams[e.seamId].allowanceMm > 0);
        if (hasAllowance && o.length > 2) parts.push(`<polygon points="${poly(o, pc)}"/>`);
      });
    }
    parts.push('</g>');
  }

  if (showFolds) {
    parts.push(`<g id="folds" fill="none" stroke="${c.fold}" stroke-width="0.2" stroke-dasharray="3 1.5 0.5 1.5">`);
    for (const pc of set.pieces) for (const [a, b] of pc.foldLines) {
      const A = layoutToSvg(set, toLayout(pc, a)), B = layoutToSvg(set, toLayout(pc, b));
      parts.push(`<line x1="${fmt(A[0])}" y1="${fmt(A[1])}" x2="${fmt(B[0])}" y2="${fmt(B[1])}"/>`);
    }
    parts.push('</g>');
  }

  if (showNotches) {
    parts.push(`<g id="notches" fill="none" stroke="${c.notch}" stroke-width="0.25">`);
    for (const pc of set.pieces) for (const [a, b] of pc.notches) {
      const A = layoutToSvg(set, toLayout(pc, a)), B = layoutToSvg(set, toLayout(pc, b));
      parts.push(`<line x1="${fmt(A[0])}" y1="${fmt(A[1])}" x2="${fmt(B[0])}" y2="${fmt(B[1])}"/>`);
    }
    parts.push('</g>');
  }

  parts.push(`<g id="stitch-holes" fill="none" stroke="${c.stitch}" stroke-width="0.2">`);
  for (const pc of set.pieces) {
    const drawn = new Set<string>(); // shared corner holes appear once per piece
    for (const h of pc.holes) {
      const k = `${Math.round(h.p[0] * 10)},${Math.round(h.p[1] * 10)}`;
      if (drawn.has(k)) continue;
      drawn.add(k);
      const P = layoutToSvg(set, toLayout(pc, h.p));
      parts.push(`<circle cx="${fmt(P[0])}" cy="${fmt(P[1])}" r="${fmt(r)}"/>`);
    }
  }
  parts.push('</g>');

  if (showLabels) {
    parts.push(`<g id="labels" fill="${c.label}" font-family="Helvetica, Arial, sans-serif" text-anchor="middle">`);
    for (const pc of set.pieces) {
      const C = layoutToSvg(set, toLayout(pc, pc.centroid));
      parts.push(`<text x="${fmt(C[0])}" y="${fmt(C[1])}" font-size="7" font-weight="bold">${pc.name}</text>`);
      parts.push(`<text x="${fmt(C[0])}" y="${fmt(C[1] + 4.5)}" font-size="2.8">${fmt(Math.round(pc.areaMm2 / 100) / 1)} cm²${pc.overStrained ? ' ⚠' : ''}</text>`);
      for (const l of pc.seamLabels) {
        const P = layoutToSvg(set, toLayout(pc, l.p));
        parts.push(`<text x="${fmt(P[0])}" y="${fmt(P[1] + 1)}" font-size="3">${l.text}</text>`);
      }
    }
    parts.push('</g>');
  }

  // title block + 100 mm scale bar
  const y0 = set.sheet.h + 4;
  parts.push(`<g id="title" font-family="Helvetica, Arial, sans-serif" font-size="3.2" fill="${c.label}">`);
  parts.push(`<line x1="2" y1="${fmt(set.sheet.h + 1)}" x2="${fmt(W - 2)}" y2="${fmt(set.sheet.h + 1)}" stroke="${c.frame}" stroke-width="0.2"/>`);
  parts.push(`<text x="2" y="${fmt(y0 + 3)}">${escapeXml(opts.title ?? 'Leather pattern')} — ${escapeXml(set.spec.family.name)}, ${set.spec.thicknessMm} mm (${set.spec.thicknessOz} oz)</text>`);
  parts.push(`<text x="2" y="${fmt(y0 + 7.5)}">Pieces: ${set.pieces.length} · Seams: ${set.seams.length} · Stitch pitch ${set.spec.stitchPitchMm.toFixed(2)} mm (${set.spec.stitchesPerInch} SPI) · Hole Ø ${set.spec.holeDiameterMm} mm · Edge margin ${set.spec.edgeMarginMm} mm · Turned allowance ${set.spec.seamAllowanceMm} mm · Area ${(set.totalAreaMm2 / 100).toFixed(0)} cm²</text>`);
  parts.push(`<text x="2" y="${fmt(y0 + 12)}">Print at 100% — the bar below must measure exactly 100 mm.</text>`);
  parts.push(`<line x1="2" y1="${fmt(y0 + 15)}" x2="102" y2="${fmt(y0 + 15)}" stroke="${c.cut}" stroke-width="0.4"/>`);
  parts.push(`<line x1="2" y1="${fmt(y0 + 13.5)}" x2="2" y2="${fmt(y0 + 16.5)}" stroke="${c.cut}" stroke-width="0.4"/>`);
  parts.push(`<line x1="102" y1="${fmt(y0 + 13.5)}" x2="102" y2="${fmt(y0 + 16.5)}" stroke="${c.cut}" stroke-width="0.4"/>`);
  parts.push('</g>');
  parts.push('</svg>');
  return parts.join('\n');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
