# SketchUp import basics

`guide-last-2017.skp` is a synthetic openskp-generated regression fixture: a triangle and an infinite guide through `(2,3,4)` inches in direction `(1,0,0)`, with the guide last in its component definition. The definition has one root placement. Its four-byte guide trailer reproduced Garage V3's legacy-reader boundary failure. No private Garage geometry is included. Generation uses `create()`, `addComponentDefinition`, a triangle `addFace`, the builder's internal `_definitionWriter().writeConstructionLine([2,3,4], undefined, [1,0,0])`, increments that definition builder's `newEntityCount`, adds an instance and writes `toBytes()`.

`import-basics.skp` is a synthetic legacy-format fixture (17.0.1), generated for PushForm with MIT `openskp` 1.3.0. It contains no user model or third-party architectural geometry.

- Two instances, Cube A and Cube B, share one blue cube definition. Each cube has 1 m edges, 1 m³ volume, six faces and twelve hard edges. Cube B is translated +2 m on X.
- One horizontal sheet spans X=0–3 m and Y=2–4 m. Its 1×1 m hole spans X=1–2 m and Y=2.5–3.5 m, leaving 5 m² of sheet area.
- One 3 m loose edge runs from (0,5,0) to (3,5,0).

Use **Open…** for a new `import-basics.pf` tab: expect 1 stored body, 1 sheet face, 1 loose edge, 1 definition, 2 placements, 1 material and 0 non-default tags. The viewport should show two blue cubes, a holed sheet and a line. These are storage counts; two visible cubes share one body in their definition.

Use Modeling **Import…** to add the same contents inside a new named group: counts additionally include that wrapper definition and placement. One Undo removes the whole import; Redo restores it. Save as `.pf` and reopen to inspect the same geometry. The `.skp` source must remain unchanged. Re-import creates an independent wrapper and independent component definitions.

This generated fixture provides analytic checks, not independent proof of compatibility with real SketchUp versions.

## Tag line styles (SketchUp 2019 and 2020 formats)

`line-styles-2019.skp` and `line-styles-2020.skp` were built for PushForm in SketchUp 2027 through its Ruby API and saved down to the 2019 and 2020 file formats. They contain only this geometry; the default template's scale figure was removed first.

- Tags `Dashed` (Dash line style), `Dotted` (Dot) and `Plain`, besides `Layer0`.
- A group on `Dashed` holding a 1 m cube (1 m³).
- A `Sheet` component, a 2 × 1 m face (2 m²), placed twice on `Dotted`, at (3, 0, 0) m and (3, 2, 0) m.
- A 3 m loose edge on `Plain` from (0, 5, 0) to (3, 5, 0) m.

SketchUp 2019 added dashed line styles to tags. Each tag record then ends with a reference to its `CCustomLineStyle`, which OpenSKP 1.3.0 cannot read; PushForm's patch (`patches/openskp@1.3.0.patch`) adds it. Without the patch neither file opens.

## Saved scenes (SketchUp 2027 format)

`scenes-2027.skp` was built for PushForm in SketchUp 2027 through its Ruby API. It holds a 1 m cube group on tag `Walls`, a 1 m line on tag `Notes ` (with a trailing space), and two scenes:

- `Perspective`: eye (4, −3, 2) m, target (0.5, 0.5, 0.5) m, up +Z, perspective with a 40° field of view; hides `Walls` and `Notes `. SketchUp lists the hidden tag as `Notes`, without the space.
- `Top`: eye (0.5, 0.5, 10) m looking down, up +Y, parallel projection 3 m high; hides nothing.

Open should create both scenes in that order; Import into another model adds none.

## Display units (SketchUp 2027 and 2017 formats)

Both were built for PushForm in SketchUp 2027 through its Ruby API, with the template's contents removed, and hold one 1 m cube drawn loose in the model. Only their Model Info → Units differ.

`units-decimal-2027.skp` (2027 format): decimal millimeters to 0.1 mm; area in m² to 3 places; volume in liters to 1 place; unit symbols hidden; angles to 2 places, snapping every 5°; length snapping on at 1 mm. Open should show lengths such as `1000.0` for 1 m.

