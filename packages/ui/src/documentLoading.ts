// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Runtime-only file-open feedback, shared by Home, Files and local opens. */
export interface DocumentLoad { readonly name: string; readonly stage: string }

/** Allow the loading UI to paint before decoding or installing a large document. Hidden tabs also make progress. */
export function paintLoading(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame !== 'function') { setTimeout(resolve, 0); return; }
    const timeout = setTimeout(() => { cancelAnimationFrame(frame); resolve(); }, 100);
    const frame = requestAnimationFrame(() => { clearTimeout(timeout); setTimeout(resolve, 0); });
  });
}

export class DocumentLoading {
  private pending = new Map<symbol, DocumentLoad>();
  private snapshot: DocumentLoad | null = null;
  private listeners = new Set<() => void>();
  constructor(private paint: () => Promise<void> = paintLoading) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): DocumentLoad | null => this.snapshot;
  private emit(): void {
    this.snapshot = [...this.pending.values()].at(-1) ?? null;
    this.listeners.forEach(listener => listener());
  }
  async run<T>(name: string, initialStage: string, task: (stage: (label: string) => Promise<void>) => Promise<T>): Promise<T> {
    const token = Symbol();
    const stage = async (label: string): Promise<void> => {
      this.pending.set(token, { name, stage: label }); this.emit(); await this.paint();
    };
    try { await stage(initialStage); return await task(stage); }
    finally {
      // Give the newly activated editor a frame to install its viewport before removing feedback.
      await this.paint(); this.pending.delete(token); this.emit();
    }
  }
}
