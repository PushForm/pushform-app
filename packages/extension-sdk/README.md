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
| `tools` | `tool.interaction`; edits also need `model.write` | Active modeling-tool input, transient previews and cancellable geometry edits |
| `document` | none | The units the document's lengths are shown in, and when they change |
| `model` | `model.read`, `model.write` | Read and query the model, follow its changes, and change it in undoable batches |
| `metadata` | `model.read`, `model.write` | Read and atomically edit only your document-owned metadata; requires a manifest schema |
| `selection` | `selection.read`, `selection.write`, `viewport.presentation` | Read and set the selection; frame entities in the view |
| `settings` | `settings` | One JSON object of settings, kept with the user's account |
| `assets` | `settings` | Private binary libraries and presets, with chunked transfers and revision checks |
| `fragments` | Per method: `model.read`, `settings`, `file.read`, `file.export` | Host-owned native module snapshots, geometry/own metadata queries, private libraries and file export |
| `files` | `file.read`, `file.export` | Ask the user for a file to open, or where to save one |
| `clipboard` | `clipboard.write` | Write text, HTML or a PNG, right after the user acts on your extension |
| `http` | `network` (and `model.egress`) | Request a destination declared in the manifest |
| `compute`, `wasm` | declared WASM modules | Run WebAssembly modules in their own workers |

Every call is asynchronous and takes plain data. A failure has a stable `code` (`permission.denied`,
`revision.stale`, `limit.exceeded`, `validation.failed`, `cancelled`, `unavailable`, `extension.unsupported`,
`extension.failed`, `document.closed`); test it with `isExtensionError(error, 'cancelled')`. Long calls accept a
`signal` and an `onProgress` callback.

Lengths are meters, areas square meters, volumes cubic meters and angles degrees. `units` converts common workshop
units, and number fields and table columns with a `quantity` are shown in the document's own units. A `stack` can set `displayUnits`
(`lengthUnit`, `format`, `lengthPrecision`) for its subtree. Nested fields, tables and printed selections inherit
that display context. Numeric values and edit events still use canonical units; the document settings stay intact.

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
faces, 50 entities). With `geometry`, a face or sketch face carries its outline: `outerLoop` runs counterclockwise
about `normal`, each loop of `holes` runs clockwise, and all are in the container's coordinates. A loop of more than
512 points is simplified to 512 by dropping the points that change the outline least, and the face then reports
`truncated: true`; a page of faces ends early, with `next` set, once its loops hold 40,000 points, so always follow
`next`. A batch applies every operation or none and is one undo entry named after your extension; it
fails with `revision.stale` when the model changed since the revision you read. References name entities of the
container open in the editor, or, with the `path` a read reports, entities inside a group or component: `selection.set`
highlights those in place without opening the group, as choosing them in the Object browser does, and `selection.frame`
fits the camera to their world bounds. A batch's ordinary operations use its own container. Physical part operations
also accept captured descendant solids, as described below.

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

## Document-owned metadata

Declare `metadata: { dataVersion: 1, schema: { type: "object", properties: { label: { type: "string" } } } }` in your
manifest to use `context.metadata`. The initial implementation supports modeling documents; Layout document handles
return `unavailable`. The schema is declarative and independent of the interface you display. The
initial schema profile supports null, boolean, finite number, integer, string (enum and maximum length), arrays
(items and maximum count) and objects (properties, required fields and additional properties). Unlisted object
properties are rejected unless you explicitly allow them. Remote references, code and unsupported keywords are
rejected when validating the package.

`metadata.list({ document, targets, offset, limit })` reads a bounded ownership/reference index without decoding payloads. Omit `targets` to list all of your entries or supply typed targets to find their
attached properties without deriving record IDs from entity IDs.
`metadata.read({ document, ids })` returns your requested values and missing IDs. There is no owner parameter:
the host always uses your installed extension identity. Reads need `model.read`; writes need `model.write`.
Document handles stay bound to their documents after a tab switch and fail when that document closes.

```ts
const index = await context.metadata!.list({ document });
await context.metadata!.apply({
  document,
  expectedRevision: index.revision,
  expectedDataVersion: index.dataVersion,
  upserts: [{ id: 'job', target: { kind: 'document' }, value: { label: 'Cabinet' } }],
});
```

