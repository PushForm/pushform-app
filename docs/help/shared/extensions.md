# Extensions: install, use, turn off and developer mode

## What extensions are and where they work

Extensions add side panels, tabs, toolbar buttons and commands to PushForm, such as a cut list for a model. Each one runs outside the editor's JavaScript environment and can do only what you allowed when you installed it. PushForm monitors it and offers restart or disable after a failure.

Extensions run in the web editor in Chrome, Edge, Firefox and other Chromium-based browsers. In Safari the Extensions panel opens but says extensions cannot run there. The Windows desktop app runs each extension in a separate native process. It currently permits two active extension runtimes; disable one before starting another if that limit is reached. Desktop extensions are not yet available on macOS or Linux.

## Open the Extensions panel

In either editor, choose the **Extensions** icon (a puzzle piece) at the bottom of the left menu bar. The Extensions panel opens beside the editor, where Files and the Object browser open; choose the icon again, or its close button, to close it. You can also choose **View ▸ Extensions**, type **Extensions** in command search, or choose **Manage extensions…** in the account dialog, which on Home opens the same content in a window. Opening the panel never starts an extension, and PushForm reopens it with that editor if you left it open.

## Browse and inspect installed extensions

When an official directory is configured, **Browse** lists its available releases. Choose **Check for updates** to refresh it, expand **Permissions and release notes** to read the details, or choose **Install** to review a package. If the directory is unavailable, PushForm explains that instead. A saved directory remains visible offline, but you must reconnect and check for updates before installing.

Under **Installed**, each extension shows its name, publisher, version and whether it is **Official, countersigned by PushForm** or **Unsigned (developer)**. Below that, whether it is running, starting, not running or stopped after a problem. Choose **Details** for its permissions, install time, network use, activity and developer log. Memory and processor use read **unavailable**: per-extension readings are not available in the manager yet.

## Read an extension's activity and network use

PushForm keeps a record of what happens to each extension on this device, for your account. Choose **Details** to see it.

**Network** lists each internet address the extension may use, with what it sent this session, what it sent in total and what it received in total. An extension without addresses reads **No internet access**.

**Activity** lists the newest events first, each with its date and time: installed, updated or reloaded, permissions allowed or removed, turned on or off and why, started, stopped and why, and uninstalled. A line such as **Sent 1.5 KB to api.example.com and received 3.0 KB (4 requests)** sums what it sent to one address while it ran. The record holds only addresses, counts and versions, never your model, file contents or the full web addresses it requested. The newest 200 events of each extension are kept.

Choose **Clear activity…** to delete an extension's record and its network totals. The record stays after you uninstall an extension; it is listed under **Uninstalled extensions** until you clear it.

## Install an extension and read its permissions

Before anything is installed, PushForm shows an install dialog. PushForm draws this dialog itself; the extension cannot change it. It names the extension, publisher and version, and its integrity label. It lists every permission in a plain sentence, such as **Can read the model**, and each internet address with its purpose and whether it receives model data. It also shows which editors it works in, its license and a link to its source code when the publisher provides one.

Choose **Install** to allow what is listed, or **Cancel** to install nothing. Permissions marked **Unavailable** have been revoked and will not be granted; their reasons appear beside them. When an update or a reload asks for more, the dialog's title says **Update** or **Reload**, and each added permission or address is marked **New**.

## Review an official update or security revocation

In **Extensions**, choose **Check for updates**. An available replacement has a **Review update** button. Open it to read the verified package's permissions and destinations; added ones are marked **New**. Choose **Cancel** to keep the current release, or **Update** to approve the replacement. Work already running finishes on its current release before the replacement starts. Open panels then reload with the new release.

If PushForm revokes a release or its signing key, the next security check stops its runtime and cancels its work. The Installed row shows **Revoked** and the reason. It cannot be turned back on; install a safe replacement when one is available. Revoking a permission removes that permission and restarts the extension with its remaining grants. Revocation retains the extension's saved data and your model geometry.

