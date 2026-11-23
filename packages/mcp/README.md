# @pushform/mcp

`pushform-mcp` is an MCP server for PushForm. It has two modes.

## `--live`: watch an agent edit your open model

```sh
pushform-mcp --live [--port 47615] [--code CODE]
```

An MCP client such as Claude Code or Claude Desktop starts the server. The server listens on `ws://127.0.0.1:47615` and only accepts connections from this computer. To connect, click **Connect agent** in PushForm's status bar and enter the port and the pairing code. From then on, the agent works on the active 3D model tab and you see each change as it happens.

- The agent gets the same tools that AI Chat uses inside the app (`model_get_document`, `model_query`, `model_apply_operations`, `model_view`, `model_render`, `model_find_overlaps`, `model_material_library`, `model_builder_info`) and follows the same model-editing rules, which arrive as the server's instructions. It also gets a `pushform_status` tool that reports whether a window is connected and how to connect one.
- Each batch is one Undo step, named "External agent: …".
- `model_render` draws pictures in the app's own viewport and leaves your view where it is.
- None of this goes through a backend, and AI Chat doesn't need to be set up.
- Each start creates a new pairing code. To keep the same code across restarts, pass `--code` or set `PUSHFORM_AGENT_CODE`. The app remembers the last port and code, and it reconnects automatically whenever the agent restarts.

Claude Code:

```sh
claude mcp add pushform -- node /path/to/pushform-app/packages/mcp/bin/pushform-mcp.mjs --live --code MY-CODE-1234
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "pushform": { "command": "node", "args": ["/path/to/pushform-app/packages/mcp/bin/pushform-mcp.mjs", "--live", "--code", "MY-CODE-1234"] } } }
```

Only one PushForm window can be connected at a time. If a second window pairs, it takes over and the first is disconnected.

## `--headless`: a model of its own

```sh
pushform-mcp --headless [model.pf]
```

This mode serves a model in memory, with no window. It offers every registry command as a tool, plus tools to open, save and read models.