An apply batch contains at least one change, or explicitly replaces the record, with up to 200 upserts and 200 deletions. Each entry has a stable ID, typed target, JSON value
and optional typed references. A reference can name a model target directly or also name another entry in your
record with `entryId`. Do not put model identifiers in arbitrary JSON strings and expect the host to remap them.
Supported owners are document, material, definition, group, instance, shared body and full-path body occurrence.
Tracked face/edge descriptors can be carried on body references, as described below. Invalid targets, stale revisions, incompatible schemas and quotas
reject the whole batch and make no undo entry. Read the new revision after a `revision.stale` failure.

Returned values are detached copies. Index and value pages have a 1 MiB approximate response budget; request fewer
entries if a page exceeds it. `expectedRevision` on reads can keep a paginated scan on one revision. Follow document
changes with `model.subscribe`/`model.onChange`; dedicated metadata deltas are still in development.

Move and regroup preserve occurrence attachments. Duplicate and paste create fresh metadata entry IDs and remap
typed references between copied entries. Make Unique copies shared defaults and redirects the affected placement
overrides. Same-document paste retains existing shared component defaults; cross-document paste uses explicit
destination mappings, marking unmapped external references unresolved. Neither operation decodes your payloads.
Do not derive an entry ID from its target ID: use the index to find an attachment after a copy.

Deleting an owner removes its entries and invalidates inbound references. Ambiguous split/join results retain the
authored bytes with `needsReview: true`; they do not duplicate that identity onto every output. An explicit validated
upsert can resolve an attachment to a chosen target, and explicit replacement references clear unresolved links.
All of these model and metadata changes share one undo step and work while the extension is absent. Pasting
incompatible data versions or exceeding a storage quota fails the complete transaction.

Older saved values remain readable for an explicit migration. To change the record's data version, send
`replaceRecord: true` with the complete migrated record in one batch; omitted entries are removed. The host checks
the installed schema and preserves the original on failure and through Undo. Data newer than your declared version
can be listed but cannot be read or overwritten. Disabling or uninstalling your extension retains its committed data.

## Entity Info contributions

A `model.inspector.block` contribution can declare `inspector: { targets: ["bodyOccurrence", "body"], multiSelection: "mixed" }`.
The available selection modes are `none`, `homogeneous` (one target kind) and `mixed`. Targets can also include
`group`, `instance` and `definition`. Declare and obtain `model.read` and `selection.read` before receiving captures;
metadata editing also needs `model.write` and a metadata schema. Older inspector contributions without this declaration
are not surfaced in Entity Info.

Opening the subsection invokes its handler with `{ inspector: InspectorCapture }` and the captured document handle.
The capture includes `binding`, `revision`, `scope`, `targets`, `placementCount` and `overrideCount`. Echo `binding`
on `ui.mount/update/dialog/unmount/closeDialog`. UI events carry the same capture as `event.inspector`; echo its
binding as `inspectorBinding` on `metadata.apply`, use its revision and pass the invocation's document handle.
The host rejects expired bindings, writes outside the captured targets, unrelated deletions and whole-record replacement.
Changing selection, document, scope or model revision, or closing the subsection, revokes the old view. Late mounts
cannot replace the current inspector. Do not reread the live selection to decide where an inspector field edit goes.

Selecting a group for an inspector that accepts parts expands its solid bodies, with bounded traversal and at most
200 edit targets. Unsupported members and unsupported multi-selection combinations block editing; they are never
silently dropped. Placement editing is the initial scope; the user must explicitly choose shared body defaults.
Existing shared component targets stay shared unless the model operation copies them.

Text, number, checkbox and choice fields accept `mixed: true` and a bounded `source` caption, for example
`"From material: Maple"` or `"Different sources"`. Untouched mixed fields send no edit; checkboxes show an indeterminate
state. Your plugin resolves effective values and inheritance, validates its domain rules, and provides actions such
as Reset to inherited by removing the authored override. The host never infers inheritance from payload keys.
`overrideCount` counts distinct placements with saved entries for this plugin; it does not inspect their payloads.

