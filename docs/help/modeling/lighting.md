# Lighting and environments

Open **Styles → Edit → Environment** to change the model's lighting and background. New models start with **Bright Studio**. Existing native models keep their saved lighting until you select an environment.

## Preview and save a look

Choose **Bright Studio**, **Soft Studio**, **Daylight**, or **Night interior**. Adjust the controls while watching the model. **Update style** keeps the preview in the current style as one undoable edit. **Save as…** creates and activates a named style while keeping the original. **Revert preview** returns to the saved look.

The Studio, Sun & sky, and Scene lights tabs edit separate sources of light. They can be used together. Changing an environment does not move the camera or change the model's geometry.

## Studio lighting

Brightness adjusts the overall light level. Fill light brightens the shaded faces; directional light gives the model more shape. View-facing light keeps faces toward the camera readable. Adjust the horizontal direction and elevation, and choose whether the light **follows the camera** or stays fixed in the model. **Cast soft shadows** enables shadows from the studio light.

## Sun, sky and location

Use **Sun & sky** for date, time, time zone, sun intensity and sun shadows. **Project location & north** sets latitude, longitude and the model's north direction. These are model settings; switching styles keeps them. Scenes that save shadow settings also save the date and time.

Choose a solid background, clear sky, overcast sky, night sky, or a skybox image. Skyboxes use embedded PNG or JPEG images, up to 16 MiB and 8192 × 4096 pixels. An equirectangular panorama with a 2:1 aspect ratio works best. Sky rotation turns the image around the model. Skyboxes provide the background; the sky-light slider controls ambient illumination.

## Place and edit lights

In **Scene lights**, turn on **Show scene lights**, then choose **Add light…**. Set a name, type, output in lumens, and temperature in kelvin. Lower temperatures look warmer; higher temperatures look cooler.

Choose **Place in model**. A point light needs one click for its position. Spot and area lights need a second click for the point they aim at. Escape cancels placement. Select a light in the list to edit its position, aim, output, temperature and shadows, or delete it. Position and area dimensions accept the model's units, including explicit lengths such as `6ft` or `1.5m`.

Point lights shine in all directions. Spotlights use a beam angle. Area lights distribute light across a rectangle using multiple samples, including distributed shadows. The interactive renderer supports eight placed lights and a bounded number of shadow sources; if the shadow limit is reached, turn off shadows on another light before adding more. Light placement and edits are undoable model changes and are kept independently of style presets.

## Save and share

Native `.pf` files keep styles, lighting, placed lights and embedded skyboxes. To use different looks in scenes, create separate styles and save each scene with its intended style. Light editing markers are omitted from image exports.

Commons continues to use fixed **Bright Studio**, with the current camera framing when publishing from the app. The publication render does not change the working environment or its placed lights.
