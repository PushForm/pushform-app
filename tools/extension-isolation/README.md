# Extension isolation suite

Attack tests of the isolated web extension runtime (`packages/extensions/src/runtime/web/`) in real browsers. Hostile
extension packages are built with the real validator and run in the real runtime: the same worker bootstraps (bundled
by the web app's own build code), the same sandboxed frame and policy, the same host session and platform. The page
is served with the web app's deployed response headers (`apps/web/public/_headers` plus the policy from
`apps/web/contentSecurityPolicy.ts`). Every attempt must fail, and a second origin plus a UDP socket record anything
that gets out.

This is development tooling, not part of the app. Unit-level checks of the same rules (host message validation,
the frame handshake, side-load and trust rules, the allocation budget) are vitest tests next to the code in
`packages/extensions`.

## Running it

```sh
pnpm install
pnpm --filter @pushform/extension-isolation install-browsers   # once: Chromium, Firefox and WebKit
pnpm test:isolation                                              # every project; about five minutes
pnpm test:isolation --project=web-chromium                      # one shell
ISOLATION_MEASURE_EXCLUDED=1 pnpm test:isolation --project=web-webkit   # the full suite in an excluded browser
```

To watch a test, add `--headed --debug`; `window.isolation` in the page is what the tests drive.

Tests run one at a time, because the responsiveness and heartbeat checks measure timing.

### In CI

A job on `ubuntu-24.04` after `pnpm install --frozen-lockfile`:

```yaml
- run: pnpm --filter @pushform/extension-isolation exec playwright install --with-deps chromium firefox webkit
- run: pnpm test:isolation
  env: { CI: '1' }
- uses: actions/upload-artifact@v7
  if: always()
  with: { name: extension-isolation, path: tools/extension-isolation/test-results }
```

With `CI` set, the run writes `test-results/junit.xml` and refuses `test.only`. It needs no network access beyond
installing the browsers: every server is local. The memory checks allocate up to about 1.2 GB at a time in the
browser, which standard runners allow.

## Shells

`shells.ts` is the matrix; the Playwright projects are generated from it. A shell is included only when the whole
suite passes in it; otherwise it is excluded, with the reason, and must not offer extensions.

| Shell | Engine | Status | Reason |
| --- | --- | --- | --- |
| Hosted web | Chromium 156 (Chrome, Edge) | Included | Full suite under the deployed headers, editor policy report-only as sent today. |
| Hosted web, editor policy enforced | Chromium 156 | Included | Same suite with the editor policy enforced, as it will be sent. |
| Hosted web | Firefox 157 | Included | Full suite under the deployed headers. |
| Hosted web, editor policy enforced | Firefox 157 | Included | Same suite with the editor policy enforced. |
| Hosted web | WebKit 27 (Safari) | Excluded | Under cross-origin isolation WebKit refuses to start the runtime frame's `blob:` worker. The fail-closed check proves that nothing starts and that the app does not offer extensions there. |
| Installed offline web | any | Excluded | There is no offline build yet. When there is, it runs this suite under its own headers first. |
| Desktop macOS | WKWebView | Excluded | The desktop extension runtime is not built; the desktop shell starts no extensions. |
| Desktop Windows | WebView2 | Excluded | As macOS. |
| Desktop Linux | WebKitGTK | Excluded | As macOS. |

## What is covered

Each category runs one hostile package; each attack is its own test, and the refusal it met is recorded as an
annotation on the test.

- **Network**: `fetch` (editor origin, other origin, `no-cors`, keepalive POST, `data:`), XHR (async and sync),
  WebSocket, EventSource, WebTransport, `sendBeacon`, `import()` from other origins and from the editor's origin,
  `importScripts`, fonts, images, stylesheets, service workers, WebRTC. Afterwards no request or datagram may have
  reached either server.
- **Editor storage and cookies**: the editor seeds a secret into localStorage, sessionStorage, a cookie, IndexedDB,
  Cache Storage and a BroadcastChannel. The extension tries those, `cookieStore`, the origin private file system,
  Web Locks and the editor's `window`, `document` and `parent`; no result may contain the secret.
- **Dynamic code**, in a plain package and in one that declares WebAssembly (whose frame policy allows compiling it):
  `eval`, indirect eval, the `Function`, `AsyncFunction` and `GeneratorFunction` constructors, string timers,
  `import()` of `data:` URLs (also made from received bytes), `URL.createObjectURL` and putting it back, importing or
  fetching a `blob:` module the editor made, and WebAssembly by every route.
- **Modules outside the package**: at load (a static import from another origin, a bare specifier, `../`, an absolute
  path, a JSON module) the load fails before any code runs; at run time, computed `import()` of package files and of
  the editor's scripts fails.
- **Nested workers**: `Worker`, `SharedWorker`, `importScripts` (also from the prototype chain), service workers.
- **Navigation**: `open`, `top`/`parent` navigation, navigating its own scope, forms, `clients.openWindow`; the editor
  must stay on its page with no new window.
- **The runtime frame itself** (defense in depth): the same attacks from the frame's document, with the runtime
  frame's exact sandbox flags and policy, plus modal dialogs and fullscreen over the editor.
- **Message spoofing**: the extension captures its own protocol port and sends requests for ungranted and nonexistent
  services, claimed identities, document ids and guessed handles, oversized and too deep messages, host-only message
  types, wrong versions, extra fields and out-of-place lifecycle messages. Too many invalid messages fail and end the
  runtime. Another window of the page floods the runtime frame with forged `load`s and the editor with forged
  `ready` answers. An old runtime that keeps talking after its session stopped reaches nothing.
- **Cross-extension state**: two side-loaded extensions on the real platform; neither can read the other's settings,
  globals or BroadcastChannel, mount in its panel, or load or fetch its modules.
- **Side-loading**: developer mode is required, the `io.pushform` namespace is refused, a package with a signature
  that cannot be verified is refused rather than loaded unsigned, turning developer mode off stops side-loaded
  extensions, and installing and running them sends nothing anywhere.
- **Resources**: a hung extension leaves the editor responsive and is ended; heap exhaustion is noticed by the
  heartbeat; binary allocations past the 256 MiB budget are refused. Floods of well-formed messages (200,000 at once,
  a sustained flood, 400 MiB at once) fail the session and end the runtime within a bounded time while the editor
  keeps ticking, and an extension calling the host in a tight loop is paced and keeps running.

## Known gaps

These are expected failures (`test.fail`, `it.fails`), so the suite stays green while they exist and turns red when
one is fixed; remove the marker then.

1. **Binary budget routes.** The budget replaces the global `ArrayBuffer` and typed array constructors, but each
   replacement extends the original, so `Object.getPrototypeOf(ArrayBuffer)`, `Object.getPrototypeOf(Uint8Array)`
   and any buffer's `constructor` are the uncounted originals; `ArrayBuffer.prototype.transfer` allocates its new
   length uncounted. Platform methods also make uncounted buffers larger than anything the extension holds: a `Blob`
   repeating one buffer, `DecompressionStream` (half a megabyte of gzip became 512 MiB), and `structuredClone`
   copies. Each of these allocated 512 MiB or more in both browsers.

Revocation is not implemented (there is no official install path yet); its tests are listed as pending in
`packages/extensions/src/platform/trust.test.ts`.

### Frame layer

No extension code runs in the runtime frame's document, only in its worker, so these are not reachable by an
extension; they are what the second wall does not stop. Code in the frame document could navigate the frame itself
to another origin while the editor policy is report-only (the enforced policy's `frame-src` stops it), and could use
WebRTC, which no content security policy governs: in Chromium its STUN checks reached the test's UDP socket.