The subsection names its plugin. Saved data without an available compatible inspector stays opaque and read-only.
Disabled installed plugins offer contextual Enable; this host currently has no verified install/update action in
Entity Info and explains that limitation. No general extension-management control is added to the pane.


A user action can call `context.ui.open({ target: inspectorId })` for the extension's own declared inspector.
The host activates the associated document, reveals Entity Info and opens the subsection in placement scope with
a fresh capture of the current selection. This does not reuse a previous inspector binding or change production
membership. Requests without a current user action, for another extension, or for an undeclared inspector are rejected.

Body summaries requested with `geometry` include `geometryVersion`, independently of the document revision.
Use it together with typed occurrence identity, transformations and all relevant material/cutting inputs to invalidate
geometry-dependent caches. A metadata-only document edit need not rerun an unchanged calculation. When the field is
absent on an older host, use the document revision conservatively.


A captured inspector's upsert must keep both an existing entry's owner and its resulting owner inside the captured
target set. Reusing an unrelated entry ID to pull data into that scope is refused. Explicit document-level recovery
can retarget an owned entry after user review. Retargeting an entry invalidates inbound metadata links whose declared
target no longer matches, in the same undo step; those references remain available for explicit review.


Body geometry summaries include `referenceFrame` (reference coordinates to the containing definition, column-major
4?4); bounds summaries include `referenceBounds` in that frame. Older files start at identity. Whole-body transforms
carry this frame with the solid, including across copy, regrouping, Make Unique and native reopen. Container-space
`bounds`, face loops and face normals keep their existing meanings.

`model.query({ ..., projection: [[x0,x1,x2], [y0,y1,y2], [z0,z1,z2]] })` adds `projectedBounds` for body bounds. Each
finite, nonzero vector is a local linear projection, with scale preserved. Bounds come from canonical solid vertices,
without transferring their mesh. Callers can pull world-space physical directions back through the occurrence's
linear transform to measure oriented physical extents. The result belongs to the returned document revision.
Omit projection, or pass null, for the ordinary query. Check that `projectedBounds` is present before relying on a host
that predates this feature. A body reference frame is an application geometry reference, separate from your plugin's
own manufacturing-frame metadata.


Solid face and edge queries with `geometry` include `element`, a detached topology descriptor containing the face id
or edge key and its `bodyVersion`. A metadata reference can store that descriptor alongside its body/body-occurrence
`target`. Use the descriptor from the current revision; a write rejects a stale version, absent element, or non-body
target atomically. References remain part of the host-readable envelope, outside the plugin's opaque payload.

The host carries these references through whole-body transforms, copies, regrouping, Make Unique and clipboard
transfer. Kernel edits retain bijective face continuations and uniquely corresponding edges. A whole-face push/pull
also identifies its moved cap explicitly. Split/merge or otherwise ambiguous provenance retains the old descriptor
with `unresolved: true`; output that depends on the assignment needs explicit review. Reusing the same numeric face
id is not evidence of continuity. Body versions may reset for a copy; use the remapped envelope returned by the host.

Native files with topology references require a reader that maintains them (capability 4). Undo/redo, native files
and session snapshots retain the descriptors even with the owning extension disabled. This reference API does not
supply a plugin-specific face/edge assignment or repair interface; plugins implement those using captured targets,
revision-checked metadata edits and the host's themed UI controls.


## Create model entities with saved extension properties

Use the optional `metadata` block on `model.apply` when a model edit and your properties must commit together.
The outer revision must match exactly, and `expectedDataVersion` is the current version from `metadata.list`.
Declare your schema in the manifest and request `model.write`. A `created` target uses an operation's same-batch
`as` name; its kind must match the created entity. Typed references can use the same aliases. Payload strings
stay literal. The host supplies your namespace and validator.

```ts
const index = await context.metadata!.list({ document });
const result = await context.model!.apply({
  document, expectedRevision: index.revision, label: 'Create configured material',
  operations: [{ op: 'add_material', as: 'stock', name: 'Maple', color: '#bba077' }],
  metadata: {
    expectedDataVersion: index.dataVersion,
    upserts: [{ id: crypto.randomUUID(), target: { kind: 'material', created: 'stock' }, value: { label: 'Maple stock' } }],
  },
});
```

