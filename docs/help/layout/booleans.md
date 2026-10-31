# Combining and cutting Layout paths

## Pick a target for a boolean operation

Choose a boolean operation from its button in Modify. Click the target path first, then the other paths it should combine with or cut against. Check the preview and use Apply, or press Enter, to commit. Escape cancels the preview.

Use visible, unlocked native paths on the same editable layer. Grouped or mixed-layer operands are not supported by this workflow. The first target controls the style of the result. The completed change is one undo step.

## Use Union, Difference, Intersection or Exclusion

**Union** combines filled regions. **Difference** subtracts later paths from the first target. **Intersection** keeps the common filled region. **Exclusion** keeps the portions outside the overlaps.

Choose the operation from **Modify → Boolean** in the toolbar. Click the target first, then each other path. Use closed, visible, unlocked native paths on the same editable layer, outside groups. Check the preview, then press **Enter** or click **Apply boolean** in the right-side pane. **Escape** cancels.

The result replaces the picked inputs and takes the first target's style. If the preview is empty, applying can consume the inputs. **Undo** restores the originals. Use **Division** for separate filled pieces or **Cut Path** to split just an outline into unfilled pieces.

## Use Division to cut filled pieces

Draw a closed target shape and one or more paths crossing it. Choose **Division** from the toolbar's **Modify → Boolean** dropdown. Click the target first, then each cutter. Cutters may be open or closed. All inputs must be visible, unlocked native paths on the same editable layer, outside groups.

Check the dashed blue preview, then press **Enter** or click **Apply boolean** in the right-side Division pane. **Escape** cancels. The separate filled pieces keep the target's fill and stroke; the original target and cutters are consumed together. **Undo** restores them.

For example, draw a line across a rectangle and past both sides, then pick the rectangle followed by the line. A line ending inside the target does not automatically extend to complete the cut. Choose **Cut Path** instead to split only the outline and remove its fill.

## Use Cut Path to split an outline

Cut Path splits a line or shape's outline where other paths cross it. Draw the target and at least one crossing cutter first. Both can be open lines or closed shapes; use visible, unlocked native paths on the same editable layer, outside groups.

1. Open the **Boolean** dropdown in the toolbar's **Modify** group and choose **Cut Path**. You can also find Cut Path in the Tools menu or command search. No preselection is needed.
2. Click the target path first: this is the outline you want to split. Then click each cutter path. If Cut Path is already active, start with these clicks.
3. Check the dashed blue preview. Press **Enter** or click **Apply boolean** in the right-side Cut Path pane to finish. **Escape** cancels without changing the drawing.

The result is separate editable paths with the target's stroke and no fill. Only the target's outline remains; the cutters are consumed. **Undo** restores the originals together. For example, a line crossing a rectangle's boundary twice splits its outline into two unfilled paths. Use **Division** instead if you want separate filled pieces.

A cutter must actually cross the outline: its ends do not extend automatically. A target contour with no crossing keeps its closure but loses its fill.

## Start Shape Builder

Select the lines or shapes you want to work with, then choose **Shape Builder**, the first entry in the Boolean button's arrow, or press **X**. Look for the overlapping outlines with a shaded region and a small pointer. At least one eligible path must be selected. Paths must be visible, unlocked, ungrouped, and on one editable layer.

Other selected object types, such as images and text, are ignored and left unchanged. The right-side Shape Builder pane offers Apply, Cancel, Add, Remove, and Keep originals.

## Keep or merge Shape Builder regions

In Add mode, click regions to keep them. Click neighboring regions, or drag across them, to merge them. Regions sharing an edge join; separated regions remain separate objects.

Once you have added any region, only the regions you explicitly keep will become the result. The first added region supplies the fill and stroke style for all results in that session. You can undo gestures before applying.

## Remove regions and finish Shape Builder

Choose Remove, or hold Shift to temporarily reverse Add and Remove, then click or drag through regions to exclude. If you only remove regions, every region not removed remains. Once an Add gesture exists, untouched regions are excluded.

Press Enter or Apply to finish as one document edit. If no result remains, Apply says that it will delete the selected shapes. Escape or Cancel discards the session; switching tools also cancels it. Keep originals does not bring back excluded regions, so inspect the preview before applying.
