import { MeshTopology, csrRange } from './mesh';

/** Shortest edge path between two vertices (Dijkstra on edge lengths). Returns edge ids, or [] if unreachable. */
export function shortestEdgePath(topo: MeshTopology, a: number, b: number): number[] {
  if (a === b) return [];
  const dist = new Map<number, number>([[a, 0]]);
  const prev = new Map<number, number>();
  const heap: Array<[number, number]> = [[0, a]];
  const push = (x: [number, number]) => {
    heap.push(x);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = (): [number, number] => {
    const top = heap[0]; const last = heap.pop()!;
    if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
    return top;
  };
  while (heap.length) {
    const [d, v] = pop();
    if (v === b) break;
    if (d > (dist.get(v) ?? Infinity)) continue;
    for (const e of csrRange(topo.vertexEdges, v)) {
      const x = topo.edgeVerts[2 * e], y = topo.edgeVerts[2 * e + 1];
      const w = x === v ? y : x;
      const nd = d + topo.edgeLengths[e];
      if (nd < (dist.get(w) ?? Infinity)) { dist.set(w, nd); prev.set(w, e); push([nd, w]); }
    }
  }
  if (!prev.has(b)) return [];
  const edges: number[] = [];
  let v = b;
  while (v !== a) {
    const e = prev.get(v)!;
    edges.push(e);
    const x = topo.edgeVerts[2 * e], y = topo.edgeVerts[2 * e + 1];
    v = x === v ? y : x;
  }
  return edges.reverse();
}