Both changes form one independent undo entry. An invalid alias, value, target, version, quota or operation rolls
back the entire batch, as does cancellation. Document revisions and ID allocation remain monotonic on rollback;
reread before retrying. The result's `metadata` contains the changed IDs and data version. The same 200-upsert/
200-delete bounds apply. This block cannot replace a whole record or carry an inspector binding: migrations use
explicit `metadata.apply` replacement, and Entity Info edits use their captured `inspectorBinding`.

Model batches also support `duplicate_material`, `remove_material` and `purge_materials`. Duplication copies the
host-tracked material attachments for every plugin without decoding their payloads. Removal reverts painted users
to default; the default material cannot be deleted. Purge uses the host's material-use rules.


## Portable material appearances

Use `model.materialRead({ document, expectedRevision, materialId, offset?, limit? })` to read exact RGB/opacity,
texture scale/colorization/grain and at most 256 KiB of image bytes. Continue at `next` with the same revision;
missing bytes, incompatible future fields and stale reads fail explicitly. Ordinary model snapshots remain small.

To import or replace an appearance, call `model.materialStage` with the complete `appearance` description and an
optional first image chunk. Continue using its `upload` handle and `offset: received` until `complete` is true.
Chunks must be sequential. No document changes occur while staging. Commit through `model.apply` with
`{ op: 'add_material_appearance', asset: upload, as: 'stock' }` or
`{ op: 'set_material_appearance', materialId, asset: upload }`. Add a `metadata` block for one atomic appearance/
configuration edit. Existing material identities and painted users survive replacement. Success consumes staging;
failure rolls the model back. Read the new revision before retrying or discarding.

Handles belong to one session/document and expire after five minutes. Discard with
`model.materialStage({ document, expectedRevision, upload, discard: true })`. Document close and session shutdown
release them. Each image is limited to 64 MiB and 64 megapixels, all staging to 128 MiB and sixteen appearances;
these bounds do not increase the 256 KiB chunk limit. PNG, JPEG, GIF, BMP and WebP raster descriptors must match
their bytes. Staging needs model write; reading needs model read. Neither grants files or network access. Image
handles are temporary and must never be saved as durable metadata or personal library references.


## Large user files and binary libraries

For files that may exceed one runtime message, use `files.openRead({ purpose, accept })`. The host prompts once
and returns `{ transfer, name, type, byteLength, sha256 }`. Read detached chunks with
`files.read({ transfer, offset, limit })` (at most 256 KiB) and release the capture with `files.closeRead`.

For an export, send sequential `files.stage` chunks. The first supplies `byteLength`, `sha256`, and `bytes`;
continuations supply the returned `upload`, the next `offset`, and `bytes`. Once complete,
`files.saveStaged({ upload, purpose, suggestedName, accept })` verifies the checksum and asks where to save.
`files.discard` releases an unused upload. Staging never writes a file. A declined save can be retried until expiry.
Read and export transfers share four slots and 128 MiB per runtime; each file is at most 64 MiB and transfers expire
in five minutes. Pass the invocation signal, and use the context lifetime signal for cleanup after cancellation.
An already completed save is not undone by a late cancellation. Existing `files.open/save` remain for small files.

`assets` uses similar 256 KiB read/stage chunks for durable opaque blobs. List the paged catalog, read an exact
revision, stage bytes with their key/data version/content type/count/SHA-256 and expected revision (`null` means
absent), then `commit`. Replacement and `remove` fail with `revision.stale` instead of overwriting a newer save.
`discard` affects only temporary staging. Turning off/updating an extension preserves assets; uninstalling with
Delete settings removes them. Official assets use the account, developer assets stay on the account's device.
Missing durable storage reports an error. Never persist temporary file, material or asset upload handles.

