# Annotations and images in Modeling

## Place and edit Text in a model

Choose **Text** from the Measure dropdown. Click a face, edge or snapped point to anchor leader text, then click where its label should sit. The initial text describes the face's area, edge's length or point's coordinates. Clicking empty space instead places screen text.

The text opens for editing after placement. Type your wording, then press Enter or click elsewhere to keep it. Shift+Enter starts a new line. Escape cancels the text edit, or cancels a leader before its second placement click. To edit existing text, double-click it with Select or choose **Edit Text** from its context menu.

## Add a model dimension

Choose **Dimension** from the Measure stack. Click two points or an edge, then place the dimension line. Clicking an arc starts a radius dimension; clicking a circle starts a diameter dimension. A following click places its leader.

Dimensions attached to suitable geometry follow edits. Points picked in free space or imported annotations may remain fixed. Use Entity Info to replace dimension text; **<>** includes the measured value inside your replacement text.

## Set dimension appearance

Use **Model Info → Dimensions** for the settings new dimensions receive. **Update Selected Dimensions** applies those settings to selected existing dimensions. Changing defaults alone leaves existing dimensions unchanged.

Radius and diameter dimensions can be switched in Entity Info while keeping the same measured curve. Dimension text is distinct from the geometry it measures.

## Place 3D text

Choose **3D Text** from the Measure stack or command search. Enter text, font, weight, alignment and height. Choose filled text, and enable extrusion with a nonzero depth when you want solids. Height and depth use the model's units.

Click **Place** after correcting any validation messages, then click in the model to place the text component carried by the pointer. Escape cancels that placement but keeps the new definition in Components. Height means capital-letter height. The supported font choices are Roboto, Noto Serif and Roboto Mono.

## Import a picture into a model

Use **Import…** in a Modeling tab for PNG, JPEG, GIF, BMP or WebP pictures up to 32 MiB. The picture is placed as an image in the current context and selected, and Move activates so you can position it.

Select the image to inspect its placed width, height, pixel size and tag in Entity Info. The image's picture is saved with the native model. Its **Use as Material** action offers a separate material workflow.
