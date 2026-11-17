# Selecting and editing Layout objects

## Select one or several objects

Use **Select** and click an object. A filled shape can also be selected by its interior. Shift-click toggles an object in the selection. Ctrl-click, or Cmd-click on macOS, adds it; combine that modifier with Shift to remove it.

Drag a selection box left to right to select objects completely inside it. Drag right to left to select objects the box touches. Objects on hidden layers are not selected. Selecting part of a group selects the group.

## Select everything on the page

Press Ctrl+A, or Cmd+A on macOS, to select every object on the current page. That includes locked objects and objects on layers shown on every page. Hidden objects and objects on hidden layers are not selected. Selecting doesn't add an undo step.

Select, Lasso, Move, Rotate and Scale stay active, so you can press Ctrl+A or Cmd+A and then move, rotate or scale everything at once. Any other tool switches to Select, and an unfinished shape or step is dropped, as Escape would drop it.

While you are typing in a text box, table cell or field, the shortcut selects that text instead. It does nothing while a dialog or menu is open, in Presentation mode, during a drag, in a Shape Builder session, or when focus is in the Object browser.

## Select with a lasso

Choose **Lasso** from the Select button's arrow, or press Shift+Space. Drag a freehand outline and release, or click successive points and finish with Enter or a double-click. Delete or Backspace removes the last clicked point.

A clockwise outline selects objects it touches or encloses. A counterclockwise outline selects only objects entirely inside. Shift toggles, Ctrl or Cmd adds, and Ctrl+Shift or Cmd+Shift removes. Escape cancels the outline without changing the selection.

## Move and resize a selected object

Drag a selected object to move the whole object. Its bounding box has handles for resizing; a group or several selected objects share one box, so they resize and rotate together. Hold Shift while resizing to preserve its proportions. Hold Alt to keep its center in place.

Resizing a text box changes the box, not its font size. Escape during a resize discards that preview. Hidden or locked objects cannot be transformed until made editable.

## Edit a path's vertices

A selected path normally moves as a whole. Double-click the editable path with Select to enter vertex editing when you want to change individual points or curve handles instead. Move anchors to reshape the path; use its available handles to adjust curves.

If dragging moves the whole object, you are still in object selection rather than vertex editing. Finish text or cell editing before using document shortcuts.

## Nudge objects with arrow keys

With Select active and editable objects selected, press an arrow key to move them by 0.2 mm on the page. The step does not depend on zoom or grid snapping. Locked or hidden objects stay in place.

Arrow keys have their usual editing behavior when focus is inside text, a table, a field, a menu, or another active tool operation.

In the Object browser, click the first item and Shift-click the last to select the range and its child objects, including children inside collapsed groups and layers. Ranges stay on one page. Ctrl/Cmd-click adds an item; Ctrl/Cmd+Shift-click removes it.
