# Cut List

Open the Cut List extension for a model to list its solid objects. A solid can be directly in the model, in a group,
or in a component. You do not need to wrap each object in a component first. Empty containers and sheet-only geometry
are not stock parts.

The list always groups objects by material and stock size. There is no View dropdown. Rows include the containing
group/component names, tags, material, quantity and dimensions in the document's units. Assemblies are not counted
again as extra stock parts.

Use the **Parts**, **Plans**, **Materials** and **Estimate** tabs to move through the job. **Output** groups labels,
spreadsheets and printing; **More** contains view options, reload and numbering.

## Inspect parts and capture production scope

Select rows and choose **Highlight selected** to frame those objects, or **Select in model** to inspect them. This
selection does not change which parts are manufactured. **Production scope** starts at the whole model, including
hidden solid objects. Choose **Use current selection** to capture a smaller job. Later inspection selections leave
that captured membership unchanged. Missing captured targets are reported for review.

## Cut List units and saved job settings

**Cut List units** uses model units by default and permits an override. The override changes display and numeric
entry without changing stock sizes or physical placements. The scope and unit override are saved with the model.
Material properties, stock, cutting options and saved numbers also belong to the model; reusable presets belong to
your extension settings.

Each material group offers its applicable cutting-diagram, labels and print actions. The summary totals stock by
material. Tables have fixed columns, and group headers do not have a Hide Group button.

## Cutting diagrams

In **Plans**, use **Material group** to switch between sheet and dimensional cutting plans. Hardware stays in
**Parts** and has no cutting plan. Production scope and Cut List units are also available here. Switching groups
shows the generated plan without starting another calculation.

In a cutting diagram, choose **Nesting** to pack actual part contours, including holes. Nesting always displays those
contours. For rectangle or guillotine layouts, turn on **Draw part shapes** to show the contours inside the rectangular
packing allowances; this updates the displayed layout immediately. Parts with no usable face outline use rectangles.
Plans update automatically after committed model, stock and cutting-setting changes. Leave the plan view while
working; the calculation continues. A failed or cancelled update offers **Retry update**. Superseded calculations
cannot replace newer results.

The cutting diagram's **Cost** uses the material's saved stock prices, including prices for a particular sheet size.
Saving a material price updates the plans and their costs automatically.

## Materials and stock rates

Open **Materials** to configure each model material. **New material** creates a name, color and manufacturing
classification together. Edit an existing row to change its name, color or configuration. **Stock and grain** opens
first; expand **Cutting allowances**, **Cost and weight**, or **Description and link** when needed. Saving model
material changes supports Undo and updates parts, plans and estimates automatically.

## Enter stock-specific material rates

In **Cost and weight**, default price, density and cut price apply unless a matching **Stock-specific rate** exists.
Add a rate with its stock dimensions, value and unit. Enter dimensions in Cut List units or include explicit units,
such as `18mm; 2440mm x 1220mm` for a sheet. Sheet rates begin with thickness and may include sheet length and width;
solid-wood rates use thickness; dimensional rates use section width and thickness, optionally followed by length.
Banding uses width and optional length; veneer uses sheet length and width. Separate the stock key's parts with `;`.
Duplicate or invalid keys keep the editor open for correction. Existing stock rates have pages when needed.

## Edit material texture and opacity

Open **Materials**, edit a row and expand **Appearance**. It loads the saved appearance when needed; ordinary stock
and price edits keep its image and precise color unchanged. Set **Opacity (%)**, or use **Choose texture image** /
**Replace texture image** to select a PNG, JPEG, GIF, BMP or WebP file. Images may be at most 64 MiB, 64 megapixels,
and 32768 pixels on either side.

Enter **Texture width** and **Texture height** in Cut List units or explicit units. **Lock size ratio** keeps the
current physical proportions while either size changes. A replacement starts with the new image's pixel ratio.
Choose **Texture grain direction** and optionally **Colorize with material color** using a color shift or tint.
Cutting rotation is still controlled separately under **Stock and grain**; appearance edits do not rotate geometry.

**Remove texture image** and **Reset appearance** change only the draft. Reset restores the saved name, color,
texture and opacity while keeping your manufacturing draft. **Save** commits appearance and configuration together
as one Undo action. **Cancel** discards the draft and can stop image preparation before the commit. A stale model
keeps the draft visible but requires reopening before saving. Unavailable or newer appearances explain their
read-only state while ordinary stock/price editing remains available.

## Duplicate, delete or purge materials

The editor's **More > Duplicate saved material** copies the saved appearance and attached properties. Review and
confirm before discarding an unsaved draft. **Delete material** also asks for confirmation; painted users revert to
the default material and affected production data may need review. The default material cannot be deleted.
The Materials toolbar's **More > Purge unused materials** keeps painted materials and materials referenced by saved
manufacturing assignments. **Reset material prices** clears default and stock-specific prices and cut prices while
keeping densities, sizes and classifications. Both actions show a preview and support Undo.

