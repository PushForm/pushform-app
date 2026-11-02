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

A panel opens in the side panel. One with wide tables or drawings can ask to open in a large window instead by
passing `presentation: 'window'` to `ui.mount`; `ui.update` keeps the presentation unless it names one. The user can
move the panel either way from its header, and once they do, their choice wins over the request.

## Services and permissions

Everything PushForm offers is on `context`, and only what the user granted is there. Reading a service you lack
throws an error naming the permission to request.

| Service | Permission | What it does |
| --- | --- | --- |
| `ui` | none | Show and update sidebars, panels, inspectors and settings blocks; open a panel's tab; hear user input |
| `log` | none | Write diagnostic lines |
| `document` | none | The units the document's lengths are shown in, and when they change |
| `model` | `model.read`, `model.write` | Read and query the model, follow its changes, and change it in undoable batches |
| `selection` | `selection.read`, `selection.write`, `viewport.presentation` | Read and set the selection; frame entities in the view |
| `settings` | `settings` | One JSON object of settings, kept with the user's account |
| `files` | `file.read`, `file.export` | Ask the user for a file to open, or where to save one |
| `clipboard` | `clipboard.write` | Write text, HTML or a PNG, right after the user acts on your extension |
| `http` | `network` (and `model.egress`) | Request a destination declared in the manifest |
| `compute`, `wasm` | declared WASM modules | Run WebAssembly modules in their own workers |

Every call is asynchronous and takes plain data. A failure has a stable `code` (`permission.denied`,
`revision.stale`, `limit.exceeded`, `validation.failed`, `cancelled`, `unavailable`, `extension.unsupported`,
`extension.failed`, `document.closed`); test it with `isExtensionError(error, 'cancelled')`. Long calls accept a
`signal` and an `onProgress` callback.

Lengths are meters, areas square meters, volumes cubic meters and angles degrees. `units` converts common workshop
units, and number fields and table columns with a `quantity` are shown in the document's own units.

## The document

`model`, `selection` and `document` act on one open document. A contribution handler receives its document's handle
as `invocation.document`; pass it as `document` to name that document, which stays bound to it when the user switches
tabs. Without it, a call acts on the document of your latest invocation, which for a panel is the document it is
shown with. Calls on a document that has closed fail with `document.closed`.

```ts
context.commands.register('com.example.parts.panel', async (_params, { document }) => {
  const { name, units } = await context.document.info({ document }); // the tab's title; { system, lengthUnit, format, lengthPrecision }
  const { revision } = await context.model!.read({ document });
  const page = await context.model!.query({ document, kinds: ['instance'], fields: ['bounds'] });
  await context.selection!.set({ document, refs: page.entities.map((e) => ({ kind: 'instance', id: e.ref.id })) });
  await context.model!.apply({ document, expectedRevision: revision, label: 'Name the shelf',
    operations: [{ op: 'rename_instance', ref: { kind: 'instance', id: page.entities[0]!.ref.id }, name: 'Shelf' }] });
});
context.document.onChange(({ name, units }) => render(name, units)); // renamed, units changed, or another document
context.model!.onChange(({ revision, changes }) => refresh(revision, changes)); // after model.subscribe
```

A query returns one page of at most 200 entities; fields you leave out are null (the open container, every kind but
faces, 50 entities). A batch applies every operation or none and is one undo entry named after your extension; it
fails with `revision.stale` when the model changed since the revision you read. References name entities of the
container open in the editor, or, with the `path` a read reports, entities inside a group or component: `selection.set`
highlights those in place without opening the group, as choosing them in the Object browser does, and `selection.frame`
fits the camera to their world bounds. A batch's operations take only entities of the batch's own container.

## Interfaces

Interfaces are trees of PushForm's own components: `stack`, `divider`, `text`, `message`, `progress`, `button`,
`textField`, `numberField`, `checkbox`, `choice`, `colorField`, `tabs`, `tree`, `table`, `vector`, `section` and
`menu`. Send the whole tree each time, with a higher `seq`; a tree that is invalid or too large is refused and the
previous one stays on screen. There is no HTML, CSS or script.

Dense interfaces have a few more tools. A `section` is a collapsible group with a title, an optional subtitle and
badge, and up to eight header action buttons; its header reports `collapse` and an action reports `press` with its
id in `action`. A `menu` is a button that opens a dropdown of up to fifty items and reports `select` with the chosen
item's id. Buttons, menus and section actions can carry an `icon` from PushForm's own set (`add`, `delete`, `print`,
`more` and so on, listed in `UiIcon`), and `variant: 'icon'` shows just the icon for compact toolbars, with the label
as the accessible name. A vector view's `fitWidth` sizes it as if the drawing were that wide, so an off-cut given a
full sheet's width draws smaller than the sheet.

`ui.dialog({ target, seq, title, tree })` shows a modal dialog over a mounted target, drawn by PushForm with its own
frame and Close button; a higher `seq` replaces its title and tree in place. Events from its components arrive like
the target's own. `ui.closeDialog({ target })` closes it; so does the user, with Escape or the Close button, which you
hear as a `dialogClose` event naming the dialog tree's root. A target has one dialog at a time, and it goes with the
target when that is unmounted.

## The runtime

Your code runs in a worker of its own with no network, no DOM and no way to load code beyond your package. It may
hold at most 256 MiB of binary data at once: buffers, typed arrays, Blobs and Files, including copies and data that
arrives from PushForm. Past that, the allocation (or the call that would deliver the data) fails with a `RangeError`
or an error with code `limit.exceeded`. Memory comes back once the garbage collector has freed it, so a loop that
allocates large buffers without yielding counts everything it made. The worker has no `MessageChannel`,
`BroadcastChannel`, `Response` or `Request`, no readable byte streams, and no canvas, image, media, font,
notification or user timing interfaces. Compression streams, `TextEncoder`, `structuredClone` and Blob reading work
as usual.

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

Pass `document: { model, units }` to give invocations a document whose model operations are a fake of your own;
`host.document` then changes its units, reports changes and closes it.

## License

MIT. See `LICENSE`.
