# Groups and components in Modeling

## Place an existing component

Open the **Components** panel and its **In Model** collection. Click a component to start placing it. Its outline follows the pointer by its insertion point. Click to place it in the current editing context, or press Escape to cancel.

This list contains definitions in the current model, including unused ones; groups are not listed. External component libraries are not offered here.

## Replace selected component instances

Select the component placements you want to replace. In Components, open the desired component's context menu and choose **Replace Selected**. The placements retain their positions. Selected groups are not replaced by this action.

**Select Instances** selects placements in the current editing context. A component cannot be placed inside itself or inside one of its own descendants.

## Change component properties

Use the Components **Edit** tab for the name, description and supported behaviors such as Glue to, Cut opening, Always face camera and Shadows face sun. A name already used by another group or component is refused.

A component definition is shared by its instances. An instance name shown in the Object browser can differ from its definition name without making a separate definition.

## Delete an unused component definition

Use **Delete** in the component's context menu. A component still used by an instance cannot be deleted this way. Remove or replace its placements first if that is your intention.

The Statistics tab can include nested component contents. Counting nested placements is different from counting each component definition once.
