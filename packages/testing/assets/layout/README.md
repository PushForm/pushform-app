# LayOut fixtures

## Model view with Background off (LayOut 2027)

`background-off-texture-2027.layout` was built by script in SketchUp 2027 and LayOut 2027 and saved by LayOut 2027. It holds one page with one model view of an embedded model, in raster render mode, with the view's Background turned off. LayOut rendered the view before saving.

- The model's style has sky color rgb(200, 80, 40) and background color rgb(40, 160, 90), shaded with textures and no shadows.
- The model has two 60 × 60 in faces on the ground plane, seen from the top. One is textured with vertical stripes of the sky color, the background color, black and white (a 64 × 64 px picture, 20 in per tile). The other is painted rgb(40, 160, 90).
- The saved raster render is an 8-bit RGBA PNG. Where no face is drawn it is fully transparent. The texture's stripes are opaque and exactly the sky and background colors.

## PDF pictures (LayOut 2027)

`pdf-picture-2027.layout` was saved by LayOut 2027. A script placed three pictures of one PNG file and saved the document; the PNG in the package was then replaced with a PDF, and LayOut 2027 opened that document and saved it again, keeping the PDF. All three pictures use the same stored PDF, `ref/3436053323_two-shapes_2.pdf`.

- The PDF has two 3 × 2 in pages. The first has no background: a red square rgb(217, 26, 26) on the left half, a blue disc rgb(26, 51, 217) on the right half, and a black frame line near the edge. The second is filled with green rgb(26, 179, 51), so showing it instead of the first page is obvious.
- The first picture fills a 3 × 2 in frame at (0.5, 0.5) in. The second has the same size at (4.5, 0.5) in, over a yellow rectangle, cropped by a 2 × 1.2 in rectangle at (4.5, 0.9) in. The third is stretched to a 2 × 3 in frame at (1, 3.5) in and rotated 30°.