`units-architectural-2017.skp` (saved down to the 2017 format): architectural inches to 1/8"; zero inches always shown (`2' 0"`); area in in² and volume in in³ to 2 places; angles to whole degrees with angle snapping off; length snapping off. SketchUp 2027 writes area and volume units even into the older format and reads these settings back unchanged.

Import into another model leaves that model's units unchanged.

## Groups and curves (SketchUp 2027, 2020 and 2017 formats)

`curves-groups-2027.skp`, `curves-groups-2020.skp` and `curves-groups-2017.skp` were built for PushForm in SketchUp 2027 through its Ruby API (template content removed first) and saved, then saved down to the 2020 and 2017 file formats. Positions are in meters.

- Group `Box` (definition `Group0`): a 1 m cube at the origin, holding a nested group `Ring` (definition `Group1`) with a loose 12-segment circle of radius 0.2 m at (0.5, 0.5, 1.5). A copy of the box 2 m along X has its own definition `Group0#1` but shares `Group1`, so that group definition has two placements.
- Component `Post`, placed at (0, 3, 0) and (2, 3, 0): a cylinder of radius 0.25 m and height 1 m pulled up from a 24-segment circle; both rims are circle curves on the solid's edges.
- Loose in the model: a quarter arc of radius 1 m about (0, 6, 0) from +X to +Y in 6 segments; a hexagon (polygon) of radius 0.5 m about (6, 6, 0) with normal (0, 1, 1); a welded 4-segment polyline from (0, 8, 0) to (4, 8, 0); a 16-segment circle of radius 0.5 m about (6, 3, 0) stretched twice along X into an ellipse; and an arc of radius 0.75 m about (0, 10, 1) in the XZ plane (normal −Y) from 30° to 150° in 5 segments.
- A half-disc sheet: an 8-segment arc of radius 0.5 m about (3, 6, 0) from 0° to 180°, closed by its diameter.

SketchUp reports three group definitions (`Group0`, `Group0#1`, `Group1`) and one component definition (`Post`), and 9 curves with 105 edges across the definitions (model 6 curves and 45 edges, `Group1` 1 and 12, `Post` 2 and 48). Open should create the same three groups and one component; the circles, arcs and hexagon keep their geometry as curves, and the polyline and the ellipse become freehand curves.

## Section planes, guides and dimensions (SketchUp 2027, 2020 and 2017 formats)

`annotations-2027.skp` was built for PushForm in SketchUp 2027 through its Ruby API; `annotations-2020.skp` and `annotations-2017.skp` are the same model saved down to those formats with `Model#save_copy`, and SketchUp 2027 reopens them with the same dimensions. Coordinates below are in meters; a `Notes` tag exists besides `Layer0`.

- A group `Box` (definition `Group0`) holds a 1 m cube from (0, 0, 0) to (1, 1, 1) in group coordinates, placed rotated 90° about Z and moved 3 m along X.
- Model section planes: `Cut A` (symbol `A`), x = 0.5 facing +X, active; `Plan` (`P`), z = 0.75 facing −Z, hidden, on `Notes`.
- Group section plane: `Inner` (`I`), y = 0.25 facing +Y in group coordinates, active in the group.
- Model guides: an infinite line through (0, 2, 0) along +X; a segment from (0, 3, 0) to (2, 3, 1); a point at (1, 2, 1) on `Notes`.
- Group guides: a hidden infinite line through (0, 0, 1) along +Y; a point at (1, 1, 1).
- Model dimensions: free points (0, −0.5, 0)–(1, −0.5, 0), offset (0, −0.3, 0); the ends of a loose edge (2, 0, 0)–(2, 1, 0), offset (0.3, 0, 0); from a quarter of the way along that edge, (2, 0.25, 0), to the free point (3.5, 0.25, 0), offset (0, 0.4, 0). All show SketchUp's computed length.
- Group dimension: cube vertices (0, 0, 1)–(1, 0, 1), offset (0, 0, 0.2), with the text `Top edge`.

SketchUp 2017 files store no section plane names, so SketchUp itself shows the 2017 copy's planes as `Section 1`, `Section 2` (model) and `Section 3` (group); Open should show the same. Open should report 3 section planes, 5 guides and 4 dimensions for each file, with every entity in the definition that holds it. The older copies store each dimension's plane differently (for example the free one with a downward normal, measuring along its X axis), but give the same points and offsets. All three save Display Section Planes off and Display Section Cuts on.

## Section display settings (SketchUp 2017 and 2027 formats)

