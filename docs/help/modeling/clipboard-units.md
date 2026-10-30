# Copying geometry and model units

## Copy and place model geometry

Select geometry in the open editing context and use Ctrl/Cmd+C, then Ctrl/Cmd+V. The copy follows the pointer; click to place it or press Escape to cancel. Supported materials, tags and textures travel with the geometry.

The current model clipboard does not copy every entity type. Model text, dimensions, section planes and placed images can be left out with a status message. Copying a solid's face copies it as sheet geometry rather than as a closed solid.

## Paste geometry in its original location

Use **Paste In Place** from command search or the empty-space context menu. It inserts the copy at its original model position within the current editing context.

This can move geometry between groups: Cut in the original group, enter the destination group, then Paste In Place. Related component copies can continue to share a definition.

## Change model units

Open **Model Info → Units**. Set length format, length unit and precision. Architectural and fractional formats use inches; engineering uses feet. Decimal format supports its selected length unit.

You can separately set area, volume and angle presentation. The change immediately affects measurements, dimensions and entered lengths, and is saved with the model. Changing units is not the same as scaling geometry.

## Inspect model statistics or unused data

Use **Model Info → Statistics** to count geometry and other model content. Enable **Show nested components** to include each placement's contents. Hidden entities still count.

**Purge Unused** removes eligible unused definitions and assets. Review what you intend to retain before purging; deleting an unused component is different from erasing a visible placement.
