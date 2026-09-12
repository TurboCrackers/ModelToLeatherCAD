import { V2 } from '../geometry/vec';
import { PatternSet, Piece } from './pattern';
import { bbox, rotate2 } from './geometry2d';

export interface LayoutOptions {
  gapMm: number;
  /** sheet width; 0 = automatic (roughly square layout) */
  sheetWidthMm: number;
  marginMm: number;
}

export function toLayout(piece: Piece, p: V2): V2 {
  const r = rotate2(p, piece.layout.angle);
  return [r[0] + piece.layout.tx, r[1] + piece.layout.ty];
}

function bestRotation(outline: V2[]): { angle: number; w: number; h: number; min: V2 } {
  let best = { angle: 0, w: Infinity, h: Infinity, min: [0, 0] as V2, area: Infinity };
  const evaluate = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    const bb = bbox(outline.map((p) => rotate2(p, a)));
    const area = bb.w * bb.h;
    if (area < best.area - 1e-9) best = { angle: a, w: bb.w, h: bb.h, min: bb.min, area };
  };
  for (let deg = 0; deg < 180; deg += 5) evaluate(deg);
  // refine around the coarse optimum so rectangles land square on the page
  const coarse = (best.angle * 180) / Math.PI;
  for (let deg = coarse - 5; deg <= coarse + 5; deg += 0.25) evaluate(deg);
  // prefer aligning the longest straight edge with the page when it costs almost nothing
  let longest = 0, longAngle = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L > longest) { longest = L; longAngle = -Math.atan2(b[1] - a[1], b[0] - a[0]); }
  }
  const bb = bbox(outline.map((p) => rotate2(p, longAngle)));
  if (bb.w * bb.h <= best.area * 1.04) best = { angle: longAngle, w: bb.w, h: bb.h, min: bb.min, area: bb.w * bb.h };
  return best;
}

/** Shelf-pack the pieces into rows. Simple, deterministic and good enough for hides. */
export function layoutPieces(set: PatternSet, opts: LayoutOptions): void {
  const items = set.pieces.map((pc) => {
    const outline = pc.cutOutlines.length ? pc.cutOutlines[pc.loops.findIndex((l) => l.isOuter)] ?? pc.cutOutlines[0] : pc.outlines[0] ?? [];
    // include notches so nothing is clipped
    const pts = outline.concat(pc.notches.map((n) => n[1]));
    const r = bestRotation(pts.length ? pts : [[0, 0]]);
    return { pc, ...r };
  });
  const totalArea = items.reduce((s, it) => s + (it.w + opts.gapMm) * (it.h + opts.gapMm), 0);
  const sheetW = opts.sheetWidthMm > 0 ? opts.sheetWidthMm : Math.max(Math.sqrt(totalArea * 1.15), ...items.map((it) => it.w)) + 2 * opts.marginMm;
  items.sort((a, b) => b.h - a.h);
  let x = opts.marginMm, y = opts.marginMm, rowH = 0, maxX = 0;
  for (const it of items) {
    if (x + it.w > sheetW - opts.marginMm && x > opts.marginMm) {
      x = opts.marginMm;
      y += rowH + opts.gapMm;
      rowH = 0;
    }
    it.pc.layout = { angle: it.angle, tx: x - it.min[0], ty: y - it.min[1] };
    x += it.w + opts.gapMm;
    rowH = Math.max(rowH, it.h);
    maxX = Math.max(maxX, x - opts.gapMm);
  }
  set.sheet = { w: Math.max(sheetW, maxX + opts.marginMm), h: y + rowH + opts.marginMm };
}
