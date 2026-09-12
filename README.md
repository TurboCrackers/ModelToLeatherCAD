# Model → Leather CAD

Turn a 3D model into a leather pattern that respects how the chosen leather actually behaves, with matched stitch holes, SVG and tiled PDF export, and a 3D editor that explodes the model into its pattern and back.

Runs entirely in the browser (Vite + TypeScript + Three.js). No server, no uploads.

## Run it

```bash
npm install
npm run dev
```

Open the URL Vite prints (default http://localhost:5173). `npm run build` produces a static bundle in `dist/`; `npm test` runs the geometry and pipeline tests.

## Workflow

1. **Model** – import STL, OBJ, PLY, glTF or GLB (or drag a file onto the 3D view), or start from a sample shape. Set the units or type the longest dimension in millimetres so the leather thickness is meaningful relative to the model.
2. **Leather** – choose animal → type → thickness. Every cow, sheep and lamb leather in the catalogue carries thickness-dependent physical properties; the table shows what the software derives for the selection (stretch limit, minimum bend radius, whether a sharp fold is possible, neutral-axis depth, stitch pitch, hole size, edge margin, allowance, weight).
3. **Pattern style** – the *faithful ↔ simple* slider trades accuracy for fewer, bigger pieces. At the faithful end pieces must flatten within the leather's dry stretch limit and are simple separate panels. Moving toward simple (a) raises the allowed strain up to what wet forming can deliver (capped at 45%), (b) relieves curvature with darts inside a piece instead of splitting it, and (c) merges small pieces back into their neighbours whenever the merged piece still flattens within the limit. A sphere in soft chrome leather becomes two baseball-style halves; the PDF then tells you which pieces need dampening or wet forming. Seams the leather physically requires (too-tight bends, sharp folds it cannot take) are never merged away.
4. **Pattern** – the pattern recomputes automatically. The 3D view shows pieces in colour, seams (yellow = turned, orange = butted), fold lines (blue) and stitch holes (red). Drag the slider from *Assembled* through *Exploded* to *Flat pattern*.
5. **Edit** – tools in the 3D view:
   - **Select** – click a piece or seam for details; the seam list lets you change each seam's construction.
   - **Cut** – click two points; a seam is added along the shortest path across the surface.
   - **Join** – click a seam to remove it. If the merged piece cannot be flattened within the leather's stretch limit it is automatically cut again elsewhere.
   - **Seam type** – click a seam to toggle turned ↔ butted.
6. **Export** – SVG (1:1, mm, layered groups for cut / stitch holes / folds / labels) and PDF. The PDF (A4 by default, other sizes available) contains a specification page with an overview, 1:1 tiles with overlap guides, crop marks and a scale bar to tape together, and making instructions: leather specification, tools and thread, cutting and marking, forming notes, and a step-by-step assembly order for every seam and dart.

## How the leather drives the cuts

The pipeline is in `src/pattern/pipeline.ts`:

1. **Weld & orient** the mesh so normals point outward (`geometry/mesh.ts`).
2. **Bend allowance** – leather bends about a neutral axis below the grain surface. The model is taken as the grain (outer) surface and offset inward to the neutral axis before flattening, so thick leather patterns come out slightly smaller around curves and fit when bent. Switch the surface mode if your model is the inside or the mid surface.
3. **Edge classification** – for every mesh edge the dihedral angle and the width of the adjacent strip give an estimate of the physical bend radius. Edges bending tighter than the leather's minimum bend radius mark a *tight* band; sharp creases (above the crease angle) are allowed as folds only if the leather at that thickness can take a sharp fold without grooving, otherwise they become seams.
4. **Regions** – faces not in tight bands are grouped into regions separated by hard seams; tight fillet faces are absorbed by the neighbouring regions so the seam lands in the middle of the fillet (the seam replaces the bend the leather cannot make).
5. **Cut → flatten → refine** – the mesh is cut open along the seam set (vertices duplicated per side, `cutMeshAlongEdges`), each connected piece is flattened with LSCM followed by ARAP iterations (`geometry/flatten.ts`), and the per-triangle principal strains are measured. A piece passes when it has no flipped triangles and its strain stays under the leather's usable stretch. Otherwise it is cut again:
   - interior vertices with concentrated curvature (box corners) get a **dart** to the nearest boundary,
   - smoothly curved pieces get a **through-cut** across their most central / most strained vertex,
   - closed surfaces get a **plane split**.
   Softer, stretchier leather therefore yields fewer, larger pieces; firm veg-tan yields more.
6. **Seams & holes** – boundary loops are traced on the cut mesh and paired by original edge, including darts (a seam between a piece and itself). Stitch holes are placed by 3D arc length along the shared seam curve at the leather's pitch, centred with end margins, so both sides always get the same number of holes at the same positions. Turned seams put the holes on the stitch line and add the allowance outside it; butted seams put the cut edge on the seam and inset the holes by the edge margin. Dart wedges on turned seams are folded rather than cut (the offset outline is untangled).
7. **Smooth cut lines** – cuts follow mesh edges, which zig-zags on regular meshes. Each seam's shared 3D chain is simplified (Douglas–Peucker at about one edge length, which removes staircases but keeps genuine corners), corners are detected by turning angle, and a Catmull-Rom curve is run through the remaining points between corners. The same kept points and curve are applied to both sides of the seam, so lengths and holes stay matched. Imported meshes are first refined by midpoint subdivision to at least the *refine mesh* target (default 3000 triangles; corners are preserved exactly) so cuts have fine paths to follow.
8. **Merging** – small pieces are greedily merged into neighbours (and darts removed) when the union still flattens within the limit; only automatically created seams are candidates, physically required ones stay.
9. **Nesting** – pieces are rotated to their minimal bounding box and shelf-packed into the sheet.

## Leather catalogue

`src/leather/database.ts` holds 21 families (10 cow, 6 sheep, 5 lamb) with coefficients for stretch (falling with thickness), bend-radius factor, crease-fold limit, neutral-axis position, turned-seam limit, tear strength and available thickness range. `src/leather/physics.ts` turns a family + thickness into a `LeatherSpec`: stretch limit, minimum bend radius, stitch pitch (SPI by thickness, widened for weak leathers), thread and hole diameter, edge margin, allowance and default seam type. Thickness is selectable in half-ounce steps across each family's range and every property is computed for that exact thickness.

The values are engineering estimates distilled from leathercraft practice and typical published test ranges. They are conservative starting points, not lab data for a particular hide; tweak a family's numbers if your leather behaves differently. Individual settings (stretch limit, SPI, edge margin, allowance) can be overridden in the UI.

## Notes and limits

- Meshes should be manifold-ish triangle surfaces. Coarse meshes are refined automatically; raise the refine target for smoother curves at the cost of compute time, or set it to 0 to keep the mesh as imported.
- Flattening cost grows with piece size; models of a few thousand triangles compute in well under a second, tens of thousands take seconds.
- Global overlap of a flattened piece with itself is only detected through flipped triangles and outline self-intersection warnings.
- Stitch hole positions on the 3D model are shown on the seam curve (turned) or inset along the surface (butted) for visualisation.
