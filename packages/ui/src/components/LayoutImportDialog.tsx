// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, type JSX } from 'react';
import { createPortal } from 'react-dom';

export function LayoutImportDialog({ fileName, warnings, exported = false, format = 'LayOut', onClose }: {
  fileName: string; warnings: string[]; exported?: boolean;
  /** The format named in the title, such as LayOut or STL. */
  format?: string; onClose: () => void;
}): JSX.Element {
  const button = useRef<HTMLButtonElement>(null), close = useRef(onClose);
  const content = useRef<HTMLDivElement>(null);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>('.pf-app'), wasInert = app?.inert ?? false;
    if (app) app.inert = true;
    button.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key === 'Tab') {
        event.preventDefault();
        if (document.activeElement === button.current) content.current?.focus();
        else button.current?.focus();
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      if (app) app.inert = wasInert;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<div className="pf-modal-backdrop">
    <div className="pf-modal pf-layout-import-dialog" role="dialog" aria-modal="true" aria-labelledby="layout-import-title" aria-describedby="layout-import-description">
      <h2 id="layout-import-title">{format} {exported ? 'export' : 'import'} notes</h2>
      <div ref={content} className="pf-import-dialog-content" role="region" aria-label={`${exported ? 'Export' : 'Import'} compatibility messages`} tabIndex={0}>
      <p id="layout-import-description"><strong>{fileName}</strong> was {exported ? 'exported' : 'imported'}. Some content could not be represented exactly:</p>
      <ul>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
      </div>
      <div className="pf-modal-actions"><button ref={button} type="button" onClick={onClose}>Continue</button></div>
    </div>
  </div>, document.body);
}