`section-display-2017.skp` and `section-display-2027.skp` were built for PushForm in SketchUp 2027 through its Ruby API, with the opener's contents purged. Each holds a group with a 1 m cube from (0, 0, 0) to (1, 1, 1) m and one model section plane at x = 0.5 m facing +X, active. Only their rendering options differ, as SketchUp 2027 reads them back:

- `section-display-2017.skp` (2017 format): Display Section Planes on, Display Section Cuts off.
- `section-display-2027.skp` (2027 format): Display Section Planes off, Display Section Cuts on.

Open should turn PushForm's Display Section Planes and Display Section Cuts to match; Import into another model leaves them alone.

## Text and scenes (SketchUp 2017, 2020 and 2027 formats)

`text-scenes-2027.skp` was built for PushForm in SketchUp 2027 through its Ruby API, from an emptied template, and saved down as `text-scenes-2017.skp` and `text-scenes-2020.skp`. SketchUp reopened all three and reported the same text and scenes. Lengths below are in meters; SketchUp stores inches.

- Tags `Walls` and `Notes`; materials `Brick` and `Steel` (the pre-2021 reader numbers its objects from the first two materials).
- A 1 m cube group `Cube` on `Walls`; a 2 m loose edge from (0, 3, 0) to (2, 3, 0) on `Notes`; a `Post` component (0.2 × 0.2 × 1 m) turned 90° inside a group `Frame` at (3, 0, 0); a section plane at z = 0.5 facing down.
- Nine texts, all with the leader vector (0.3, 0.2, 0.4) unless noted:
  - `Free point` at (2, −1, 0), not attached.
  - `Post corner` attached to a top corner of the post, two instances deep: (3, 2, 1).
  - `Edge middle` and `Edge quarter` attached to the loose edge at (1, 3, 0) and (0.5, 3, 0).
  - `On face` attached to the cube's top face at (0.3, 0.6, 1).
  - `View based` at (0, −1, 0) with a view-based leader; SketchUp rescales its vector to the view, so Open keeps its anchor but no label offset.
  - `Hidden note` at (1, −1, 0), hidden, on `Notes`.
  - `No leader` at (0, −2, 0) with its leader line hidden.
  - `In group` inside the cube group at (0.5, 0.5, 0) in the group's coordinates, vector (0, 0, 0.5).
- Four scenes:
  - `Perspective`: eye (6, −5, 4), target (1.5, 1, 0.5), up +Z, 40° perspective; hides `Walls`.
  - `Plan`: eye (1.5, 1.5, 20) looking down, up +Y, parallel 6 m high, section plane active; hides `Notes`.
  - `No camera`: saves no camera.
  - `Keeps tags`: eye (−4, −4, 3), 50° perspective; saves no tag visibility.

Open should create the nine texts at those points and the four scenes in order, with no camera for `No camera` and tags left alone by `Keeps tags`.

## Last scene without axes

`last-scene-no-axes-2027.skp` was built for PushForm in SketchUp 2027 through its Ruby API, from an emptied template, and saved down as `last-scene-no-axes-2017.skp` and `last-scene-no-axes-2020.skp`. SketchUp reopened all three and reported the same scenes. Lengths are in meters.

- Tags `Walls` and `Notes`; a 1 m cube group on `Walls` and a 1 m loose edge from (0, 2, 0) on `Notes`.
- Two scenes, both 40° perspective looking at (0.5, 0.5, 0.5):
  - `All saved`: eye (4, −3, 2), saves every property; hides `Notes`.
  - `No axes`: eye (−3, −4, 2), saves every property but the axes; hides `Walls`.

The last scene saves no axes, so in the pre-2021 files nothing in the scene itself marks where its hidden tags are. Open should create both scenes with those cameras and hidden tags.

## Textures (SketchUp 2027 and 2020 formats)

`textures-2027.skp` was built for PushForm in SketchUp 2027 through its Ruby API from three small PNGs drawn for it (no library textures), and saved down to `textures-2020.skp`. Materials: `Quadrants` (8 × 4 px, red/green/blue/white quadrants with a black corner pixel, one tile 1 × 0.5 m), `Stripes` (4 × 4 px, yellow/purple columns, 0.25 × 0.25 m tiles) and the untextured `Plain`.