## Recover an extension's saved properties

If a model contains properties from a missing plugin, Entity Info keeps its subsection and saved values. When a compatible official release is available, **Install** opens that plugin's host approval dialog. If an installed plugin cannot read newer saved data, a compatible release offers **Update** instead. Opening the model never installs or runs a missing plugin automatically.

When no compatible verified release is available, the subsection explains why it remains read-only. Saved values are retained. Reconnect and check for updates in Extensions if the directory is offline.

## Find an extension in the activity bar

Every extension that works in the open editor gets its own icon on the left menu bar, after Files, AI Chat and the Object browser. Hover over an icon to see the extension's name. Extensions appear in the order of their names, and only in the editors they support; an extension you turn off disappears from the bar.

Choose an icon to open the extension's side panel beside the editor. Choose it again, or the panel's close button, to close the panel. PushForm reopens the last extension panel you had open in that editor. An extension that has no side panel opens its tab instead (see below).

## Use an extension's side panel

The side panel is the narrow panel between the left menu bar and the editor, the same place Files and the Object browser open. Its header always shows the extension's icon and name, and says **Unsigned (developer)** for an extension you loaded yourself, so you can tell its content from PushForm's own. An extension with several views shows them as a row of tabs under the header.

The panel acts on the document you have open: switching documents reloads it for the new one. Drag the panel's right edge to resize it. In a narrow panel, buttons wrap onto more rows and tables scroll sideways; a drawing without a set height is sized to fit the panel's width.

## Open an extension as a tab

Wide content, such as a full cut list or a cutting diagram, opens as a tab in the tab strip next to your documents, with the extension's icon and a close button. Open it from the side panel (for example its **Open cut list** button), from a toolbar button, from command search by typing the tab's name, or from the left menu bar when the extension has no side panel.

The tab fills the editor area: the toolbar, the status bar, the left menu bar and the side panel stay, so you can keep the extension's side panel open beside its tab. The tab belongs to the document it was opened from. Choose a document tab to go back to editing; the extension tab stays open behind it until you close it. When the extension selects or frames something in your model from its tab, PushForm switches to the document so you can see it. Closing the document closes its extension tabs. Extension tabs are not reopened after you reload the page.

## Extension buttons in the toolbar and command search

An extension can add a button to the modeling toolbar at the end of one of its groups (Transform, Draw, Modify, Inspect, Organize or Navigate), after a thin separator. Hover over it to see the button's name; it is also named after its extension for screen readers. Pressing it runs the extension's action, which may open the extension's tab.

Extension commands and tabs appear in command search with the extension's name beside them. Typing the extension's name lists them. When something is selected in Modeling, right-click to find the extension's actions in a submenu named after the extension.

An extension can open a dialog over its side panel or tab, for example to edit one item. PushForm draws the dialog with its own title bar and close button. Press Escape or choose the close button to dismiss it.

## Save a file from an extension

PushForm names the extension and explains the export before you choose **Choose where to save?**. The desktop app then opens the system save dialog. Cancel either dialog to leave your files unchanged. The extension receives the saved file name, without its folder path.

## Print from an extension

When an extension offers to print, for example a parts list or a sheet of labels, PushForm shows its own print dialog. It names the extension and what it wants to print, the number of pages and the page size, with a preview of the first page. Choose **Print…** to open your browser's print dialog, **Save as PDF…** to save the pages as a PDF file, or **Cancel** to print nothing. The extension learns only whether you printed or saved.

PushForm draws the pages itself from what the panel shows. Drawings print one per page. Tables continue over as many pages as they need, with the column headings repeated at the top of each page and the page number at the bottom. Columns you hid in the panel are left out, and lengths, areas and volumes use the document's units, as in the panel. Printed text uses Latin letters only: a symbol such as Σ is spelled out (**Sum**), and characters from other alphabets print as **?**. Set the paper size in your printer settings to match the page size in the dialog, and print at 100 % scale.

