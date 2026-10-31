// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Runs in the editor page of the attack harness. It builds hostile packages with the real validator, starts them in
// the real web runtime (the same bootstraps, frame, policy and session the app uses) and reports what happened.
// The Playwright tests drive it through `window.isolation`.
import { zipSync } from 'fflate';
import {
  ExtensionPlatform, ExtensionSession, FRAME_BOOTSTRAP_SHA256, frameContentSecurityPolicy, localSettingsStore, memoryExtensionStore,
  runtimeFrameDocument, startWebRuntime, storedDeveloperMode, type ServiceCall, type ServiceImplementations, type SessionFailure,
  type SessionLimits, type WebRuntime,
} from '@pushform/extensions';
import { ExtensionError, buildManifest, validatePackage, type ExtensionManifestInput, type ExtensionPermission } from '@pushform/extension-protocol';
import { ATTACKER_FRAME_SOURCE, FRAME_PROBE_SOURCE } from './frames';

declare const WORKER_SOURCE: string;
declare const COMPUTE_SOURCE: string;
declare const COMPUTE_WASM: number[];

/** A hostile package: its id, permissions, contributions (suffixes under the id) and JavaScript files. */
export interface PackageSpec {
  readonly id: string;
  readonly permissions?: readonly ExtensionPermission[];
  readonly commands?: readonly string[];
  readonly panels?: readonly string[];
  /** Package files by path; `main.js` is the entry unless `main` names another. */
  readonly files: Readonly<Record<string, string>>;
  readonly main?: string;
  /** Declares one compute module, so the frame's policy allows compiling WebAssembly. */
  readonly wasm?: boolean;
}

export interface StartOptions {
  readonly grants?: readonly ExtensionPermission[];
  readonly limits?: Partial<SessionLimits>;
  /** Terminate the runtime as soon as the session fails, as the platform does. Default true. */
  readonly terminateOnFailure?: boolean;
}

interface ServiceCallRecord { readonly service: string; readonly extensionId: string; readonly generation: number; readonly input: string }

interface Started {
  readonly runtime: WebRuntime;
  readonly session: ExtensionSession;
  readonly calls: ServiceCallRecord[];
  readonly failures: SessionFailure['kind'][];
  readonly errors: string[];
}

const enc = (s: string) => new TextEncoder().encode(s);
const describeError = (e: unknown) => e instanceof ExtensionError ? { code: e.code, message: e.message } : { code: 'thrown', message: String((e as Error)?.message ?? e) };

async function packageFiles(spec: PackageSpec): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>(Object.entries(spec.files).map(([path, source]) => [path, enc(source)]));
  if (spec.wasm) files.set('echo.wasm', new Uint8Array(COMPUTE_WASM));
  const input: Omit<ExtensionManifestInput, 'files'> = {
    id: spec.id, name: spec.id.split('.').pop()!, publisher: 'Test', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'],
    defaultLocale: 'en', license: 'MIT', main: spec.main ?? 'main.js', permissions: [...(spec.permissions ?? [])],
    contributions: [
      ...(spec.commands ?? ['run']).map((c) => ({ target: 'model.command' as const, id: `${spec.id}.${c}`, name: c })),
      ...(spec.panels ?? []).map((c) => ({ target: 'model.panel' as const, id: `${spec.id}.${c}`, name: c })),
    ],
    ...(spec.wasm ? { wasm: [{ name: 'echo', file: 'echo.wasm', maxMemoryPages: 4, timeoutMs: 2000 }] } : {}),
  };
  files.set('manifest.json', await buildManifest(input, files));
  return files;
}

/** Services of the raw-session runs. Each records who the host says called it, whatever the input claims. */
function recordingServices(calls: ServiceCallRecord[]): ServiceImplementations {
  const record = (service: string) => (input: unknown, call: ServiceCall) => {
    calls.push({ service, extensionId: call.extensionId, generation: call.generation, input: JSON.stringify(input ?? null).slice(0, 200) });
  };
  return {
    'log.write': (input, call) => { record('log.write')(input, call); return null; },
    'settings.get': (input, call) => { record('settings.get')(input, call); return { owner: call.extensionId }; },
    'model.read': (input, call) => { record('model.read')(input, call); return { document: call.document((input as { document?: unknown } | null)?.document) }; },
    'clipboard.write': (input, call) => { record('clipboard.write')(input, call); return null; },
    'ui.mount': (input, call) => { record('ui.mount')(input, call); return { seq: 1 }; },
  };
}

const started = new Map<number, Started>();
let nextHandle = 1;

