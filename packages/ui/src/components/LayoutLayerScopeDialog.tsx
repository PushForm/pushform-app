// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';

export function LayoutLayerScopeDialog({ onCancel, onApply }: {
  onCancel: () => void;
  onApply: (source: 'current' | 'all') => void;
}): JSX.Element {
  const [source, setSource] = useState<'current' | 'all'>('current');
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>('.pf-app');
    const wasInert = app?.inert ?? false;
    if (app) app.inert = true;
    dialog.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
    const keydown = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { event.preventDefault(); cancel.current(); }
      if (event.key === 'Tab') {
        event.preventDefault();
        const controls = [...dialog.current!.querySelectorAll<HTMLElement>('input:checked, button')];
        const index = controls.indexOf(document.activeElement as HTMLElement);
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      if (app) app.inert = wasInert;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<div className="pf-layer-scope-backdrop">
    <div ref={dialog} className="pf-layer-scope-dialog" role="dialog" aria-modal="true" aria-label="Choose shared layer content">
      <p>This layer includes entities on multiple pages. Which entities do you want included in the new shared layer?</p>
      <label><input type="radio" name="layer-scope-source" checked={source === 'current'} onChange={() => setSource('current')} />Include only entities from this page</label>
      <label><input type="radio" name="layer-scope-source" checked={source === 'all'} onChange={() => setSource('all')} />Collect entities from all pages</label>
      <div className="pf-layer-scope-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="button" onClick={() => onApply(source)}>Apply</button></div>
    </div>
  </div>, document.body);
}