## Cancel an extension command that is running

A command that takes a moment shows its name and the extension's name above the status bar, with **Cancel**. You can keep editing while it runs. **Cancel** stops it. If the command fails, its message stays there until you choose **Dismiss**.

## When an extension stops after a problem

If an extension breaks or stops responding, PushForm ends it and shows a notice naming the extension and what it was doing. Work it had not finished is discarded; everything it had already applied to your document stays, and Undo works as usual.

Choose **Restart** to try again, which also reloads its open panel. Choose **Disable** to turn it off, or the close button to hide the notice. An extension that stops 3 times within 10 minutes is turned off automatically, and the notice offers **Turn on and restart**.

PushForm checks an installed extension's files before running it, once each session. If they no longer match the files that were installed, for example because the browser's storage was changed, PushForm doesn't run any of it. Its commands and panels are not listed, and a notice says that it was not started because its installed files could not be verified, and names the file or check that failed. Uninstall it and install it again from its package. **Disable** turns it off and hides the notice.

## Turn an extension off or uninstall it

In the Extensions panel, clear an extension's **On** checkbox to turn it off. Its panels and commands disappear and it stops running; turn it back on at any time.

To remove it, choose **Details**, then **Uninstall…**. Select **Also delete its settings** to remove what it saved for you as well, or leave it cleared to keep those settings if you install it again. Uninstalling never changes your documents.

## Load your own extension in developer mode

Developer mode lets you load an unsigned extension package from a file, for example one you are building. In the Extensions panel, select **Allow unsigned extensions on this device** under **Developer mode**, read the warning, and choose **Turn on developer mode**. Then choose **Load extension from file…** and pick the package's `.zip` file. The install dialog opens as usual, labelled **Unsigned (developer)**. Loading the same version again shows **Reload**.

Unsigned extensions run with the same protections as official ones, stay on this device and are not added to your account. They cannot use PushForm's own names or replace an official extension. Turning developer mode off turns every unsigned extension off; they stay installed until you uninstall them.

## Properties saved with a model

Extensions that use document metadata save their properties with the model, separately from their account settings.
Those properties remain in native files and saved revisions when the extension is turned off or uninstalled. A
compatible extension version is needed to edit them again. Models containing this metadata require a current reader;
older applications refuse them rather than discarding the properties.

## Edit extension properties in Entity Info

Plugins can add collapsible subsections below the core fields in Entity Info. Open a subsection to load its controls.
For repeated parts, edits start with the selected placements. Choose **All placements of shared bodies** explicitly
to edit shared defaults; the subsection shows the affected placement count and any existing placement data.
Mixed fields identify differing values, and inherited fields can show their source. A field you leave untouched
keeps its existing values. Unsupported selections are reported before editing.

A disabled plugin's saved properties remain visible as a notice with an Enable action. Newer saved data stays
read-only until a compatible plugin is available. When this host has no verified install or update action, the
notice explains that limitation. Opening a model never installs a plugin automatically.

## Extension properties through model edits

Moving or regrouping parts keeps their extension properties attached. Copies carry their applicable properties,
and Undo restores the properties along with the model. A split or join can leave an attachment needing review
when its owner is ambiguous; its saved values are retained for the extension to resolve. Pasting between models
keeps references that can be mapped to the pasted parts and marks external references as unresolved.

When a plugin creates model items together with their saved properties, those changes can form one Undo action.
If the plugin reports a validation or cancellation failure, the combined edit is rolled back. Duplicating a material
preserves its applicable plugin properties, including properties from disabled plugins. Deleting a material reverts
its painted users to default; related saved references can remain for explicit review.

Purge Unused keeps materials that saved plugin properties reference, such as banding used only by Cut List.
A material with only its own unused configuration can still be purged.


## Saved extension libraries and presets

