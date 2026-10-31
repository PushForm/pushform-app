# @pushform/extension-sdk

Types and small helpers for building PushForm extensions. MIT licensed, so an extension under any license can use
it. It has no dependencies and adds almost nothing to a bundle: the types describe what PushForm passes your code,
and the helpers (`isExtensionError`, `units`) are a few lines each.

Status: the extension API is version `0.1.0` and still changing. This package is not published to npm yet.

## An extension in brief

An extension is a package: `manifest.json`, one ES module entry point (`main`, by default `main.js`), any JavaScript
it imports by relative path, optional WebAssembly modules, icons and locale files. Bundle your dependencies; packages
cannot import anything from outside themselves.

The entry module exports `activate(context)` and, optionally, `deactivate()`. PushForm imports it when the user first
needs the extension, never at startup:

```ts
import type { ExtensionContext, UiNode } from '@pushform/extension-sdk';

export function activate(context: ExtensionContext): void {
  let seq = 0;
  const view = (count: number): UiNode => ({ type: 'stack', id: 'root', children: [
    { type: 'text', id: 'count', text: `Pressed ${count} times` },
    { type: 'button', id: 'add', label: 'Add one', variant: 'primary' },
  ] });
  let count = 0;
  context.commands.register('com.example.counter.panel', async () => {
    await context.ui.mount({ target: 'com.example.counter.panel', seq: ++seq, tree: view(count) });
  });
  context.ui.onEvent(async (event) => {
    if (event.component === 'add' && event.event === 'press')
      await context.ui.update({ target: 'com.example.counter.panel', seq: ++seq, tree: view(++count) });
  });
}
```

Every contribution (a command, a panel, a selection action and so on) is declared in the manifest and wired up here
by its id. Contribution ids start with the extension id.

## Services and permissions

Everything PushForm offers is on `context`, and only what the user granted is there. Reading a service you lack
throws an error naming the permission to request.

| Service | Permission | What it does |
| --- | --- | --- |
| `ui` | none | Show and update panels, inspectors and settings blocks; hear user input |
| `log` | none | Write diagnostic lines |
| `model` | `model.read`, `model.write` | Read the document and change it in undoable batches |
| `selection` | `selection.read`, `selection.write`, `viewport.presentation` | Read and set the selection; frame it in the view |
| `settings` | `settings` | One JSON object of settings, kept with the user's account |
| `files` | `file.read`, `file.export` | Ask the user for a file to open, or where to save one |
| `clipboard` | `clipboard.write` | Write text, HTML or a PNG, right after the user acts on your extension |
| `http` | `network` (and `model.egress`) | Request a destination declared in the manifest |
| `compute`, `wasm` | declared WASM modules | Run WebAssembly modules in their own workers |

Every call is asynchronous and takes plain data. A failure has a stable `code` (`permission.denied`,
`revision.stale`, `limit.exceeded`, `validation.failed`, `cancelled`, `unavailable`, `extension.unsupported`,
`extension.failed`); test it with `isExtensionError(error, 'cancelled')`. Long calls accept a `signal` and an
`onProgress` callback.

Lengths are meters, areas square meters, volumes cubic meters and angles degrees. `units` converts common workshop
units, and number fields and table columns with a `quantity` are shown in the document's own units.

## Interfaces

Interfaces are trees of PushForm's own components: `stack`, `divider`, `text`, `message`, `progress`, `button`,
`textField`, `numberField`, `checkbox`, `choice`, `colorField`, `tabs`, `tree` and `table`. Send the whole tree each
time, with a higher `seq`; a tree that is invalid or too large is refused and the previous one stays on screen. There
is no HTML, CSS or script.

## WebAssembly compute

Declare each module in the manifest with its memory maximum (in 64 KiB pages) and time limit. A module imports its
memory as `pf.memory` and may import `pf.progress`, `pf.partial` and `pf.should_stop`, nothing else. It exports
`pf_abi_version` (returning 1), `pf_alloc(len)` and `pf_run(ptr, len)`, which returns a pointer to a little-endian u32
length followed by the output bytes. `pf.should_stop()` turns true shortly before the time limit, so a solver can
return its best result.

## Packaging and testing

`@pushform/extension-dev` (GPL-3.0-or-later; a development tool, not bundled into your extension) packs a build
directory into a validated package and runs your entry module against the real extension runtime in tests:

```sh
pushform-extension pack dist --out my-extension.zip
pushform-extension validate my-extension.zip
```

```ts
import { createTestHost } from '@pushform/extension-dev';
const host = await createTestHost({ manifest, module: await import('./dist/main.js') });
await host.invoke('com.example.counter.panel');
host.press('com.example.counter.panel', 'add');
```

## License

MIT. See `LICENSE`.
