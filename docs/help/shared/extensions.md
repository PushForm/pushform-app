# Extensions: install, use, turn off and developer mode

## What extensions are and where they work

Extensions add side panels, tabs, toolbar buttons and commands to PushForm, such as a cut list for a model. Each one runs separately from the editor, so a slow or broken extension cannot freeze your work, and it can do only what you allowed when you installed it.

Extensions run in the web editor in Chrome, Edge, Firefox and other Chromium-based browsers. In Safari the Extensions window opens but says extensions cannot run there. The desktop app does not offer extensions yet.

## Open the Extensions window

Open your account control in the header and, in the account dialog, choose **Manage extensions…**, or type **Extensions** in command search. The window works from Home and from both editors. Opening it never starts an extension.

Each installed extension shows its name, publisher, version and whether it is **Official, countersigned by PushForm** or **Unsigned (developer)**. Below that you see whether it is running, starting, not running or stopped after a problem. Choose **Details** to see what it is allowed to do, when it was installed, its network use and activity, and, for a side-loaded extension, its log. Memory and processor use read **unavailable** in the browser, because they cannot be measured per extension.

## Read an extension's activity and network use

PushForm keeps a record of what happens to each extension on this device, for your account. Choose **Details** to see it.

**Network** lists each internet address the extension may use, with what it sent this session, what it sent in total and what it received in total. An extension without addresses reads **No internet access**.

**Activity** lists the newest events first, each with its date and time: installed, updated or reloaded, permissions allowed or removed, turned on or off and why, started, stopped and why, and uninstalled. A line such as **Sent 1.5 KB to api.example.com and received 3.0 KB (4 requests)** sums what it sent to one address while it ran. The record holds only addresses, counts and versions, never your model, file contents or the full web addresses it requested. The newest 200 events of each extension are kept.

Choose **Clear activity…** to delete an extension's record and its network totals. The record stays after you uninstall an extension; it is listed under **Uninstalled extensions** until you clear it.

## Install an extension and read its permissions

Before anything is installed, PushForm shows an install dialog. PushForm draws this dialog itself; the extension cannot change it. It names the extension, publisher and version, and its integrity label. It lists every permission in a plain sentence, such as **Can read the model**, and each internet address with its purpose and whether it receives model data. It also shows which editors it works in, its license and a link to its source code when the publisher provides one.

Choose **Install** to allow exactly what is listed, or **Cancel** to install nothing. When an update or a reload asks for more, the dialog's title says **Update** or **Reload**, and each added permission or address is marked **New**.

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

In the Extensions window, clear an extension's **On** checkbox to turn it off. Its panels and commands disappear and it stops running; turn it back on at any time.

To remove it, choose **Details**, then **Uninstall…**. Select **Also delete its settings** to remove what it saved for you as well, or leave it cleared to keep those settings if you install it again. Uninstalling never changes your documents.

## Load your own extension in developer mode

Developer mode lets you load an unsigned extension package from a file, for example one you are building. In the Extensions window, select **Allow unsigned extensions on this device** under **Developer mode**, read the warning, and choose **Turn on developer mode**. Then choose **Load extension from file…** and pick the package's `.zip` file. The install dialog opens as usual, labelled **Unsigned (developer)**. Loading the same version again shows **Reload**.

Unsigned extensions run with the same protections as official ones, stay on this device and are not added to your account. They cannot use PushForm's own names or replace an official extension. Turning developer mode off turns every unsigned extension off; they stay installed until you uninstall them.
