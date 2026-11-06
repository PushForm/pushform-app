# Model views in Layout

## Place a model view

Choose **Model View** in Insert, after Import. Choose an available model, or **Choose cloud model…** to select a model from your library. Drag a frame or click opposite corners to place its view on the page.

A drawing imported from LayOut may already contain embedded models. Without cloud access, Model View can place views of those models; if no suitable model is available, the button explains why it is disabled.

## Choose a scene or standard view

Select the model view. In its **Model view** settings, choose a saved scene with a camera, or choose **Top**, **Front**, **Right**, **Back**, **Left**, **Bottom**, or **Iso**.

A scene applies its camera, and the view follows the tags the scene hides. A standard view frames the model with a new camera. The view keeps its scene, and the Scene setting shows it as modified, for example **Floor Plan (modified)**: the scene's tags and section cuts still apply. Choose the scene again to return to its camera.

## Show section cuts in a model view

A view of a scene shows the section cuts the scene saved: a scene saved with a section plane active shows that cut, and one saved with none shows the model uncut. Two views of the same model can show different cuts this way, for example a floor plan and a section. A view with no scene, such as a standard view, or of a scene that does not save its section planes, shows the model's current cuts.

When the scene saved its style, the view also takes that style's section display settings: whether section planes and cuts are shown, the section fill, and the section colors and line width. The scene's other style settings do not change the view. A view imported from a LayOut document keeps the section display settings saved with it there instead. Snapping to model points in a view uses the cuts that view shows, so points cut away are not offered.

## Section markers and sheet numbers

When a model has section planes and its style shows them, each marker in a model view has the plane's symbol in the top half of its bubble. The bottom half shows a sheet number when the plane cuts the model. That number is the page number of the first page with a view of the same model, because every view of a model is cut by the same planes. It is numbered as the **<PageNumber>** field numbers pages, so changing that field's start page or style changes it too. Hidden views, and views on a layer hidden on their page, do not count. A plane that does not cut the model leaves the bottom half empty. Moving pages updates the numbers. A view that still shows the picture saved with an imported .layout file keeps that picture's markers until the view is drawn again.

## Navigate inside a model view

Double-click the view with Select, or enable **Navigate view** in its settings. Inside the frame, drag to orbit, Shift+drag or middle-button drag to pan, and scroll to zoom. Release a drag to save that camera change as one undo step. Scrolling saves when it pauses.

Navigating keeps the view's scene in the same way, marked as modified. Press **Escape** or click outside the view to leave navigation. Escape during a drag cancels that drag. To move the frame on the page, leave navigation and select the whole view. Copies keep the same model source but have their own view settings.

## Keep a cloud model up to date

A linked cloud model follows its latest saved revision by default. The drawing checks for updates when opened, when its window regains focus, and after the model is saved in the same session.

The Models settings show its revision and status. **Pin** keeps the current revision. **Unpin** resumes following updates. For a pinned model with a newer revision, **Update** lets you move to that revision. **Edit model** opens the model in a Modeling tab.

## Understand model pictures and missing sources

Model views render as pictures of their model. Their status distinguishes a saved imported picture, a generated model picture, rendering in progress, and an unavailable model. If a source cannot be reached, its saved picture can remain visible, but new navigation or rendering may be unavailable.

While a view is still rendering, the page shows a pale gray box in its frame; printing and export wait for the picture. A view whose model shows nothing from its camera and scene, such as an empty model or a scene that hides every tag, draws nothing (only its background when Background is on), so anything underneath it on the page shows through. A view that cannot be rendered and has no earlier picture, for example because its model was only linked to an outside file, shows a gray box crossed in red on the page while you edit, and its status gives the reason. Printed and exported pages leave such a view empty instead; PDF export lists it in its notes.

Changing a view's frame does not turn it into ordinary drawing paths. In vector PDF export, the surrounding drawing can remain vector while the model view is a raster image.