For reusable native model modules, use `fragments.capture({ document?, expectedRevision, ref, name })` with a body or
assembly reference including its path. Capture leaves the source, selection and clipboard unchanged. Alternatively,
`openFile({ transfer, name })` reads a file chosen with `files.openRead`, `openAsset({ key, expectedRevision, name })`
reads a private native library entry, and `openPackage({ path, name })` reads a declared, verified `.pf` package file.
All return a `FragmentDescription` with an opaque `fragment` handle, canonical root, bounds and immutable revision 1.
`describe` and bounded `query({ fragment, query })` need model read. `metadataList/metadataRead` query only your declared
metadata namespace, with its normal version checks; other extensions' opaque bytes remain in the native snapshot.

`derive({ fragment, expectedRevision: 1, name?, metadata })` needs model write and creates a new immutable snapshot
with edits to your installed metadata namespace/schema. `metadata` takes the normal expected data version,
upserts/deletes and migration options; it cannot name another owner, document or inspector binding. Geometry and
all other namespaces stay intact. The source handle remains available. Save or accept the new snapshot before
discarding the old one; derivation uses a second snapshot slot and the same native file/cancellation budgets.

For an additive schema change, explicitly set `upgradeCompatible: true` in a metadata write or model/staged metadata
header. The host checks the original expected version, validates every retained own value against the installed
schema, and retains unchanged bytes, missing targets, unresolved links and review flags. It never reads another
namespace or downgrades newer data. A model batch prepares the compatible header before native imports, then
finalizes against the header produced by its own operations; initial version checks still happen before editing.
The explicit upgrade header may accompany model operations without rewriting an entry. A wholly empty model
request remains refused.
The upgrade and edits share one Undo/rollback boundary. Native geometry retains its ordinary topology/deletion
reconciliation rules. Values needing a transformation require an explicit full-record migration instead.

`save({ fragment, key, expectedRevision })` uses the same private account/device store as assets and needs settings.
Use `assets.list` to discover saved descriptors. Native entries have content type `application/vnd.pushform.model-fragment`;
generic `assets.read/stage` cannot read or forge those host-owned snapshots. `export({ fragment, purpose, suggestedName })`
needs file export and asks where to save without returning native bytes to extension code. `discard({ fragment })`
releases a temporary handle. At most two handles (128 MiB encoded total, 64 MiB each) are kept for five minutes, with
one decoded cache and one native operation at a time. Runtime teardown releases them; saved library entries survive.
Pass the invocation signal for cancellation. Use `place_fragment` in a model/tool batch to place a snapshot;
detail-preserving fitting needs an authored geometry plan.

`fragments.project({ fragment, axes })` measures every native solid vertex, including repeated and hidden parts,
in three orthonormal snapshot-coordinate axes. It returns `min`, `max` and `size` without native bytes or other
extensions' properties. Measurements use actual geometry rather than projected axis-aligned boxes.

`fragments.fit({ fragment, expectedRevision, axes, size, pose?, planes?, anchor?, name? })` creates another immutable
snapshot and returns `{ description, projection }`. The optional affine `pose` must preserve distances (rotation,
reflection and translation); it cannot globally scale or shear details. Stretch planes use the same world/snapshot
coordinates and fields as `stretch_physical`. The optional posed `anchor` stays fixed. The host checks all three
actual projected sizes against `size` before returning a handle, retaining the source on any mismatch or refusal.
The fit owns a disposable geometry worker, separate from live document kernels; cancellation stops that worker.
The usual two-handle quota applies, so discard an obsolete preview before fitting again. Align `projection.min`
with the opening minimum using a rigid placement transform; a dimension certificate does not permit later scaling.
Solid fitting refuses mixed drawings, guides, images and imported display meshes rather than ignoring them.

Bundle a portable SHA-256 implementation for checksums in extension code: WebCrypto's `crypto.subtle` is unavailable
inside the isolated worker. The host independently verifies complete content before saving or publishing.


## Interactive modeling tools

Declare a `model.tool` contribution and request `tool.interaction` and `model.read`. Its handler receives
`{ tool: ToolInput, params: unknown }` plus the usual invocation document handle. The host creates the session;
there is no service that activates tools or listens to input while a tool is inactive.