## Material libraries

Choose **Materials > Library**. Select a personal library and **Preview library**, or choose **Open library file**
for a `.pfmat` archive or legacy JSON file. The preview reports new materials, textures, and existing names that
will be kept. **Add materials** commits complete appearances and manufacturing settings in one Undo action,
including large libraries. If the model changes, use **Refresh preview** before loading again.

### Save a personal material library

Expand **Save document materials**, enter a **Library name**, then choose **Save personal library** and confirm.
Libraries preserve precise colors, opacity, texture images, physical scale, grain, and manufacturing settings.
Saving an existing name previews replacement. Personal libraries use the extension's private asset storage;
model materials and the model's Undo history stay independent. Legacy personal entries remain available and are
labelled separately. New archives preserve older settings copies and unrelated settings.

### Export or remove a material library

**Library actions** offers export and removal of the selected personal library. **Export document library** saves
current document materials instead. Archives contain their images; exporting a saved archive keeps its original
bytes. Files are limited to 64 MiB and validated before loading. Unsupported libraries remain visible and preserved.
Use **Find a library** for larger collections or **Refresh personal libraries** to reload the catalog.

Long operations show progress and **Cancel operation**. Closing the dialog cancels preparation; an already completed
save or import remains completed. A failed or cancelled import never leaves a partial set of materials.

## Manufacturing properties

Select parts and open **Entity Info > Cut List**, or choose **Edit selected parts** in the parts list. Manufacturing
labels and descriptions are independent of model names. **Include in production** controls whether an object is
manufactured without hiding it in the model. You can also set manufacturing tags. Expand **Orientation and grain** for grain handling, dimension axes and front/back. Dimension axes use the body's carried reference frame and do not rotate geometry. Moving or rotating a standalone
solid preserves its manufacturing directions. Scale affects the physical dimensions; reflected parts retain their
reflected outlines and front/back interpretation.

## Edit placement properties or shared defaults

Edits apply to **Selected placements** initially. Choose **Shared body defaults** explicitly to edit shared
defaults. Placement overrides stay in place when a shared default changes. A field showing **Mixed** retains each
part's value until you edit it. Use **Reset to inherited** to remove one property override and expose its current
shared, material or job default. Other properties remain unchanged.

## Advanced manufacturing properties and custom frames

**More manufacturing properties** contains mirrored-part equivalence, accumulated dimensions, objects per part,
thickness layers and weight/price formulas. Stock classification, grain and prices are edited under **Materials**.
Expand **Custom manufacturing frame** inside **Orientation and grain** to rotate the measurement directions about
body X, then Y, then Z. Enter angles in degrees. The dimension readout and plans update automatically; the solid
and its component axes do not change. **Reset custom frame** removes all three angle overrides and restores inherited
values. Setting an angle to zero is an explicit override. Shared edits preserve placement overrides, and each angle
also appears in **Reset to inherited**.

## Resolve saved number conflicts

If saved part numbers conflict, output is blocked to avoid producing ambiguous labels. Inspect the warning, then use
**More > Reset part numbers** to discard saved numbering and regenerate it. Missing or ambiguous saved attachments
are retained for review; Cut List does not silently widen a captured production scope.


## Review retained properties

After an ambiguous model edit, Cut List keeps affected properties and blocks production output until they are
reviewed. Choose **Review saved properties** from the warning, **More**, or the affected Entity Info subsection.
This review remains available when conflicting saved entries prevent the parts list from loading.

Choose a saved entry to inspect its authored values and whether it belongs to one placement or to shared body
defaults. **Keep on current part** keeps those values on their original part. To choose a replacement, select exactly
one solid part in the model, return to the review and choose **Move to selected part**. Review the captured destination
and affected shared placements, then confirm. Later inspection selections do not change that preview. Existing
destination properties are never overwritten. **Discard saved entry** previews removal before committing it.
All of these changes support Undo and Redo.

## Repair missing production members

For missing production members, use **Capture current selection** or **Use whole model** in **Repair production
membership**, inspect the replacement and confirm. Discarding a property cannot reset production membership.
Select only solid bodies or their containers when capturing; unsupported selected items are reported.

If the model changes before confirmation, refresh the review and prepare the change again. Entries with unresolved
saved links require reviewing those assignments; Keep and Move do not silently clear them. Newer or undecodable
plugin data remains read-only until a compatible plugin can read it.


## Physical frames and native files

