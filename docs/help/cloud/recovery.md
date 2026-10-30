# Save problems and recovery

## Check whether changes are saved

Read the header's cloud save status. **Changes pending** means the document has edits that still need saving; saving in progress is different from **All changes saved**.

Edits made during an upload can require a later save. Do not treat a file thumbnail or a completed earlier save as proof that the latest changes have been uploaded.

## Recover from an offline or failed save

Keep the document open and read the status or error. Network failures retry with increasing delays. Reconnecting resumes pending saves while your sign-in session is valid.

If an account session expires, sign back into the same account. Do not close or discard the document while relying on unsaved changes. Refresh recovery depends on the browser's ability to keep its local session data.

When IndexedDB is available, the editor keeps binary recovery checkpoints, including model images, separately from session storage. Refresh restores the last completed checkpoint and its active tab. A failed checkpoint leaves the previous one available. Closing the browser immediately after an edit can interrupt a pending checkpoint; recovery is not a substitute for a completed cloud save.

## Handle a save conflict

A conflict means the cloud revision differs from the one the editor opened. Automatic retries stop to avoid overwriting newer content. Use the offered resolution, such as **Save As…**, if you need a separate file containing your current work.

A copy is a new cloud document, not an overwrite of the other revision. Check its name and destination.

## Close a document with pending changes

Closing an editor document first attempts to flush pending cloud changes. If saving fails, the document remains open and offers save, discard or cancel choices. Discard is an explicit decision to give up those pending changes.

Returning Home is different: documents remain open and pending autosaves continue. Use Continue working to return.
