# Generate cabinet knobs and pulls

Choose **Tools → Cabinet Hardware…**, or search for **Cabinet Hardware** in command search.

Choose a shape and finish. Enter dimensions in millimeters, or leave fields empty for the selected shape’s defaults. Mounting centers means the distance between screw axes, not the overall length. Knobs normally have one mounting center. Recessed pulls extend behind the mounting face.

Choose **Generate and place**, then click to place the new component. Undo removes the generation or placement step. The component contains editable closed solids. Its description stores the resolved generator dimensions and finish. To change a generated component, select it and reopen **Cabinet Hardware…**. Choose **Regenerate selected hardware** to update every instance of that definition without moving them. This replaces manual edits to its generated solids and can be undone.

The generator supports round and square bars, wire and arch pulls, classic bridges, round and rectangular cups, edge pulls, recessed pockets, rings, geometric knobs, half-moon pulls and plain round backplates. Generic profiles approximate common hardware; verify purchased hardware and screw positions before fabrication. Finish presets include original small-scale textures and diffuse colors in the modeling viewport, so chrome tone does not show mirror reflections.

Automation uses the `hardware.create` command. Dimensions are meters, `point` sets placement, and `mountingPlane` selects `front` (projection toward −Y), `top` (+Z), or `side` (+X). For example:

```json
{"shape":"bar-round","length":0.152,"spacing":0.128,"grip":0.012,"projection":0.032,"finish":"satin-nickel","point":[0,0,0]}
```
