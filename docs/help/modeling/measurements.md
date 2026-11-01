# Typing exact values in Modeling

## Enter an exact size

While a tool places geometry, the values it can take appear as small fields in the viewport, next to the part of the preview they measure. Gray dimension lines tie a length field to the edge it measures, and a gray arc ties an angle field to its angle. Each field shows the live value as you move the pointer.

You don't need to click a field. When no other text field has focus, start typing and the value goes into the first field. Press **Tab** to move to the next field and **Shift+Tab** to go back. Press **Enter** to apply the values. Any field you didn't type in keeps its live value. Press **Escape** to discard what you typed and cancel the operation. If a value can't be read, its field turns red and nothing is applied.

## Lock one value and set the other with the pointer

In Line and Rectangle, a value you leave with **Tab** is locked: the preview keeps it while the pointer sets the other value. For example, type a rectangle's width, press Tab, then move the pointer to set its height and click.

## Values for each drawing tool

- **Line**: Length and Angle. The angle is measured in the drawing plane from its first axis (red on the ground), counterclockwise. If you type only one, the pointer sets the other.
- **Rectangle**: Width and Height. Each keeps the side of the first corner the pointer is on; type a negative value to flip it.
- **Rotated Rectangle**: Length for the first edge, then Width and Angle.
- **Circle and Polygon**: Diameter. Type a radius with an **r** suffix, such as **12r**. For a polygon, type **24c** for a circumscribed size, or **8s** for eight sides.
- **Arc and Pie**: Diameter first, then Angle for the sweep.
- **2 Point Arc**: Length of the chord, then the bulge. **3 Point Arc**: Length of the first chord.

Move, Rotate, Scale, Push/Pull, Offset, Tape Measure, Protractor, Fillet and Chamfer show their single value in a field beside the pointer while an operation is in progress.

When a tool shows no field, for example before the first click or just after finishing, typing opens one beside the pointer. Use it to change the number of sides before drawing, or to resize what you just drew.

## Use units

A length without a unit uses the model's current units. Include a unit to override that choice, for example **10mm**, **2.5m**, or **3'6"**. Angles are in degrees, with or without **°**.

Some tools take values that are not lengths, such as a scale factor or coordinates (**[x,y,z]** or **<x,y,z>**). You can type these into any field, and the tool reads them as it would on their own.

## Keep Modeling and Layout instructions separate

Modeling works in 3D model units. Layout works on drawing pages and has its own tools and settings, including its Measurements field. Follow the guide for the editor you currently have open.
