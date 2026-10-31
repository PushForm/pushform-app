# Extensions: install, use, turn off and developer mode

## What extensions are and where they work

Extensions add panels and commands to PushForm, such as a parts list for a model. Each one runs separately from the editor, so a slow or broken extension cannot freeze your work, and it can do only what you allowed when you installed it.

Extensions run in the web editor in Chrome, Edge and other Chromium-based browsers. In Safari the Extensions window opens but says extensions cannot run there. The desktop app does not offer extensions yet.

## Open the Extensions window

Open your account control in the header and, in the account dialog, choose **Manage extensions…**, or type **Extensions** in command search. The window works from Home and from both editors. Opening it never starts an extension.

Each installed extension shows its name, publisher, version and whether it is **Official, countersigned by PushForm** or **Unsigned (developer)**. Below that you see whether it is running, starting, not running or stopped after a problem. Choose **Details** to see what it is allowed to do, how much it sent to the internet this session, when it was installed and, for a side-loaded extension, its log. Memory and processor use read **unavailable** in the browser, because they cannot be measured per extension.

## Install an extension and read its permissions

Before anything is installed, PushForm shows an install dialog. PushForm draws this dialog itself; the extension cannot change it. It names the extension, publisher and version, and its integrity label. It lists every permission in a plain sentence, such as **Can read the model**, and each internet address with its purpose and whether it receives model data. It also shows which editors it works in, its license and a link to its source code when the publisher provides one.

Choose **Install** to allow exactly what is listed, or **Cancel** to install nothing. When an update or a reload asks for more, the dialog's title says **Update** or **Reload**, and each added permission or address is marked **New**.

## Use an extension's panels and commands

An extension's panel gets its own button on the left menu bar, next to Files, AI Chat and the Object browser. Hover over it to see the panel and extension name. Choose it to open the panel; choose it again or the panel's close button to close it. The panel header always names the extension, so you can tell its content from PushForm's own. A panel appears only in the editors the extension supports, and PushForm reopens the last extension panel you had open in that editor.

Extension commands appear in command search with the extension's name beside them. Typing the extension's name lists its commands. When something is selected in Modeling, right-click to find the extension's actions in a submenu named after the extension.

## Cancel an extension command that is running

A command that takes a moment shows its name and the extension's name above the status bar, with **Cancel**. You can keep editing while it runs. **Cancel** stops it. If the command fails, its message stays there until you choose **Dismiss**.

## When an extension stops after a problem

If an extension breaks or stops responding, PushForm ends it and shows a notice naming the extension and what it was doing. Work it had not finished is discarded; everything it had already applied to your document stays, and Undo works as usual.

Choose **Restart** to try again, which also reloads its open panel. Choose **Disable** to turn it off, or the close button to hide the notice. An extension that stops 3 times within 10 minutes is turned off automatically, and the notice offers **Turn on and restart**.

## Turn an extension off or uninstall it

In the Extensions window, clear an extension's **On** checkbox to turn it off. Its panels and commands disappear and it stops running; turn it back on at any time.

To remove it, choose **Details**, then **Uninstall…**. Select **Also delete its settings** to remove what it saved for you as well, or leave it cleared to keep those settings if you install it again. Uninstalling never changes your documents.

## Load your own extension in developer mode

Developer mode lets you load an unsigned extension package from a file, for example one you are building. In the Extensions window, select **Allow unsigned extensions on this device** under **Developer mode**, read the warning, and choose **Turn on developer mode**. Then choose **Load extension from file…** and pick the package's `.zip` file. The install dialog opens as usual, labelled **Unsigned (developer)**. Loading the same version again shows **Reload**.

Unsigned extensions run with the same protections as official ones, stay on this device and are not added to your account. They cannot use PushForm's own names or replace an official extension. Turning developer mode off turns every unsigned extension off; they stay installed until you uninstall them.