Register `tools.onEvent` during activation. Process the initial `activate` input and subsequent inputs in the same
handler. Answer every input with `tools.present({ session, sequence, view })`, or `tools.ack` when no view changes.
Only one input is in flight; pointer moves and viewport resyncs coalesce between ordered clicks, keys and entries.
A presentation supplies the complete instructor text, numeric fields, choices, safe cursor, snapping constraints
and bounded overlay primitives. Coordinates are world meters; screen coordinates are fractions of viewport size.
Lengths entered without units carry the model's default unit. Entry text is preserved for your own expression
parser; never evaluate it as JavaScript.

For geometry, `tools.apply({ session, sequence, batch })` also requires `model.write`. It binds the batch to the
input's document, revision and edit context and aborts pending work when that tool ends. Await the edit before
acknowledging the input. Then acknowledge and handle the resulting `resync` with the new revision. Ordinary
`model.apply` remains available for independent commands and is not implicitly bound to the tool's lifetime.

Escape ends the tool immediately. Camera navigation and native snapping remain responsive while the runtime
works. Listen to `tools.onEnd` to stop your async work and discard that session's state; its late responses are
refused. Model switching, disable, close and runtime loss also end sessions. An input that receives no response
within ten seconds ends the tool with an explanatory host notice. End voluntarily with `tools.end({ session })`.


A declarative button or menu item can specify `tool` with an own declared `model.tool` contribution ID. A trusted
user click starts that tool in the surface's model; foreign tools and surfaces without a model are refused.
This action does not send a guest event or expose an activation service.

Tool fields accept `kind: 'text'` as well as numeric kinds. Set `placement: 'options'` for secondary fields shown
in the themed Tool options popover. Raw text still reaches the tool handler. Pointer input includes a host-derived
world-space `pickRadius` when available, so closing or picking a profile can use the current viewport scale.

Each successful `tools.apply` is a separate Undo action. For independent profile solids, `add_prism` accepts a
coplanar outer ring, optional holes, normal and signed distance. Optional `extrusionDirection` and affine
`referenceFrame` support transformed containers. Invalid, touching or intersecting profile rings are refused
before creation. `smoothSides` smooths the extrusion edges without smoothing the caps. Use `as` to attach
same-batch metadata to the created body. `add_guides` commits up to 5,000 finite segments in one operation.

`add_part` creates a physical profile solid in a descendant `container` without changing the live editing context.
Its profile points, normal, optional extrusion direction and reference frame are world-space; distance is signed
physical meters. The container can be an instance path or a body alias whose containing path is reused. Placement
scope is the default and separates shared ancestors only as needed; `scope: 'shared'` edits the shared definition.
Aliases and typed occurrence references follow the actual identities after separation. A created `bodyOccurrence`
metadata target can omit `path` to use its alias's actual containing path.

An explicit `componentName` on `add_part` creates a named one-body component and returns the body's nested alias.
Ordinary creation still produces a body. `copy_part` accepts that body alias (or another sole body of a component),
a descendant destination and a `worldMatrix`; it creates a linked occurrence and returns the new nested body alias.
Loose bodies, groups and components containing other entities are refused. Place distinct manufacturing labels on
the returned body occurrences. `copy_physical` remains available for ordinary independent bodies or whole assemblies.

`boolean_part` takes `mode: 'union' | 'subtract' | 'intersect'`, `target`, `tool`, optional `keepTool` (default true)
and optional placement/shared `scope` (default placement). Inputs can occupy different descendant containers.
Every connected result is returned in the target container, with its first solid retaining the target identity.
The host converts the tool geometry and face properties through the complete affine frames and uses native solid
reconciliation. Empty results and cuts removing no volume are refused. Manufacturing tools must separately validate
groove depth and support geometry. Isolation, geometry and metadata share the batch's single Undo/rollback boundary.


Set `amendPrevious: true` on `tools.apply` only to correct the same live tool's immediately preceding successful
gesture. The host checks its exact result revision and context, and the model layer checks the owned top Undo
entry. Another edit, Undo/Redo, context change or session replacement refuses amendment. Geometry corrections
cannot add new metadata. Ordinary tool gestures continue to have separate Undo actions.

The `transform` model operation accepts an invertible affine `matrix` in the batch container's coordinates,
`refs`, optional `copy`, and an optional `as` for one copy. It uses the existing atomic transform and kernel path.
Singular and projective matrices are refused.

