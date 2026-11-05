// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export function UnsavedChangesDialog({ name, busy, error, onChoose }: {
  name: string; busy: boolean; error: string | null; onChoose(choice: 'save' | 'discard' | 'cancel'): void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const latest = useRef({ busy, onChoose }); latest.current = { busy, onChoose };
  useEffect(() => {
    const app = document.querySelector<HTMLElement>('.pf-app'), inert = app?.inert ?? false;
    const previous = document.activeElement as HTMLElement | null;
    if (app) app.inert = true;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); return; }
      if (event.key === 'Escape' && !latest.current.busy) { event.preventDefault(); latest.current.onChoose('cancel'); }
      if (event.key === 'Tab') {
        const controls = [...dialog.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = controls.indexOf(document.activeElement as HTMLButtonElement);
        if (!controls.length) { event.preventDefault(); return; }
        if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === controls.length - 1) {
          event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
        }
      }
    };
    const keyup = (event: KeyboardEvent) => event.stopImmediatePropagation();
    window.addEventListener('keydown', keydown, true); window.addEventListener('keyup', keyup, true);
    return () => {
      window.removeEventListener('keydown', keydown, true); window.removeEventListener('keyup', keyup, true);
      if (app) app.inert = inert; if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<div className="pf-modal-backdrop"><section className="pf-modal pf-unsaved-dialog" role="dialog"
    aria-modal="true" aria-label="Unsaved changes" aria-busy={busy} ref={dialog}>
    <h2>Save changes to {name}?</h2><p>Save your changes before closing this document.</p>
    {busy && <p role="status">Saving changes…</p>}
    {error && <p className="pf-unsaved-error" role="alert">{error}</p>}
    <div className="pf-modal-actions">
      <button type="button" className="pf-dialog-btn" disabled={busy} onClick={() => onChoose('cancel')}>Cancel</button>
      <button type="button" className="pf-dialog-btn" disabled={busy} onClick={() => onChoose('discard')}>Discard</button>
      <button type="button" className="pf-dialog-btn is-primary" disabled={busy} onClick={() => onChoose('save')}>{busy ? 'Saving…' : error ? 'Retry save' : 'Save'}</button>
    </div>
  </section></div>, document.body);
}
