// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useLayoutEffect, useRef, useSyncExternalStore, type JSX } from 'react';
import type { FileRequest } from '@pushform/extensions';
import { Dialog } from '../components/DialogParts';

interface Pending {
  readonly request: FileRequest;
  readonly finish: (allowed: boolean) => void;
}

/** Host-owned file consent; cancelled runtime calls cannot leave an actionable prompt behind. */
export class FilePrompts {
  private queue: readonly Pending[] = [];
  private readonly listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly current = (): Pending | null => this.queue[0] ?? null;
  ask(request: FileRequest, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const pending: Pending = { request, finish: allowed => {
        if (!this.queue.includes(pending)) return;
        signal?.removeEventListener('abort', abort);
        this.queue = this.queue.filter(item => item !== pending);
        resolve(allowed);
        this.changed();
      } };
      const abort = (): void => pending.finish(false);
      signal?.addEventListener('abort', abort, { once: true });
      this.queue = [...this.queue, pending];
      this.changed();
    });
  }
  answer(allowed: boolean): void { this.current()?.finish(allowed); }
  private changed(): void { for (const listener of this.listeners) listener(); }
}

export function ExtensionFileDialog({ prompts }: { readonly prompts: FilePrompts }): JSX.Element | null {
  const pending = useSyncExternalStore(prompts.subscribe, prompts.current);
  const actions = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!pending) return;
    const previous = document.activeElement as HTMLElement | null;
    actions.current?.querySelector('button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [pending]);
  if (!pending) return null;
  const { request } = pending;
  const saving = request.kind === 'save';
  return <Dialog title={`${saving ? 'Save a file from' : 'Open a file for'} ${request.extensionName}?`} onClose={() => prompts.answer(false)}>
    <p>{request.purpose}</p>
    {request.suggestedName ? <p className="pf-dialog-note">{request.suggestedName}</p> : null}
    <div className="pf-dialog-actions" ref={actions} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      const buttons = [...actions.current!.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }}>
      <button type="button" className="pf-dialog-btn" onClick={() => prompts.answer(false)}>Cancel</button>
      <button type="button" className="pf-dialog-btn is-primary" onClick={() => prompts.answer(true)}>{saving ? 'Choose where to save…' : 'Choose file…'}</button>
    </div>
  </Dialog>;
}