- A horizontal 1 m sheet at the origin: `Quadrants` front, `Stripes` back, both in their default placement.
- A vertical sheet at X = 2–3 m facing −Y: `Quadrants` front in its default placement, `Stripes` back positioned with two pins (turned and offset).
- A sheet tilted 45° at X = 4–5 m: `Quadrants` front positioned with two pins (turned, scaled unequally, offset).
- A horizontal sheet at X = 6–7 m with `Quadrants` distorted by four pins.
- A sheet sloping in X at X = 8–9 m with `Quadrants` projected straight down from above and positioned.
- A 1 m cube group at Y = 3–4 m: sides alternate `Quadrants` and `Stripes` in default placement, the bottom faces down, and the −Y side is positioned.
- A `Textured panel` component (1 × 0.5 m sheet, positioned `Quadrants` front, `Stripes` back), placed once rotated 60° about X and scaled 1.5 × 2, and once unrotated.
- An `Inherited panel` component without face materials, placed twice, painted `Stripes` and `Quadrants`.
- A 1.2 × 0.6 m image entity of a 6 × 3 px gradient, and a `Plain` triangle.

`textures-uv.json` holds SketchUp 2027's own texture coordinates for every textured face side, from `Face#get_UVHelper` (`get_front_UVQ` / `get_back_UVQ`, divided by q); both files give the same values. Importing either file should reproduce them exactly, except on the distorted sheet, which is approximated. Open shows the textures; Save as `.pf` and reopening keeps them.

## Tag attributes (SketchUp 2017 format)

`tag-attributes-2017.skp` was built for PushForm in SketchUp 2027 through its Ruby API, with the template's contents removed, and saved down to the 2017 file format. Tags: `Tagged` (hidden, with an attribute dictionary `Extension` holding `key` = `value`) and `Plain` (color 200, 100, 50), besides `Layer0`. A 1 m cube group on `Plain` and a 1 m loose edge from (0, 2, 0) m on `Tagged`; lengths are in meters.

A pre-2021 tag record stores its color as an inline material body with its own attribute container. A test moves `Tagged`'s dictionary into that container, as an extension (V-Ray) did in a real 2017 model, and reads the same tags.

## Entity tags and tag folders (SketchUp 2027, 2020 and 2017 formats)

`entity-tags-2027.skp` was built for PushForm in SketchUp 2027 through its Ruby API (template content removed first) and saved down to `entity-tags-2017.skp`. Positions are in meters. Tags: `Walls` (hidden), `Trim`, and `Old`, which is visible itself but sits in the hidden tag folder `Archive`.

- A loose 1 m square face from (0, 0, 0) on `Walls`; its four edges are Untagged.
- A loose 2 m line from (0, 3, 0) on `Trim`, and a loose 1 m line from (0, 5, 0) on `Old`.
- A group `Box` (definition `Group0`) on `Trim`: a 1 m cube from (3, 0, 0) whose top face is on `Walls` and whose vertical edge at (3, 0) is on `Trim`; its other faces and edges are Untagged.
- A component `Post` (one Untagged 1 m vertical line) placed at (6, 0, 0) on `Walls`.

SketchUp 2017 and 2020 have no tag folders: the 2017 copy keeps `Old` visible at the top level. `entity-tags-2020.skp` was saved down to the 2020 format after `Old` was taken out of `Archive` and the folder removed, because OpenSKP cannot yet read a tag folder saved down to that format. Otherwise all three files hold the same entities and tags.

## Colorized textures (SketchUp 2027 and 2017 formats)

