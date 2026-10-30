# Copying and pasting in Layout

## Copy drawing objects

Select the objects and use Ctrl/Cmd+C, then Ctrl/Cmd+V. Pasted copies are centered on the active page on the current visible, unlocked layer. Their relative arrangement and supported styling are retained.

Paths remain editable, text stays text, and images keep their pictures. Copied dimensions keep their displayed geometry as fixed paper points rather than referring to the original measured objects.

## Paste text, pictures or vector artwork

Paste ordinary text onto the page to create a fitted text box. Paste a supported picture to create an image object with its aspect ratio preserved. The image is embedded in the drawing.

Supported SVG artwork can be pasted as editable native objects. Review any conversion notes instead of assuming every SVG feature is retained. Inside an active text editor, Paste edits text rather than placing a page object.

## Copy shapes to another vector editor

Copy selected Layout paths normally. PushForm provides an SVG representation where clipboard support allows it, alongside its own in-app copy. This keeps editable curves, fills, strokes, holes and relative placement for vector editors such as Inkscape.

In a mixed selection, the external SVG contains the paths; the in-app copy retains the other selected objects. A browser without the required clipboard support explains the limitation.

## Group and arrange copied objects

Use the selected objects' context menu or available Arrange controls for grouping and drawing order. A group is selected and moved as a unit; enter its supported editing workflow before expecting to move an individual member.

Clipboard data is independent of cloud autosave. Copying objects does not save a new document to the library.
