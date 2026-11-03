# Groups and components in Modeling

## Place an existing component

Open the **Components** panel and its **In Model** collection. Click a component to start placing it. Its outline follows the pointer by its insertion point. Click to place it in the current editing context, or press Escape to cancel.

This list contains definitions in the current model, including unused ones; groups are not listed. External component libraries are not offered here.

## Replace selected component instances

Select the component placements you want to replace. In Components, open the desired component's context menu and choose **Replace Selected**. The placements retain their positions. Selected groups are not replaced by this action.

**Select Instances** selects placements in the current editing context. A component cannot be placed inside itself or inside one of its own descendants.

## Make one component per object

Select two or more loose solids, groups or imported mesh parts and choose **Make Components** from the context menu (next to Make Component) or from command search. Each selected object becomes its own component in the same place, so a model imported as many named parts inside one container turns into one component per part in a single step.

A component is named after its object when it has a name; a group's instance name or an imported part's name is used as the definition name, and two objects with the same name give two definitions with that name. Objects without a name get the next numbered Component name. A mesh part is made editable first, so a closed part becomes a component holding one solid. Components already in the selection, faces and edges are left alone. The new components are selected afterwards, and one Undo restores everything.

## Change component properties

Use the Components **Edit** tab for the name, description and supported behaviors such as Glue to, Cut opening, Always face camera and Shadows face sun. A name already used by another group or component is refused.

A component definition is shared by its instances. An instance name shown in the Object browser can differ from its definition name without making a separate definition.

## Delete an unused component definition

Use **Delete** in the component's context menu. A component still used by an instance cannot be deleted this way. Remove or replace its placements first if that is your intention.

The Statistics tab can include nested component contents. Counting nested placements is different from counting each component definition once.