`colorize-2027.skp` and `colorize-2017.skp` were built for PushForm in SketchUp 2027 through its Ruby API (the opener's contents cleared first; an unused `Blue` material remains) and saved in the current format and down to the 2017 format. Three 10" squares carry textured materials whose images are generated 48 × 48 pixel PNGs, each tile 10" wide:

- `Plain`: a warm "wood" image, not colorized (SketchUp's material type 1, color = the texture's average, 174 136 100).
- `Shifted`: the same image colorized toward 210 180 140 with colorize type shift (0).
- `Tinted`: a gray ramp colorized toward 40 80 200 with colorize type tint (1).

`colorize-shifted.png` and `colorize-tinted.png` are SketchUp's own colorized images of the last two (`Texture#write(path, true)`). The 2017 record stores the material type and colorize type in the 8 bytes after the color; PushForm's patch reads them.

## Styles (SketchUp 2027 and 2017 formats)

`style-wireframe`, `style-hiddenline`, `style-xray` and `style-monochrome`, each as `-2027.skp` and saved down to `-2017.skp`, were built for PushForm in SketchUp 2027 through its Ruby API: a new model with the template's contents cleared, one 1 m cube, and rendering options (`Sketchup::RenderingOptions`) set to deliberately unusual values. SketchUp's own reading of every option was recorded after setting them and, for the 2017 and 2020 copies of the wireframe model, after reopening; the readings agree. Colors are r, g, b.

- `style-wireframe`: RenderMode 0 (Wireframe), edges on (EdgeDisplayMode 1) colored 10 20 30 all the same (EdgeColorMode 1), profiles off at width 4, depth cue on at 5, extensions on at 9, endpoints on at 6, jitter on, back edges off; faces 200 210 220 front and 90 100 110 back, textures on, no X-ray; background 20 30 40, sky off (1 2 3), ground off (4 5 6), ground transparency 50; hidden geometry shown, guides hidden (HideConstructionGeometry), axes hidden, color by tag on; section planes and cuts shown, section fill off, section line width 7, section colors 11 12 13 (active), 14 15 16 (inactive), 17 18 19 (fill).
- `style-hiddenline`: RenderMode 1 (Hidden Line), edges off, colored 60 70 80 by material (EdgeColorMode 0), profiles on at width 3, depth cue off at 2, extensions off at 2, endpoints off at 3, jitter off, back edges on; faces 240 241 242 front and 130 140 150 back, textures off; background 250 240 230, sky on (100 150 250), ground on (120 110 100); hidden geometry hidden, guides shown, axes shown, color by tag off; section planes and cuts hidden, section fill on, section line width 2.
- `style-xray`: RenderMode 2 with ModelTransparency on (X-ray) and textures off; edges 255 0 0 on, profiles on at width 1, back edges off; faces 0 255 0 front and 0 0 255 back; background black, sky on, ground off; axes shown.
- `style-monochrome`: RenderMode 5 (Monochrome), edges black, profiles off at width 2, back edges on, textures on; faces white front and 160 170 190 back; background white, sky off, ground on (200 190 180) at transparency 20; axes hidden.

## Scene styles (SketchUp 2027, 2020 and 2017 formats)

`scene-styles-2027.skp`, `scene-styles-2020.skp` and `scene-styles-2017.skp` were built for PushForm in SketchUp 2027 through its Ruby API: a 1 m cube, two styles made from shipped `.style` files and then changed, and three scenes.

- `Plan style`: RenderMode 1 (Hidden Line), profiles off, textures off, background 200 201 202, edges 30 31 32, sky off, ground off.
- `Perspective style`: RenderMode 2 with textures, profiles on at width 3, background 40 41 42, edges 250 251 252, sky on (10 20 30), ground off. The model was saved showing this style.
- Scenes, in order: `Plan` (parallel view from above, saves `Plan style`), `Perspective` (saves `Perspective style`), `NoStyle` (does not save its style: SketchUp reports no style for it after reopening).

SketchUp reads every scene's style name and flags back the same from all three copies. PushForm's reader reads the scene styles of all three, but recovers no loose geometry from the 2020 copy (0 faces where SketchUp sees the cube), so Open reports no supported geometry for it; the tests use the 2027 and 2017 copies, and the 2020 copy stays here for that reader gap (PF-307). A 2021+ scene keeps its saved style as a whole 0x733c rendering-options record inside its page record (item 29005); a pre-2021 `CViewPage` record keeps it as a style item run (from item 1000) between the camera and the record's tail. Open should give `Plan` a style of its own named `Plan style` with those settings, make `Perspective` use the model's style (its saved settings are the current ones), and leave `NoStyle` without a style.

In 2021+ files the model's current rendering options are tagged values in model.dat's 0x733c record; `BackgroundColor` and `ForegroundColor` there are (0, 0, 0, 0) in some files (`section-display-2027.skp`, white and black in SketchUp), where the current style's `style.xml`, written last as `<name>_1`, holds them as items 4000 and 1014. Pre-2021 files keep each style as a run of (id, 1, type, value) items in the ids `style.xml` uses, the current style last; sketchy-edge styles embed stroke images after item 1013. The two forum samples the ticket PF-57 names (a wireframe 2019 file with 13 styles and a hidden-line 2018 file with a sketchy-edge style) read the same options SketchUp reports. Open should give the model each file's face style, edge, background and modeling settings; Import into another model leaves that model's style alone.
