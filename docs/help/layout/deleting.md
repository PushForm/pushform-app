# Delete and erase objects in Layout

## Delete or remove a drawing object

To delete something from the page, choose **Select**, click the object, then press **Delete** or **Backspace** (the Mac's delete key). You can also right-click the object and choose **Delete** from its context menu. To remove several objects, select them together and press Delete once. Undo with **Ctrl+Z**, or **Cmd+Z** on macOS, restores the deletion.

The keys work with any tool, as long as objects are selected. They do nothing while you are dragging, while a tool is waiting for its next click (Move's destination, Rotate's angle, the second corner of a shape and so on), while a dialog or menu is open, or during a Shape Builder session. Press Escape to finish the step first.

Click the drawing canvas before using the shortcut if you were typing in AI Chat or a text field. Keys typed in chat stay in chat. Deleting an object does not require closing chat. A selected group is handled as a group.

## Erase objects with the Eraser tool

Choose **Eraser** in the toolbar's **Transform** section, or press **E** while the drawing canvas has focus. Choosing it clears the selection. Click an object to erase it, or drag across several objects to erase them all at once. This removes whole objects, rather than rubbing out pixels or trimming just the part under the pointer.

While you hover, the object a click would erase is highlighted. During a drag, everything the pointer has passed over stays highlighted, and the status bar counts the objects. Nothing is erased until you release the mouse button, and one Undo restores the whole drag. Press Escape before releasing to cancel the drag without erasing anything.

Where objects overlap, the Eraser takes the one in front. A filled shape is erased by clicking inside it, and a line or an unfilled shape by clicking its outline. Clicking any member of a group erases the whole group. Holding Shift, Ctrl, Cmd, Alt or Option makes no difference.

For a specific selected object, Select followed by Delete is usually the shortest route. The toolbar's Eraser is a separate route; there does not have to be a Delete button in the toolbar or main menu.

## Undo the last point while drawing

While a **Bézier Curve** path or a click-by-click **Lasso** outline is unfinished, Delete or Backspace removes the most recent point and lets you carry on. Removing the only point ends the drawing without creating anything.

## Troubleshoot locks, focus, vertices and cells

Locked objects, and objects on locked layers, are never erased. When a selection, an Eraser drag or a group includes locked objects, the other objects are erased and the locked ones stay where they are; the status bar says how many were left. Unlock an object to erase it. Labels that point to an erased object, and dimensions that measure it, stay on the page.

In path vertex editing, Delete or Backspace removes the selected vertex when at least two vertices can remain; press Escape to return to object selection before deleting the whole object. While table cells are active, Delete clears their text rather than removing the table. Finish cell or text editing and select the whole table or text object to remove it.

In the **Object browser**, an object or group's context menu offers **Delete**, and pressing Delete or Backspace on its item does the same; focus moves to the next item. It is unavailable when the object or its layer is locked, and a group's deletion removes its unlocked members. Pages and layers are deleted only from their context menus.
