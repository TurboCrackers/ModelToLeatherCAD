export type V3 = [number, number, number];
export type V2 = [number, number];

export const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len3 = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const norm3 = (a: V3): V3 => {
  const l = len3(a);
  return l > 1e-20 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const dist3 = (a: V3, b: V3): number => len3(sub3(a, b));

export const sub2 = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
export const add2 = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
export const scale2 = (a: V2, s: number): V2 => [a[0] * s, a[1] * s];
export const dot2 = (a: V2, b: V2): number => a[0] * b[0] + a[1] * b[1];
export const cross2 = (a: V2, b: V2): number => a[0] * b[1] - a[1] * b[0];
export const len2 = (a: V2): number => Math.hypot(a[0], a[1]);
export const norm2 = (a: V2): V2 => {
  const l = len2(a);
  return l > 1e-20 ? [a[0] / l, a[1] / l] : [0, 0];
};
export const dist2 = (a: V2, b: V2): number => len2(sub2(a, b));
/** Left-hand perpendicular (rotate +90°). */
export const perp2 = (a: V2): V2 => [-a[1], a[0]];
export const lerp2 = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const lerp3 = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
