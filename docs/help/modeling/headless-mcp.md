# Open and save models with the headless MCP tool

From a PushForm development checkout, run `node packages/mcp/bin/pushform-mcp.mjs --headless [model.pf]` as the stdio server for your MCP client. With no file, it starts an empty model. This opens a separate model in the server process; it does not control an existing browser tab.

Use `model_open` with a local path to open a model, and `model_save` to save it. Saves use the same native `.pf` format as the application and include stored images. After opening a file or saving with a path, `model_save` can reuse that path. A failed open keeps the current model; `model_new` deliberately replaces it with an empty one.

Model edits use command tools, and `edit_undo` and `edit_redo` control their history. Portable files do not retain undo history from the previous session. Coordinates are meters with Z up. Layout drawings are not supported by this headless modeling server.
