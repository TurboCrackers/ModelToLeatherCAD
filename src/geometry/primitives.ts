import { TriMesh, weldMesh } from './mesh';

function soupFromQuads(pts: number[][], quads: number[][]): TriMesh {
  const soup: number[] = [];
  const tri = (a: number, b: number, c: number) => soup.push(...pts[a], ...pts[b], ...pts[c]);
  for (const q of quads) {
    if (q.length === 3) tri(q[0], q[1], q[2]);
    else { tri(q[0], q[1], q[2]); tri(q[0], q[2], q[3]); }
  }
  return weldMesh(soup);
}

export function makeBox(w: number, h: number, d: number): TriMesh {
  const x = w / 2, y = h / 2, z = d / 2;
  const p = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ];
  const q = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3],
  ];
  return soupFromQuads(p, q);
}

export function makeCylinder(radius: number, height: number, segments = 32, caps = true): TriMesh {
  const pts: number[][] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push([radius * Math.cos(a), -height / 2, radius * Math.sin(a)]);
    pts.push([radius * Math.cos(a), height / 2, radius * Math.sin(a)]);
  }
  const quads: number[][] = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    quads.push([2 * i, 2 * i + 1, 2 * j + 1, 2 * j]);
  }
  if (caps) {
    const bottom = pts.length; pts.push([0, -height / 2, 0]);
    const top = pts.length; pts.push([0, height / 2, 0]);
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      quads.push([bottom, 2 * j, 2 * i]);
      quads.push([top, 2 * i + 1, 2 * j + 1]);
    }
  }
  return soupFromQuads(pts, quads);
}

export function makeSphere(radius: number, widthSegments = 32, heightSegments = 16): TriMesh {
  const pts: number[][] = [];
  for (let iy = 0; iy <= heightSegments; iy++) {
    const v = iy / heightSegments;
    const phi = v * Math.PI;
    for (let ix = 0; ix <= widthSegments; ix++) {
      const u = ix / widthSegments;
      const theta = u * Math.PI * 2;
      pts.push([-radius * Math.cos(theta) * Math.sin(phi), radius * Math.cos(phi), radius * Math.sin(theta) * Math.sin(phi)]);
    }
  }
  const quads: number[][] = [];
  for (let iy = 0; iy < heightSegments; iy++) {
    for (let ix = 0; ix < widthSegments; ix++) {
      const a = iy * (widthSegments + 1) + ix;
      const b = a + widthSegments + 1;
      if (iy === 0) quads.push([a, b, b + 1]);
      else if (iy === heightSegments - 1) quads.push([a, b, a + 1]);
      else quads.push([a, b, b + 1, a + 1]);
    }
  }
  return soupFromQuads(pts, quads);
}

/** Rounded-corner rectangular pouch (open top): a body with filleted vertical edges. */
export function makePouch(w: number, h: number, d: number, fillet: number, filletSegs = 6): TriMesh {
  // profile in XZ plane: rounded rectangle
  const prof: number[][] = [];
  const corners = [[w / 2 - fillet, d / 2 - fillet], [-w / 2 + fillet, d / 2 - fillet], [-w / 2 + fillet, -d / 2 + fillet], [w / 2 - fillet, -d / 2 + fillet]];
  for (let c = 0; c < 4; c++) {
    const [cx, cz] = corners[c];
    for (let s = 0; s <= filletSegs; s++) {
      const a = (c * Math.PI) / 2 + (s / filletSegs) * (Math.PI / 2);
      prof.push([cx + fillet * Math.cos(a), cz + fillet * Math.sin(a)]);
    }
  }
  const n = prof.length;
  const pts: number[][] = [];
  for (let i = 0; i < n; i++) {
    pts.push([prof[i][0], -h / 2, prof[i][1]]);
    pts.push([prof[i][0], h / 2, prof[i][1]]);
  }
  const quads: number[][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    quads.push([2 * i, 2 * i + 1, 2 * j + 1, 2 * j]);
  }
  const bottom = pts.length;
  pts.push([0, -h / 2, 0]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    quads.push([bottom, 2 * j, 2 * i]);
  }
  return soupFromQuads(pts, quads);
}

export function makeTorus(R: number, r: number, radial = 24, tubular = 48): TriMesh {
  const pts: number[][] = [];
  for (let j = 0; j <= radial; j++) {
    for (let i = 0; i <= tubular; i++) {
      const u = (i / tubular) * Math.PI * 2;
      const v = (j / radial) * Math.PI * 2;
      pts.push([(R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u)]);
    }
  }
  const quads: number[][] = [];
  for (let j = 1; j <= radial; j++) {
    for (let i = 1; i <= tubular; i++) {
      const a = (tubular + 1) * j + i - 1;
      const b = (tubular + 1) * (j - 1) + i - 1;
      const c = (tubular + 1) * (j - 1) + i;
      const d = (tubular + 1) * j + i;
      quads.push([a, b, c, d]);
    }
  }
  return soupFromQuads(pts, quads);
}
