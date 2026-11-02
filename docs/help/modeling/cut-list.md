# Cut List

Open the Cut List extension for a model to list its solid objects. A solid can be directly in the model, in a group,
or in a component. You do not need to wrap each object in a component first. Empty containers and sheet-only geometry
are not stock parts.

The list opens in **Model hierarchy** view. Assemblies show the objects inside their groups and components. A container
holding one solid stays as one row. The list includes the containing group/component names, tags, material, quantity
and dimensions in the document's units. Assemblies are not counted again as extra stock parts.

Select rows and choose **Highlight selected** to select those objects and frame them in the model, or **Select in model**
to select them without moving the camera. A selected group or component limits the list to its contents; selecting an
individual solid limits it to that object. **Whole model, ignoring the selection** lists all visible solid objects.

Choose **By material** for stock groups and their cutting-diagram actions. The summary still totals the stock by
material. Tables have fixed columns, and group headers do not have a Hide Group button.
