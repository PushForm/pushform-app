# Importing and exporting Layout drawings

## Import an image file into the active page

Click **Import** in the toolbar's **Insert** group after Table, or choose **Main menu → Import...**. Select a **PNG**, **JPG/JPEG**, or **SVG** image and confirm the picker. The image is embedded, centered on the active page, and selected for moving and resizing. Use an unlocked, visible layer; cancelling adds nothing.

Import adds a picture to the current drawing; Open opens a document. The same picker also accepts DXF drawings. Use Paste instead when picture data is already on your clipboard.

## Open a LayOut document

Open a SketchUp **.layout** file to bring its pages and supported content into Layout. Review the import notes: unsupported or unavailable content may use a preserved picture or need correction.

An imported model viewport can retain a saved LayOut picture while offering model-view editing where its source is available. Do not assume an external model link is accessible just because its picture appears.

Some LayOut files contain objects saved with unusable numbers. A dimension saved without a valid position is skipped, and a model viewport whose saved camera cannot show the model keeps only its saved picture (or an empty frame). The import notes list what was skipped; the rest of the document opens normally.

If import still reports invalid or nonfinite numeric data, repair the source drawing and save a new copy in SketchUp LayOut before trying again. The failed import leaves your open drawings unchanged.

## Import DXF into a drawing

Use Import for a DXF drawing. Review its options and import notes, especially units and unsupported content. DXF is an exchange format; do not expect every source application feature to become an editable PushForm object.

Check the drawing's physical size after import before adding annotations or exporting at a particular scale.

## Export PDF

Open the main menu's **Export…** action and choose **PDF**. Choose all pages, the current page, or a page range. Each page keeps its physical paper size.

Paths, shapes, annotations, tables and text remain vector, and text remains selectable. Model views are raster images at the chosen 150 or 300 dpi. Export does not change the open drawing or its undo history.

## Export page images

In **Export…**, choose **PNG** or **JPEG**, the desired pages and resolution. One page produces one picture; multiple pages produce a ZIP with a picture for each selected page. The picture size depends on paper size and dpi, not the workspace zoom.

Images, fonts and model views are prepared before export. The editor's grid, selection boxes and tool previews are not part of the exported page.

## Export SVG or DXF

Choose **SVG** for editable vector artwork, or **DXF** for CAD exchange, in Export. Review the format's setup and limitations before saving. SVG can retain drawing paths, text and supported embedded pictures.

DXF can keep paths, supported styling and text, but pictures and raster model views are omitted. A drawing-scale denominator converts paper coordinates for CAD use; check it when preparing a scaled drawing.

## Print at the intended scale

Use the main menu's **Print** action or Ctrl/Cmd+P. Choose all pages or the current page and review the preview. Then open the system print dialog.

Choose matching paper, **100%** or **Actual size**, no outer margins, and no browser headers or footers. Printer or browser scaling can override the requested size. Printing leaves the drawing and selection unchanged.

## Present a drawing

Choose **Presentation mode** in the Present group to show the drawing without normal editing controls. Press Right arrow, Page Down or Space for the next page; Left arrow or Page Up for the previous page. Home and End go to the first and last pages. Press **Escape** to exit.

Presenting is different from exporting: it displays the current drawing and does not create a replacement document.

## Export a native editable copy

Choose **Main menu → Export…**, select **PushForm Layout (.pfl)** in **Format**, then click **Export…** and choose where to save. Browsers without a save picker download the file. This exports the entire document with its embedded assets and all pages. It keeps the open document’s name, cloud destination and saved state. There is no separate Download a copy menu item.

### Failed imports

If a supported file fails during import, PushForm automatically saves the original file and import report in a hidden, private folder on your account and queues a support ticket. Your file stays in PushForm and can be retrieved only by you and authorized administrators; it is not attached to the ticket or shared with other users. Cancelled imports do not create tickets. If you are offline or the upload cannot finish, the original error still appears, but the file may not be saved for support.
