# Model views in Layout

## Place a model view

Choose **Model View** in Insert, after Import. Choose an available model, or **Choose cloud model…** to select a model from your library. Drag a frame or click opposite corners to place its view on the page.

A drawing imported from LayOut may already contain embedded models. Without cloud access, Model View can place views of those models; if no suitable model is available, the button explains why it is disabled.

## Choose a scene or standard view

Select the model view. In its **Model view** settings, choose a saved scene with a camera, or choose **Top**, **Front**, **Right**, **Back**, **Left**, **Bottom**, or **Iso**.

A scene applies its camera. A standard view frames the model and makes the view custom. Scene styles and tag overrides are not followed by this scene selection workflow.

## Navigate inside a model view

Double-click the view with Select, or enable **Navigate view** in its settings. Inside the frame, drag to orbit, Shift+drag or middle-button drag to pan, and scroll to zoom. Release a drag to save that camera change as one undo step. Scrolling saves when it pauses.

Press **Escape** or click outside the view to leave navigation. Escape during a drag cancels that drag. To move the frame on the page, leave navigation and select the whole view. Copies keep the same model source but have their own view settings.

## Keep a cloud model up to date

A linked cloud model follows its latest saved revision by default. The drawing checks for updates when opened, when its window regains focus, and after the model is saved in the same session.

The Models settings show its revision and status. **Pin** keeps the current revision. **Unpin** resumes following updates. For a pinned model with a newer revision, **Update** lets you move to that revision. **Edit model** opens the model in a Modeling tab.

## Understand model pictures and missing sources

Model views render as pictures of their model. Their status distinguishes a saved imported picture, a generated model picture, rendering in progress, and an unavailable model. If a source cannot be reached, its saved picture can remain visible, but new navigation or rendering may be unavailable.

Changing a view's frame does not turn it into ordinary drawing paths. In vector PDF export, the surrounding drawing can remain vector while the model view is a raster image.