async function start(spec: PackageSpec, options: StartOptions = {}): Promise<number> {
  const files = await packageFiles(spec);
  const { manifest } = await validatePackage(files);
  const errors: string[] = [];
  const runtime = await startWebRuntime({
    files, main: manifest.main, wasm: manifest.wasm.length > 0, workerSource: WORKER_SOURCE, computeSource: COMPUTE_SOURCE,
    onError: (e) => errors.push(e.message),
  });
  const calls: ServiceCallRecord[] = [];
  const failures: SessionFailure['kind'][] = [];
  const session = new ExtensionSession({
    manifest, grants: options.grants ?? manifest.permissions, port: runtime.port, services: recordingServices(calls),
    limits: options.limits ?? {},
    onFailure: (failure) => {
      failures.push(failure.kind);
      if (options.terminateOnFailure !== false) runtime.terminate();
    },
  });
  const handle = nextHandle++;
  started.set(handle, { runtime, session, calls, failures, errors });
  return handle;
}

function get(handle: number): Started {
  const s = started.get(handle);
  if (!s) throw new Error(`no runtime ${handle}`);
  return s;
}

async function invoke(handle: number, command: string, params: unknown = {}, options: { document?: string; timeoutMs?: number } = {}) {
  const { session } = get(handle);
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new ExtensionError('cancelled', 'harness timeout')), options.timeoutMs ?? 20_000));
  try {
    const value = await Promise.race([session.invoke(`${session.manifest.id}.${command}`, params, options.document ? { document: options.document } : {}), timeout]);
    return { ok: true as const, value };
  } catch (e) {
    return { ok: false as const, error: describeError(e) };
  }
}

function info(handle: number) {
  const { session, calls, failures, errors } = get(handle);
  return { state: session.state, generation: session.generation, invalidMessages: session.invalidMessages, calls: [...calls], failures: [...failures], errors: [...errors], frames: document.querySelectorAll('iframe').length };
}

async function stop(handle: number) {
  const s = started.get(handle);
  if (!s) return;
  const confirmed = await s.session.deactivate('disable');
  s.runtime.terminate();
  started.delete(handle);
  return confirmed;
}

/** Starts, runs one command, stops: the whole lifecycle of one attack, with what the host saw. */
async function run(spec: PackageSpec, command = 'run', params: unknown = {}, options: StartOptions & { document?: string; timeoutMs?: number } = {}) {
  let handle: number;
  try {
    handle = await start(spec, options);
  } catch (e) {
    return { started: false, error: describeError(e) };
  }
  const outcome = await invoke(handle, command, params, options);
  const seen = info(handle);
  await stop(handle);
  return { started: true, ...outcome, ...seen, framesAfterStop: document.querySelectorAll('iframe').length };
}