For an authored curved profile, `add_prism` can set `closedCurve: true` with up to 512 outer points. The solid
retains two closed rim edge groups and their linked side surface even without smoothing. Rims that are circular
in container coordinates retain a circular radius; affine-deformed rims retain their exact edge groups as
freehand curves. Later nonuniform transforms preserve circle radii when the circle plane is unchanged.


`paint_part` takes a solid `ref`, `materialId` (null restores model inheritance) and explicit `scope` of `placement`
or `shared`. Placement edits separate shared ancestor geometry only as needed and preserve native opaque attachment
mappings; shared edits retain the definition. It returns the resulting body reference in the operation result.
The target must be in the batch context or a descendant. Locked paths and isolation that would remap the currently
open context are refused before mutation. Paint, separation and any later batch failure share one rollback boundary.

An extension `model.apply` or `tools.apply` batch can use `operations: []` with a nonempty `metadata` edit. Metadata-only
edits keep the same revision, schema, cancellation and single Undo guarantees without touching body geometry or
versions. An entirely empty batch is refused. A tool metadata edit remains bound to its active session and input.


`transform_part` takes a physical solid `ref` and an invertible affine `worldMatrix`. It isolates shared ancestor
geometry as needed, then uses the native transform/kernel path on that solid alone. The result reports the new body
reference. World coordinates are explicit for this operation; ordinary `transform` matrices stay container-local.
Isolation, transformed geometry, attachment mappings and later batch failure share one Undo/rollback boundary.

`copy_physical` copies one captured body or assembly `ref` to a descendant `container` (an instance path, or a body
alias whose containing path is reused). Its invertible affine `worldMatrix` transforms the captured physical geometry.
The destination separates shared ancestors as needed. Bodies are independent copies; assembly components stay linked
unless `independent: true` duplicates the definition graph. Groups remain independent. The copy retains inherited
appearance, native frames, curves and opaque attachments, with actual root references and an optional `as` alias.
The live clipboard and editing context stay unchanged. A linked assembly cannot be copied inside itself. Complete
source graphs and aggregate copied geometry are bounded; cancellation and later failures roll the whole batch back.
This copies geometry; authored module fitting needs its own detail-preserving plan.

`stretch_physical` edits one captured body or solid assembly with at most 32 world-space planes. A plane uses
`normal`, `offset` (`normal dot point = offset`), `side` and a world-space `displacement`. Contributions classify
the original geometry together; optional `anchor` stays fixed. Default `scope: 'placement'` separates shared
geometry as needed; explicit `shared` edits the selected definition's uses. Uniform subassemblies move without
copying their linked definitions. Curves must move intact: crossing a protected curve, unsupported non-solid
contents, stale preparation, locks or invalid solids refuse the complete edit. The operation preserves native
details and opaque properties, returns the actual root, supports `as` and metadata aliases, and shares the atomic
ordinary/tool/staged rollback path. Aggregate physical geometry limits include copies and stretches. A stretch
does not by itself prove a fitted module's target dimensions.

`place_fragment` places the canonical assembly root of a `fragments` snapshot. Supply its runtime-owned `fragment`
handle and an invertible affine `worldMatrix` mapping snapshot coordinates to world coordinates. `container` is a
descendant path or a preceding body alias whose containing path is reused; omitted means this batch's context.
Shared destination ancestors isolate as needed. The result carries the actual instance reference/definition and
supports `as`, including metadata targets created in the same batch. Ordinary, tool and staged batches all use the
same native placement, geometry budgets and atomic Undo/rollback path. Source snapshots, clipboard and edit context
are unchanged. A handle that expires or is discarded cancels its pending placement; the host rechecks the document
and edit context after preparing native input.

Repeated placements of the same snapshot link an unchanged component import. `independent: true` imports a unique
definition graph; group roots stay independent. The host proves reuse with its private import correspondence and
checks native definitions, appearances and shared attachment records. Edited imports receive fresh snapshot data,
preserving those edits and the saved module's properties. This correspondence is temporary, never model metadata.
All opaque namespaces, material/image dependencies, frames and curves follow native copying; external references
stay unresolved and saved document-job membership is excluded. Placement preserves the snapshot's shape; it does
not stretch a module to fit an opening.
