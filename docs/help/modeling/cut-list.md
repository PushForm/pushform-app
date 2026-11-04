# Cut List

Open the Cut List extension for a model to list its solid objects. A solid can be directly in the model, in a group,
or in a component. You do not need to wrap each object in a component first. Empty containers and sheet-only geometry
are not stock parts.

The list always groups objects by material and stock size. There is no View dropdown. Rows include the containing
group/component names, tags, material, quantity and dimensions in the document's units. Assemblies are not counted
again as extra stock parts.

Select rows and choose **Highlight selected** to select those objects and frame them in the model, or **Select in model**
to select them without moving the camera. A selected group or component limits the list to its contents; selecting an
individual solid limits it to that object. **Whole model, ignoring the selection** lists all visible solid objects.

Each material group offers its applicable cutting-diagram, labels and print actions. The summary totals stock by
material. Tables have fixed columns, and group headers do not have a Hide Group button.

## Cutting diagrams

In a cutting diagram, choose **Nesting** to pack actual part contours, including holes. Nesting always displays those
contours. For rectangle or guillotine layouts, turn on **Draw part shapes** to show the contours inside the rectangular
packing allowances; this updates the displayed layout immediately. Parts with no usable face outline use rectangles.
After updating the extension, generate the diagram again to read the model's shapes.

The cutting diagram's **Cost** uses the material's saved stock prices, including prices for a particular sheet size.
After editing a material's price, choose **Pack again** to update the layout costs.
