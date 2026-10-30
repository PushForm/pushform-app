// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/**
 * The document an extension runtime starts in: a sandboxed frame (`allow-scripts` only, so its origin is opaque and
 * unique, and it has no access to the editor's DOM, storage or cookies) holding one inline script. That script
 * accepts exactly one `load` message from its parent, carrying a nonce, the worker bootstrap's source and the
 * verified package files. It starts the worker, hands it the files and a protocol port, and answers its parent with
 * the nonce, the other end of the protocol port and a control port the host uses to terminate the worker. Every
 * later message is ignored.
 *
 * The frame's content security policy is what closes the network and dynamic code (no `eval`, no remote scripts,
 * no `data:` scripts, WebAssembly only when the package declares modules). The script is allowed by its hash, which
 * the host page's own policy must list as well, because a `srcdoc` frame also inherits the policy of its parent.
 */
export const FRAME_BOOTSTRAP_SOURCE = `(function () {
  'use strict';
  var started = false;
  addEventListener('message', function (event) {
    var data = event.data;
    if (started || event.source !== parent || !data || data.type !== 'load' || typeof data.nonce !== 'string'
      || typeof data.worker !== 'string' || typeof data.main !== 'string' || !data.files) return;
    started = true;
    var url = URL.createObjectURL(new Blob([data.worker], { type: 'text/javascript' }));
    var worker = new Worker(url, { name: 'extension' });
    URL.revokeObjectURL(url);
    var protocol = new MessageChannel();
    var control = new MessageChannel();
    var buffers = [];
    for (var key in data.files) if (Object.prototype.hasOwnProperty.call(data.files, key)) buffers.push(data.files[key]);
    worker.addEventListener('error', function (error) {
      control.port1.postMessage({ type: 'error', message: String((error && error.message) || 'The extension runtime failed to start.').slice(0, 500) });
    });
    control.port1.onmessage = function (message) {
      if (message.data && message.data.type === 'terminate') { worker.terminate(); control.port1.postMessage({ type: 'terminated' }); }
    };
    worker.postMessage({ type: 'init', main: data.main, files: data.files }, [protocol.port1].concat(buffers));
    parent.postMessage({ type: 'ready', nonce: data.nonce }, '*', [protocol.port2, control.port2]);
  });
})();`;

/** Base64 SHA-256 of `FRAME_BOOTSTRAP_SOURCE`, as content security policies name it; a test keeps it current. */
export const FRAME_BOOTSTRAP_SHA256 = 'OwjFlCFbv+SAw7R/uVvxAXT4xxbkxbwDitCeK092HXs=';

/** The policy of the runtime frame and of the workers it starts. */
export function frameContentSecurityPolicy(options: { readonly wasm: boolean }): string {
  return [
    "default-src 'none'",
    `script-src 'sha256-${FRAME_BOOTSTRAP_SHA256}' blob:${options.wasm ? " 'wasm-unsafe-eval'" : ''}`,
    'worker-src blob:',
    "connect-src 'none'",
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** The `srcdoc` of a runtime frame. */
export function runtimeFrameDocument(options: { readonly wasm: boolean }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${frameContentSecurityPolicy(options)}"><title>extension</title><script>${FRAME_BOOTSTRAP_SOURCE}</script></head></html>`;
}
