# Generate cabinet knobs and pulls

Choose **Tools → Cabinet Hardware…**, or search for **Cabinet Hardware** in command search.

Choose a shape and finish. Enter dimensions in millimeters, or leave fields empty for the selected shape’s defaults. Mounting centers means the distance between screw axes, not the overall length. Knobs normally have one mounting center. Recessed pulls extend behind the mounting face.

Choose **Generate and place**, then click to place the new component. Undo removes the generation or placement step. The component contains editable closed solids. Its description stores the resolved generator dimensions and finish. To change a generated component, select it and reopen **Cabinet Hardware…**. Choose **Regenerate selected hardware** to update every instance of that definition without moving them. This replaces manual edits to its generated solids and can be undone.

## Hardware shapes and automation

Round and rectangular cup pulls include a raised top-and-side mounting rim with an open bottom for fingers. The rim stays within the entered overall dimensions; wall thickness controls its scale.

The rectangular pull has a continuous curved hood with softly rounded ends and front edges. Its hollow underside provides the finger grip, and a separate raised rim follows the rear top and sides.

The generator supports round and square bars, wire and arch pulls, classic bridges, round and rectangular cups, edge pulls, recessed pockets, rings, geometric knobs, half-moon pulls and plain round backplates. Generic profiles approximate common hardware; verify purchased hardware and screw positions before fabrication. Finish presets include original small-scale textures and diffuse colors in the modeling viewport, so chrome tone does not show mirror reflections.

## Generate cabinet hardware with commands

Choose **knob domed** for a smooth rounded head and neck made with Revolve. Width sets the head diameter, projection sets the distance from the mounting face, and mounting-base diameter sets the base size. The radial and profile segment settings are saved when you regenerate a selected component.

Start with 32–48 radial divisions and 16–20 profile segments. The defaults, 40 and 20, produce fewer than 2,000 triangles. Mesh size grows approximately as `2 × radial divisions × profile segments`; doubling both multiplies the triangle count by four. Use smooth shading for the surface and increase tessellation only when the silhouette visibly needs it. For a custom revolved knob, apply the same budget to its drawn profile and the Revolve tool’s radial segments.

For example, generate a domed knob with a 38.1 mm head, 31.75 mm projection and 17 mm base:

```json
{
  "shape": "knob-domed",
  "width": 0.0381,
  "projection": 0.03175,
  "grip": 0.017,
  "segments": 48,
  "profileSegments": 20,
  "finish": "white",
  "point": [0, 0, 0]
}
```

Automation uses the `hardware.create` command. Dimensions are meters, `point` sets placement, and `mountingPlane` selects `front` (projection toward −Y), `top` (+Z), or `side` (+X). For example:

```json
{
  "shape": "bar-round",
  "length": 0.152,
  "spacing": 0.128,
  "grip": 0.012,
  "projection": 0.032,
  "finish": "satin-nickel",
  "point": [0, 0, 0]
}
```
