# Finding your way around PushForm

## Switch documents or create another one

Choose a document tab to make it active. The **+** button opens the new-document menu for a Model or a Layout drawing. Each document has its own editing history and tools.

The PushForm logo or name returns Home without closing the open documents. Use Continue working to return to one. The left menu bar is shown in editors, not on Home.

## Find a command by name

Press **Cmd+K** on macOS or **Ctrl+K** on Windows or Linux to focus command search. Type the tool or action's name, use Up or Down to choose a result, and press Enter. Escape closes search without running anything.

Search follows the active document: a Layout tab does not offer Modeling's Push/Pull. A disabled result cannot run until its requirements are met.

Exact command names appear before longer matches. For example, typing **Save As** selects **Save As…** before **Save as Template…**.

## Use side panels

The left menu bar opens **Files** at the top, followed by **AI Chat**, the **Object browser** and a button for each panel of an extension you have turned on. Choosing one replaces the other in that dock. Drag the dock's right edge to resize it; the width is remembered by the browser.

A focused panel resize handle also responds to Left and Right arrows. Holding Shift makes larger steps. Escape within the Object browser closes it and returns focus to its menu-bar button.

## Browse files without leaving your drawing

Click **Files**, the top icon in the left menu bar in either workspace. Start by choosing a project. Its root shows folders first, followed by files with preview images when available. Click a folder to go inside; **Back** returns one level, eventually to the projects. The panel keeps your location when you switch between Modeling and Layout or hide and reopen it.

Click a file to open it. A file already open switches to its existing tab, keeping unsaved edits. Opening a Layout template creates a new drawing. **Search projects** filters the project list; **Search project files** finds files throughout the selected project. Use **Previous** and **Next** for more files, or **Refresh files** to reload. Previews load from the local cache first, then the cloud; missing previews are generated in a background queue. Cached previews remain available offline. Files whose previews cannot yet be generated show their document icon. Escape inside Files closes the panel.

## Organize files from the sidebar

Use **New project** on the project screen or **New folder** inside a project. Enter a name and choose **Create**. A new folder is created in the location you are viewing.

Right-click a project, folder or file (or focus it and press **Shift+F10** or the Context Menu key) to **Rename**, **Move…**, or **Move to Trash**. Move lets you choose a destination folder; files may also move to another project. Folders stay in their project. Open document tabs follow successful file renames and moves. To restore trashed items or delete them permanently, return Home and open **Trash**.

The editor header has no separate Cloud files button; use the **Files** rail or return **Home**.

## Undo, redo and cancel

Use **Ctrl/Cmd+Z** for Undo. **Ctrl/Cmd+Shift+Z** or **Ctrl/Cmd+Y** performs Redo where supported. The active document owns its undo history.

Escape cancels the current tool placement or draft where the tool supports cancellation. In a text field, table cell, menu or dialog, keys belong to that editor first. Finish the edit or return focus to the drawing before using drafting shortcuts.

## Read notifications

Short notifications appear near the lower right. They do not move focus or change your document. Hovering or focusing a notification pauses its dismissal timer; use its Dismiss button to close it immediately.

A notification that a tool needs selected objects means the action did not proceed. Select suitable objects and try again rather than assuming a hidden change occurred.
