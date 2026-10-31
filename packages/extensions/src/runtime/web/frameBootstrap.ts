// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/**
 * The document an extension runtime starts in: a sandboxed frame (`allow-scripts` only, so its origin is opaque and
 * unique, and it has no access to the editor's DOM, storage or cookies) holding one inline script. That script
 * accepts exactly one `load` message from its parent, carrying a nonce, the worker bootstrap's source and the
 * verified package files. It starts the worker, hands it the files and a protocol port, and answers its parent with
 * the nonce, the other end of the protocol port and a control port. On the control port the host can terminate the
 * runtime, and, for packages that declare WebAssembly modules, start and end compute workers from the compute
 * bootstrap source it sent with `load`; each compute worker answers on its own port. Every other message is ignored.
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
    var computeSource = typeof data.compute === 'string' ? data.compute : null;
    var computeWorkers = {};
    var start = function (source, name) {
      var url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      var started = new Worker(url, { name: name });
      URL.revokeObjectURL(url);
      return started;
    };
    var worker = start(data.worker, 'extension');
    var protocol = new MessageChannel();
    var control = new MessageChannel();
    var buffers = [];
    for (var key in data.files) if (Object.prototype.hasOwnProperty.call(data.files, key)) buffers.push(data.files[key]);
    worker.addEventListener('error', function (error) {
      control.port1.postMessage({ type: 'error', message: String((error && error.message) || 'The extension runtime failed to start.').slice(0, 500) });
    });
    control.port1.onmessage = function (message) {
      var command = message.data;
      if (!command) return;
      if (command.type === 'terminate') {
        worker.terminate();
        for (var running in computeWorkers) if (Object.prototype.hasOwnProperty.call(computeWorkers, running)) computeWorkers[running].terminate();
        computeWorkers = {};
        control.port1.postMessage({ type: 'terminated' });
      } else if (command.type === 'compute' && typeof command.id === 'number') {
        if (computeSource === null || computeWorkers[command.id]) { control.port1.postMessage({ type: 'compute-failed', id: command.id }); return; }
        var compute = start(computeSource, 'extension-compute');
        computeWorkers[command.id] = compute;
        compute.addEventListener('error', function () { control.port1.postMessage({ type: 'compute-error', id: command.id }); });
        var channel = new MessageChannel();
        compute.postMessage({ type: 'connect' }, [channel.port1]);
        control.port1.postMessage({ type: 'compute', id: command.id }, [channel.port2]);
      } else if (command.type === 'compute-terminate' && computeWorkers[command.id]) {
        computeWorkers[command.id].terminate();
        delete computeWorkers[command.id];
      }
    };
    worker.postMessage({ type: 'init', main: data.main, files: data.files }, [protocol.port1].concat(buffers));
    parent.postMessage({ type: 'ready', nonce: data.nonce }, '*', [protocol.port2, control.port2]);
  });
})();`;

/** Base64 SHA-256 of `FRAME_BOOTSTRAP_SOURCE`, as content security policies name it; a test keeps it current. */
export const FRAME_BOOTSTRAP_SHA256 = 'fVfgLS0lq9pmqAN68DK7xkHawYnVTgtg0RYgg1b0om8=';

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
