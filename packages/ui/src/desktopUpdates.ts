// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { invoke, isTauri } from '@tauri-apps/api/core';

/** Desktop update channels; stable by default. */
export type UpdateChannel = 'stable' | 'nightly';

/** The desktop app's update commands (apps/desktop/src-tauri/src/updates.rs). */
export interface UpdateBackend {
  /** Whether this build carries the updater's public key. */
  enabled(): Promise<boolean>;
  /** Checks the channel and downloads a newer version; its version once ready, `null` when the app is current. */
  fetch(channel: UpdateChannel): Promise<{ version: string } | null>;
  /** Installs the downloaded update and restarts; never resolves on success. */
  install(): Promise<void>;
}

export interface DesktopUpdateState {
  /** Updates are checked (a desktop build with the updater key). */
  readonly enabled: boolean;
  readonly channel: UpdateChannel;
  /** Feedback shown in About for the latest check. */
  readonly checkStatus: 'idle' | 'checking' | 'current' | 'ready' | 'failed';
  /** The downloaded update waiting to be installed. */
  readonly ready: string | null;
  /** Later hid the notice for this version. */
  readonly dismissed: boolean;
  /** The Update required dialog is open. */
  readonly required: boolean;
  readonly installing: boolean;
  /** Why the last restart did not happen. */
  readonly error: string | null;
}

/** Checked at start and every six hours. */
export const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
/** How long an update may wait before it must be installed to open another document. */
export const UPDATE_GRACE = 7 * 24 * 60 * 60 * 1000;
const CHANNEL_KEY = 'pushform.updates.channel';
const READY_SINCE_KEY = 'pushform.updates.readySince';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const tauriUpdateBackend: UpdateBackend = {
  enabled: () => invoke<boolean>('update_enabled'),
  fetch: channel => invoke<{ version: string } | null>('update_fetch', { channel }),
  install: () => invoke<void>('update_install'),
};

/** Checks, downloads and installs desktop updates. */
export class DesktopUpdates {
  private state: DesktopUpdateState;
  private listeners = new Set<() => void>();
  private checking: Promise<void> | null = null;

  constructor(private backend: UpdateBackend, private store: Store | null, private now: () => number = Date.now) {
    this.state = { enabled: false, channel: this.read(CHANNEL_KEY) === 'nightly' ? 'nightly' : 'stable', ready: null,
      dismissed: false, required: false, installing: false, error: null, checkStatus: 'idle' };
  }

  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): DesktopUpdateState => this.state;

  private set(patch: Partial<DesktopUpdateState>): void { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  private read(key: string): string | null { try { return this.store?.getItem(key) ?? null; } catch { return null; } }
  private write(key: string, value: string | null): void {
    try { if (value === null) this.store?.removeItem(key); else this.store?.setItem(key, value); } catch { /* Kept for this run only. */ }
  }

  /** Starts checking if this build can update; returns the function that stops the timer. */
  start(timers: Pick<typeof globalThis, 'setInterval' | 'clearInterval'> = globalThis): () => void {
    let stopped = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    void this.backend.enabled().catch(() => false).then(enabled => {
      if (stopped || !enabled) return;
      this.set({ enabled: true });
      void this.check();
      interval = timers.setInterval(() => { void this.check(); }, UPDATE_CHECK_INTERVAL);
    });
    return () => { stopped = true; if (interval !== undefined) timers.clearInterval(interval); };
  }

  /** One check of the current channel; failures are silent and wait for the next check. */
  check(): Promise<void> {
    if (!this.state.enabled) return Promise.resolve();
    if (this.checking) return this.checking;
    const channel = this.state.channel;
    this.set({ checkStatus: 'checking' });
    this.checking = this.backend.fetch(channel).then(found => {
      if (channel !== this.state.channel) return;
      if (!found) {
        this.write(READY_SINCE_KEY, null);
        this.set({ ready: null, dismissed: false, required: false, checkStatus: 'current' });
        return;
      }
      if (this.read(READY_SINCE_KEY) === null) this.write(READY_SINCE_KEY, String(this.now()));
      this.set({ checkStatus: 'ready', ...(found.version !== this.state.ready
        ? { ready: found.version, dismissed: false, error: null } : {}) });
    }).catch(() => { if (channel === this.state.channel) this.set({ checkStatus: 'failed' }); }).finally(() => { this.checking = null; });
    return this.checking;
  }

  /** Remembered on the device; the new channel is checked at once. */
  setChannel(channel: UpdateChannel): Promise<void> {
    if (channel === this.state.channel) return Promise.resolve();
    this.write(CHANNEL_KEY, channel);
    this.set({ channel });
    return (this.checking ?? Promise.resolve()).then(() => this.check());
  }

  /** Whether the ready update has waited a week, from when this device first had one ready. */
  overdue(): boolean {
    if (!this.state.ready) return false;
    const since = Number(this.read(READY_SINCE_KEY));
    return Number.isFinite(since) && since > 0 && this.now() - since >= UPDATE_GRACE;
  }

  /** Call before opening or creating a document: false (and the Update required dialog opens) once overdue. */
  allowOpening(): boolean {
    if (!this.overdue()) return true;
    this.set({ required: true, error: null });
    return false;
  }

  dismiss(): void { this.set({ dismissed: true }); }
  closeRequired(): void { this.set({ required: false, error: null }); }

  /** Save every document with changes first; install only when all of them saved. */
  async install(saveAll: () => Promise<void>): Promise<void> {
    if (!this.state.ready || this.state.installing) return;
    this.set({ installing: true, error: null });
    try {
      await saveAll();
    } catch {
      this.set({ installing: false, dismissed: false,
        error: 'The update waits until your changes are saved. Check your connection and try again.' });
      return;
    }
    try {
      await this.backend.install();
    } catch (cause) {
      this.set({ installing: false, dismissed: false,
        error: `The update could not be installed: ${cause instanceof Error ? cause.message : String(cause)}` });
    }
  }
}

let current: DesktopUpdates | null | undefined;

/** The desktop app's updater; null in the browser, which never updates. */
export function desktopUpdates(): DesktopUpdates | null {
  if (current === undefined) {
    let store: Store | null = null;
    try { store = typeof window === 'undefined' ? null : window.localStorage; } catch { /* Storage blocked. */ }
    current = isTauri() ? new DesktopUpdates(tauriUpdateBackend, store) : null;
  }
  return current;
}

/** Replace the updater (tests); undefined goes back to detecting the host. */
export function setDesktopUpdates(updates: DesktopUpdates | null | undefined): void { current = updates; }

/** False when the user must install the waiting update before opening another document. */
export function allowOpeningDocument(): boolean {
  return desktopUpdates()?.allowOpening() ?? true;
}