Body frames follow whole-body transforms, copies, regrouping and Make Unique, including while Cut List is disabled.
They are saved in native files and recovery snapshots; files using them require a current PushForm reader. Cut List
measures the stored solid vertices along its manufacturing directions, including the complete placement transform.
A display-unit change does not round or resize the physical parts. When a rigid placement change leaves the exact
nesting input unchanged, Cut List reuses its current plan after refreshing the measurements and outlines.


## Estimate the job or selected rows

Estimate starts with **Production job**, including every included part in the saved production scope. Highlighting
or selecting a row in Parts does not narrow the estimate. For a subset, select rows in Parts, then choose
**Estimate scope > Use selected rows**. This captures those rows; later selections do not change that estimate.
Choose **Production job** to return to the whole job. If captured rows disappear or their occurrence membership
changes, recapture the rows before using their totals. Switching models clears these temporary output selections.

## Assign banding and veneer

Select sheet-good parts, open **Entity Info > Cut List**, and expand **Edges and faces**. Choose banding for the
front, back, left or right bounding edge, or veneer for the front/back face. Materials must have the matching
**Edge banding** or **Veneer** classification and a positive thickness under **Materials**. The manufacturing frame
and dimension order determine the side labels. Changing that frame keeps the assignment on its physical face.

Use **These placements** for placement overrides or **Shared body defaults** to edit shared assignments. **None**
explicitly removes an inherited treatment for those placements; **Use inherited** removes the override and reveals
the shared assignment again. Mixed selections keep individual values until edited. If a side cannot identify one
complete planar face, the inspector explains that it is unavailable. Correct the manufacturing frame or geometry
before assigning that side.

## Treatment requirements, plans and output

Cut List adds banding strips and veneer sheets to their own material groups and automatic plans, labels and
estimates. They remain linked to their physical parent for selection and editing and do not increase the model's
physical part count. Each thickness layer gets its own requirements. Configured band-thickness reduction and
veneer thickness reduce the core cutting dimensions before material allowances and stock matching; finished
sizes remain separate. A treatment that leaves no positive core size must be reviewed before production output.

The parts list offers optional edge/face material columns. Label edge/face fields and formulas show assigned
materials; edge-cutting fields show the reduced core before allowances. Thumbnails and diagrams mark banded sides,
and **Hide edges preview** hides diagram marks. Banding and veneer have their own saved part numbers.

Saving or resetting numbers for a large job prepares the complete change before applying it. It creates one Undo
action, including the job settings saved with those numbers. If the model changes during preparation, refresh and
retry; no partial set of numbers is saved.

## Repair banding or veneer assignments

If a model edit invalidates an assignment, choose **Review saved properties**. Select the treatment, choose its
**Replacement side** and **Replacement material**, then **Repair on current part**, or select one replacement solid
and choose **Assign to selected part**. Inspect the captured preview and confirm **Replace treatment assignment**.
Cancel leaves the saved assignment intact. Repair preserves its shared or placement scope, refuses existing
assignments on the destination face, and supports Undo/Redo. Later selection changes do not retarget the preview.


In actual-shape nesting, **Quarter turns for parts ignoring grain** permits 90-degree turns for those parts;
other parts still follow their material grain. **None** forbids all rotation. Dimensional and edge-banding stock
always use lengthwise cutting; their options show standard lengths without a sheet/nesting type selector.


## Keep matching grain together

Choose **Cut List > Grain continuity**, or find **Grain continuity** in command search. **Captured model
selection** keeps the physical parts selected when the tool starts. Changing the inspection selection leaves that
capture in place. **Enclosing assembly** previews the parts under the pointer; choose **Assembly** in the floating
tool options bar. Set **Group name** there, then click or press Enter. Escape cancels without changing the model.

Members must use the same grained sheet material and thickness, a single thickness layer, matching manufacturing
directions and coplanar fronts. They must be included, respect grain, and count individually. Use the manufacturing directions in **Entity Info > Cut List** to align incompatible directions. Entity Info exposes **Preserve grain continuity** under **Orientation and
grain**; enabling that property requires a complete group before nesting.

## Nest and repair a continuity group

Automatic plans keep a continuity group's relative offsets and gaps inside one reserved envelope. Labels, quantities
and sheet assignments still describe individual physical parts. Internal gaps count as waste. Rough part envelopes
must leave at least the configured kerf/spacing. A group that fits no stock is reported; add larger stock or change
the group. Guillotine plans include internal separation cuts after the envelope cuts. Use rectangular or outline
nesting if the fixed arrangement cannot be separated with guillotine cuts.

Copy a complete assembly or set to keep a distinct continuity group on the copies. Partial copies, deleted members,
disabled properties or incompatible material/frame edits require repair. The plan never silently splits a group.
In **Grain continuity**, choose **Existing continuity group** to preview membership. **Remove complete group** clears
that membership and its placement flags in one Undo; parts stay in production. Select the complete set to replace
its membership, or remove the old group first.