Extensions can save reusable libraries and presets separately from their model properties. Official extensions
keep these with your signed-in account. Unsigned developer extensions keep them on this device for that account.
Turning an extension off, updating it, or uninstalling while keeping its settings preserves its saved libraries.
Uninstalling with **Delete settings** also removes its libraries and presets; deleting your account removes the
account copies. If another tab or device changes a saved library, refresh its preview before replacing it.
An unavailable account store reports an error, so a save cannot silently become a temporary local copy.

A saved binary library can hold up to 64 MiB. Each extension can keep up to 500 libraries or presets totaling
512 MiB; the account limit is 2000 totaling 2 GiB. Recently removed or cancelled uploads can occupy storage until
cleanup finishes. If storage is full, remove unused libraries and retry after cleanup. File import/export and
material-library contents depend on the extension; these storage limits do not add an import workflow by themselves.


## Open or save a large extension file

PushForm names the extension and its purpose before asking you to choose a file or save location. A large import
or export can transfer in smaller pieces while keeping the same permission prompts. Files can be up to 64 MiB.
Preparing an export does not save it; you still choose its destination. Cancelling preparation or a pending choice
stops that transfer. A file already saved stays saved if cancellation arrives afterward. Temporary transfers expire
and are cleared when the extension stops; they are separate from saved libraries and model properties.


## Modeling tools from extensions

An extension can add modeling tools to command search. Start one with an open model. Instructions, numeric fields
and choices appear in the editor, and previews use the model viewport. The model's units are the default for typed
lengths; you can include a unit explicitly.

Use the usual camera controls to inspect a preview. Press Escape to cancel a tool and discard work it has not
committed. Successful geometry changes remain available through Undo. Starting a different working tool or
switching models ends the extension tool. Turning off an extension or closing its model clears its preview too.
If a tool stops responding, PushForm clears it and displays a notice; start it again to retry.

## Native module libraries in extensions

Extensions can capture a body or assembly as a reusable native snapshot without changing your model, selection or
clipboard. Snapshots keep geometry, materials, images and saved extension properties together. An extension can
inspect the geometry and its own properties while PushForm retains the other extensions' data.

Saving to a personal library requires settings access and uses the same account or device storage as that
extension's other libraries. Exporting asks you to choose a file destination. Unsaved snapshots expire after five
minutes or when the extension stops; saved library entries remain. The extension provides its own library controls
and determines which modules it can fit or place.

When an extension places a module, PushForm keeps its native geometry and saved properties together. Repeated
unchanged component placements can share their definition; an independent copy stays separate. Edited imports are
preserved when another copy is placed from the saved snapshot. Placement is one Undo step, and a failed or cancelled
operation leaves the model unchanged. Fitting a module to a new opening depends on the extension's authored fitting
controls.

An extension can edit a module's own saved properties in a new snapshot while keeping the original available.
Compatible older properties can be upgraded with the edit without replacing unrelated saved values. Newer or
incompatible data stays retained and requires the appropriate extension or migration before editing.

## Stretching assemblies in extensions

Extensions can stretch native solid assemblies while keeping curved details intact. A placement edit separates
shared geometry when necessary; an explicit shared edit affects every use of that definition. Subassemblies that
move together keep their linked geometry. A stretch plane crossing a protected curve is refused, and failed or
cancelled batches leave no partial edit. Drawings, guides, images and imported display meshes currently need to be
separated from a stretched assembly. The extension supplies the stretch and fitting controls.

## Fitting modules in extensions

An extension can prepare a fitted module preview without editing your model or overwriting the saved source.
PushForm measures the complete solid geometry and checks the preview's width, depth and height before returning
it. Fitting retains curved details and textures; an unsupported curve crossing or a size mismatch is refused.
The extension aligns the fitted module with the opening and provides the preview and placement controls. A failed
or cancelled fit leaves the source and your model unchanged.