/** Secrets of the editor's own origin, which no extension may read. */
async function seedEditorSecrets(secret: string): Promise<void> {
  localStorage.setItem('pf-secret', secret);
  sessionStorage.setItem('pf-secret', secret);
  document.cookie = `pf_secret=${secret}; path=/; SameSite=Strict`;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('pf-secret-db', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('s');
    request.onsuccess = () => {
      const tx = request.result.transaction('s', 'readwrite');
      tx.objectStore('s').put(secret, 'secret');
      tx.oncomplete = () => { request.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
  if ('caches' in self) await (await caches.open('pf-secret-cache')).put('/secret', new Response(secret));
  const channel = new BroadcastChannel('pushform');
  setInterval(() => channel.postMessage({ secret }), 20);
}

/** A blob URL made by the editor holding a module; an extension that ran it would set `__pwned` in its scope. */
function editorBlobUrl(): string {
  return URL.createObjectURL(new Blob(['self.__pwned = "editor module ran"; export default "editor module";'], { type: 'text/javascript' }));
}

async function sha256Base64(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc(text)));
  return btoa(String.fromCharCode(...digest));
}

const frame = (srcdoc: string): HTMLIFrameElement => {
  const element = document.createElement('iframe');
  element.setAttribute('sandbox', 'allow-scripts');
  element.style.display = 'none';
  element.srcdoc = srcdoc;
  return element;
};

/** The runtime frame's sandbox and policy around the frame-layer probe (see frames.ts). */
async function frameProbe(params: { remote: string; tag: string; stun: string }) {
  // The runtime's real sandbox flags, read from a runtime frame as the app starts it, so the probe cannot drift.
  const holder = document.createElement('div');
  document.body.append(holder);
  void startWebRuntime({ files: new Map(), main: 'main.js', wasm: false, workerSource: '', container: holder, handshakeMs: 50 }).catch(() => {});
  const sandbox = holder.querySelector('iframe')?.getAttribute('sandbox') ?? 'missing';
  holder.remove();
  const policy = frameContentSecurityPolicy({ wasm: false }).replace(FRAME_BOOTSTRAP_SHA256, await sha256Base64(FRAME_PROBE_SOURCE));
  const probe = frame(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><script>${FRAME_PROBE_SOURCE}</script></head><body></body></html>`);
  probe.setAttribute('sandbox', sandbox);
  const results = await new Promise<unknown>((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== probe.contentWindow || (event.data as { type?: string })?.type !== 'frame-probe') return;
      removeEventListener('message', onMessage);
      resolve((event.data as { results: unknown }).results);
    };
    addEventListener('message', onMessage);
    probe.addEventListener('load', () => probe.contentWindow!.postMessage({ type: 'probe', ...params }, '*'), { once: true });
    document.body.append(probe);
  });
  // Give a self-navigation, if one is allowed, time to reach the server.
  await new Promise((r) => setTimeout(r, 500));
  probe.remove();
  return { sandbox, policy, results };
}

function attackerFrame(): Promise<HTMLIFrameElement> {
  const attacker = frame(`<!doctype html><html><head><script>${ATTACKER_FRAME_SOURCE}</script></head></html>`);
  return new Promise((resolve) => {
    attacker.addEventListener('load', () => resolve(attacker), { once: true });
    document.body.append(attacker);
  });
}

function attackerDone(attacker: HTMLIFrameElement): Promise<{ loads: number; readies: number }> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== attacker.contentWindow || (event.data as { type?: string })?.type !== 'attacker-done') return;
      removeEventListener('message', onMessage);
      resolve(event.data as { loads: number; readies: number });
    };
    addEventListener('message', onMessage);
  });
}

/**
 * The runtime frame's bootstrap, before its parent sends `load`, receives forged `load` messages from another window
 * of the page. It must ignore them and still accept its parent's, answering with the parent's nonce.
 */
async function bootstrapIgnoresOtherWindows() {
  const attacker = await attackerFrame();
  const runtimeFrame = frame(runtimeFrameDocument({ wasm: false }));
  await new Promise<void>((resolve) => { runtimeFrame.addEventListener('load', () => resolve(), { once: true }); document.body.append(runtimeFrame); });
  const done = attackerDone(attacker);
  attacker.contentWindow!.postMessage({ type: 'attack', ms: 300 }, '*');
  const sent = await done;
  const nonce = crypto.randomUUID();
  const answer = await new Promise<{ nonce: unknown; ports: number } | 'none'>((resolve) => {
    const timer = setTimeout(() => { removeEventListener('message', onMessage); resolve('none'); }, 3000);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== runtimeFrame.contentWindow) return;
      clearTimeout(timer);
      removeEventListener('message', onMessage);
      resolve({ nonce: (event.data as { nonce?: unknown })?.nonce, ports: event.ports.length });
    };
    addEventListener('message', onMessage);
    const files = { 'main.js': enc('export function activate() {}').buffer };
    runtimeFrame.contentWindow!.postMessage({ type: 'load', nonce, worker: WORKER_SOURCE, main: 'main.js', files }, '*', Object.values(files));
  });
  runtimeFrame.remove();
  attacker.remove();
  return { sent, answeredWithParentNonce: answer !== 'none' && answer.nonce === nonce && answer.ports === 2, answer };
}

/** Starts a runtime while another window of the page floods the editor with forged `ready` answers and `load`s. */
async function handshakeUnderAttack(spec: PackageSpec) {
  const attacker = await attackerFrame();
  const done = attackerDone(attacker);
  attacker.contentWindow!.postMessage({ type: 'attack', ms: 1500 }, '*');
  const outcome = await run(spec, 'run', {});
  const sent = await done;
  attacker.remove();
  return { sent, outcome };
}

/** Counts the editor thread's timer ticks while `during` runs, to show the editor stays responsive. */
async function ticksDuring<T>(ms: number, during: () => Promise<T>): Promise<{ ticks: number; value: T; elapsedMs: number; longestGapMs: number }> {
  let ticks = 0;
  let last = performance.now();
  let longestGapMs = 0;
  const begun = last;
  const timer = setInterval(() => { const now = performance.now(); longestGapMs = Math.max(longestGapMs, now - last); last = now; ticks++; }, 10);
  const value = await during();
  await new Promise((r) => setTimeout(r, ms));
  clearInterval(timer);
  return { ticks, value, elapsedMs: Math.round(performance.now() - begun), longestGapMs: Math.round(longestGapMs) };
}

// ---------------------------------------------------------------------------------------------------------------
// The platform, wired as the browser app wires it: device-local store and settings, developer mode in localStorage.

async function archive(spec: PackageSpec, extra: Record<string, Uint8Array> = {}): Promise<Uint8Array> {
  const files = await packageFiles(spec);
  for (const [path, bytes] of Object.entries(extra)) files.set(path, bytes);
  return zipSync(Object.fromEntries(files));
}

let platform: ExtensionPlatform | null = null;
const platformFailures: string[] = [];

function createPlatform(owner: string) {
  platform = new ExtensionPlatform({
    store: memoryExtensionStore(),
    developerMode: storedDeveloperMode(localStorage),
    startRuntime: (record) => startWebRuntime({
      files: new Map(Object.entries(record.files)), main: record.manifest.main, wasm: record.manifest.wasm.length > 0,
      workerSource: WORKER_SOURCE, computeSource: COMPUTE_SOURCE,
    }),
    settingsStore: () => localSettingsStore(localStorage, owner),
    onFailure: (record, failure) => platformFailures.push(`${record.id}:${failure.kind}`),
  });
  return true;
}

const thePlatform = (): ExtensionPlatform => {
  if (!platform) throw new Error('createPlatform first');
  return platform;
};

const isolation = {
  start, invoke, info, stop, run, seedEditorSecrets, editorBlobUrl, frameProbe, bootstrapIgnoresOtherWindows, handshakeUnderAttack,
  ticksDuring,
  /** Runs a command while counting editor ticks, then stops the runtime from outside. */
  async responsiveDuring(handle: number, command: string, ms: number) {
    const { session, runtime } = get(handle);
    const running = session.invoke(`${session.manifest.id}.${command}`, {}).then(() => 'returned', (e: unknown) => describeError(e).code);
    const { ticks } = await ticksDuring(ms, async () => undefined);
    const stopping = performance.now();
    const confirmed = await session.deactivate('disable');
    runtime.terminate();
    started.delete(handle);
    return { ticks, confirmed, stopMs: Math.round(performance.now() - stopping), invocation: await running, frames: document.querySelectorAll('iframe').length };
  },
  /** Waits for a runtime's session to fail, as the heartbeat makes it, and reports how long it took. */
  async failureOf(handle: number, command: string, withinMs: number) {
    const s = get(handle);
    const begun = performance.now();
    const running = s.session.invoke(`${s.session.manifest.id}.${command}`, {}).then(() => 'returned', (e: unknown) => describeError(e).code);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const outcome = await Promise.race([running, new Promise((r) => setTimeout(() => r('still running'), withinMs))]);
    clearInterval(timer);
    return { outcome, ms: Math.round(performance.now() - begun), ticks, ...info(handle) };
  },
  /** Deactivates without ending the runtime, as when `deactivate` was not confirmed and termination is still pending. */
  async deactivateOnly(handle: number) { return get(handle).session.deactivate('disable'); },
  terminate(handle: number) { get(handle).runtime.terminate(); started.delete(handle); },
  createPlatform,
  async setDeveloperMode(on: boolean) { await thePlatform().setDeveloperMode(on); },
  async sideload(spec: PackageSpec, extra: Record<string, number[]> = {}) {
    try {
      const request = await thePlatform().sideload(await archive(spec, Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, new Uint8Array(v)]))));
      return { ok: true as const, integrity: request.integrity, source: request.source, id: request.manifest.id };
    } catch (e) {
      return { ok: false as const, error: { ...describeError(e), details: (e as ExtensionError).details ?? null } };
    }
  },
  async install(spec: PackageSpec, grants: ExtensionPermission[] = [...(spec.permissions ?? [])]) {
    const p = thePlatform();
    const record = await p.install(await p.sideload(await archive(spec)), grants);
    return { id: record.id, integrity: record.integrity, source: record.source };
  },
  async platformInvoke(id: string, command: string, params: unknown = {}) {
    try {
      return { ok: true as const, value: await thePlatform().invoke(id, `${id}.${command}`, params) };
    } catch (e) {
      return { ok: false as const, error: describeError(e) };
    }
  },
  platformState(id: string) {
    const s = thePlatform().state(id);
    return s && { run: s.run, failure: s.failure?.kind ?? null, generation: s.generation, logs: s.logs.map((l) => JSON.stringify(l.entry)), integrity: s.record.integrity, source: s.record.source };
  },
  /** Whether `target` shows a tree in the running extension `id`'s interface host. */
  platformMounted(id: string, target: string) { return thePlatform().ui(id)?.get(target) !== undefined; },
  async platformRestart(id: string) { await thePlatform().restart(id); },
  async platformStopAll() { await thePlatform().stopAll(); },
  platformFailures: () => [...platformFailures],
  frames: () => document.querySelectorAll('iframe').length,
  localStorageKeys: () => Object.keys(localStorage),
};

(window as unknown as { isolation: typeof isolation }).isolation = isolation;
export type Isolation = typeof isolation;
