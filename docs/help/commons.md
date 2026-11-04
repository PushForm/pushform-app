# Download models from Commons

PushForm Commons is a community model catalog with its own website. The hosted library is not available yet. Browse models, search by name or description, and filter by category or license. The commercial-use filter includes models only when every listed license explicitly permits commercial use; read all listed conditions before reuse.

Open a model to see its original creator, source, licenses and attribution notices. When files are available, choose **Download ZIP** next to a filename. The package contains the unchanged original in `files/`, an `ATTRIBUTION.json` record and a README. Keep required credits and license notices with reused files. A free download does not remove license conditions.

## Open a model in PushForm

Downloads require the catalog and model to remain available. If a file is unavailable, return to the catalog and try again later. Some builds may show metadata without configured downloads. A preview does not establish fabrication suitability or solid editability. Original file formats are listed; a download does not guarantee that PushForm can import that format. Extract the model file before using Open or Import. For supported files, choose **Open in PushForm** on the model page. It opens the web editor in another tab, continues through normal sign-in and initial account setup, and creates a separate model. Your current project stays open. Files without recorded units ask for units and up axis before opening. Unsupported originals remain available as downloads and may need conversion.

## Preserve creator notices

Model Info → Credits shows the original source, licenses, conditions and creator notices. Native saves retain those notices. Geometry and image exports from an attributed model are ZIP packages containing the exported file and attribution notices; keep the package together when sharing. Commons currently does not insert files directly into an open project.

## Your public profile

Choose **My profile** to sign in with your PushForm account. A new account completes the same private account setup and Terms of Use step used by the editor. Creating a public profile is a separate choice; it is not required to download models.

Choose a public handle and display name, then optionally add a bio and up to five links. Everything in this form is shown publicly once you save it. Your handle uses 3–32 lowercase letters, numbers or hyphens, starts with a letter and ends with a letter or number. Handles stay reserved and cannot be changed. Your private account name, email, company and projects are not copied into your public profile.

Saving takes you to your public profile page, at `/u/` followed by your handle (for example `commons.pushform.io/u/your-handle`). Use **View your public profile** to open it again later. The page shows your chosen public fields and published models associated with your authorship. Imported models retain their original creator credit; uploading or curating someone else's model does not make you its author.

If your profile was hidden, saving it makes it visible again. If another tab changed the profile, reload the page before saving your changes. Older profile links continue to work and open the handle address.

## Add a profile picture and banner

After you publish your profile, **My profile** shows a **Profile picture** and a **Banner** section. Your banner runs across the top of your public profile page, and your profile picture overlaps its lower edge as a circle.

1. Choose **Upload profile picture** or **Upload banner** and pick a PNG or JPEG image up to 20 MiB and 8,192 pixels on each side.
2. Drag the image to position it and use the **Zoom** slider or the mouse wheel to zoom. With the crop area focused, the arrow keys move the image (hold Shift for larger steps) and plus and minus zoom.
3. Check the previews, then choose **Save profile picture** or **Save banner**. Choose **Cancel** to keep your current image.

Commons saves a profile picture at 512 × 512 pixels and a banner at 1500 × 500 pixels. Images with transparency stay PNG; others are saved as JPEG. A saved image must be 2 MiB or smaller. Very detailed transparent images are placed on a white background and saved as JPEG. While the image uploads, a progress bar shows its status, and Commons checks the image before showing it.

## Replace or remove your profile picture and banner

Saved images are public right away while your profile is visible; you don't need to save the profile form. Use **Replace profile picture** or **Replace banner** to choose a new image; the old one stops showing as soon as the new one is saved. Use **Remove profile picture** or **Remove banner** to take an image down. Hidden profiles don't show their images.

Earlier profiles may show a picture loaded from an address you entered. It keeps showing until you upload a profile picture, which then takes its place. You can no longer enter a picture address.

## Preview a model

Commons renders thumbnails from supported model geometry on its server; a contributor does not need to upload a screenshot. An optional uploaded PNG or JPEG is used as the listing image instead. Choose **Explore in 3D** on a model page to rotate the geometry, zoom, or reset the view. Drag to orbit, use the labeled controls, or focus the viewer and use arrow keys, plus/minus, and zero to reset. Previews are available without signing in; original downloads require your PushForm account and initial account setup.

Commons queues server conversion for native PushForm, STEP, FreeCAD and supported mesh files (STL, OBJ, GLB/glTF, COLLADA, 3DS, SKP and model ZIPs). It accepts originals up to 128 MiB for conversion and displays up to 12,000 triangles. It shows geometry and material colors, with no textures, annotations, recorded dimensions, units or fabrication suitability. Unsupported content and models over those limits show an unavailable preview; try **Open in PushForm** or download the original where supported. A failed image falls back to the generated thumbnail when possible.

## Wait for a generated preview

A new publication may show **Rendering preview…** while its server job waits or runs. Commons updates the image when rendering finishes. Identical files reuse cached geometry and thumbnails. An uploaded PNG/JPEG still takes precedence as the listing image. If a render fails, the model page explains the failure and retains its original-file and license information. Try **Open in PushForm** or download the original where supported.

FreeCAD previews use visible saved BREP shapes, without running document scripts or recomputing the model. Assembly links/group placements and files without stored shape geometry are not supported by this preview converter.
