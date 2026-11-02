# Selection and objects in Modeling

## Find a solid, group or component

Open **Object browser** in the left menu bar and choose **Objects**. It lists loose solids, groups and components. Groups and components start collapsed. Expand the ones you want to inspect; selecting an item elsewhere reveals its ancestors. Loose solids appear as **Solid N** in creation order; those numbers can change as the model changes.

Click an item, or focus it and press Enter, to select it. The viewport shows the selection: a selected solid is outlined in the selection color with its faces tinted, and a selected group or component shows its bounding box. Shift-click selects the range from the last clicked item and all children, including children inside collapsed items; Ctrl/Cmd-click adds, and Ctrl/Cmd+Shift-click removes. Selecting something elsewhere reveals it in the browser: clicking a solid in the viewport, or one of its faces or edges, marks that solid, and clicking a group or component marks that item.

## Rename or edit a group

Double-click a group or component's name in the Object browser, or press F2, to rename the instance. Clearing the instance name shows its definition name again. Loose solids cannot be renamed there.

Renaming does not enter the group. Use **Edit Group** or **Edit Component** in its context menu to work inside it. The open item is marked **Open for editing**. Geometry commands act in the current editing context.

## Hide or lock an item

Use the Object browser's eye to hide or show a solid, group or component. Groups and components also have a lock button. Hiding a selected solid removes it from selection and from normal picking.

Hidden items appear dimmed in the browser with a crossed-out eye. Hiding a tag or tag folder in **Tags** also marks all affected objects and their descendants hidden in **Objects**. Their eye controls are disabled while a tag or ancestor hides them; show that tag or ancestor first. Objects you hid individually remain hidden when the tag is shown again.

## Use Lasso in Modeling

Choose **Lasso** from Select's stack or press Shift+Space. Drag an outline and release, or click points and finish with Enter or a double-click. A clockwise outline selects touched or enclosed geometry; a counterclockwise outline selects only geometry entirely inside.

Only visible geometry in the open editing context participates. Ctrl adds, Shift toggles, and Ctrl+Shift removes. Escape cancels without changing selection.

## Inspect an edge or curve

Select it and open **Entity Info**. A curve edge can expose Radius and Segments; changing either redraws the curve. A circle or polygon needs at least three segments.

A standalone sketch edge not bounding a face or belonging to a curve can have an editable Length. Other edge lengths may be read-only. Entity Info changes are undoable.

## Select a curved surface

The side of a pulled circle or arc is made of flat faces joined by soft edges, and it works as one surface. Click any part of it with **Select** to select the whole surface; Ctrl adds, Shift toggles and Ctrl+Shift removes all of it at once. Hovering highlights the whole surface, outlined along its hard edges such as a cylinder's rims.

Entity Info shows a selected surface as **Surface** with its total area. The Paint Bucket paints the whole surface, and Move, Rotate or Scale on a hovered surface moves all of it. Faces whose shared edges you soften become one surface too; unsoften an edge to split them again.

## Pick soft or hidden edges

Soft and hidden edges are not drawn, so the pointer passes through them to the face behind, and drawing tools do not snap to them or to corners only they reach. Turn on **Hidden Geometry** to show them dashed; while it is on you can click, select and snap to them, for example to unhide or unsoften an edge in Entity Info.

## Manage tags in the Object browser

Choose the **Tags** tab in the Object browser to create, rename, recolor or delete tags, organize tag folders, toggle visibility, choose the active tag, filter tags, change dashes, purge unused tags or turn on **Color by Tag**. Tag controls are now here instead of the right-hand panel strip. The pencil button chooses the active tag for newly created objects; it does not retag existing objects. Assign an existing object’s tag through **Entity Info**.

In **Objects**, each tagged object shows a small dot in that tag’s color. Hover over the dot or focus the object row with the keyboard to see a popup containing the tag name in a colored pill. Untagged objects have no dot. Dots and popups update when tags change, including undo and redo. Switching between **Objects** and **Tags** keeps your tree expansion and selection.

Use the **Color by Tag** checkbox below the tag table to display tag colors in place of materials and textures. Untagged geometry inside a tagged group or component inherits that tag’s color; an explicitly tagged child uses its own color. Turn it off to restore the original materials and textures. Below the checkbox, **Select All** selects entities with the selected tag (or the active tag if none is selected), and **Purge** removes unused tags and empty folders.
