// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { modelImportFormat, type ImportProgress, type ModelImportReport } from '@pushform/io';

export function ModelImportDialog({ fileName, progress, report, onClose }: {
  fileName: string; progress?: ImportProgress; report?: ModelImportReport; onClose: () => void;
}): JSX.Element {
  const button = useRef<HTMLButtonElement>(null), close = useRef(onClose);
  const content = useRef<HTMLDivElement>(null), format = report?.format ?? modelImportFormat(fileName).name;
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>('.pf-app'), wasInert = app?.inert ?? false;
    if (app) app.inert = true;
    button.current?.focus();
    const keydown = (event: KeyboardEvent): void => {
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
    <div className="pf-modal pf-model-import-dialog" role="dialog" aria-modal="true" aria-labelledby="model-import-title" aria-describedby="model-import-description">
      <h2 id="model-import-title">{report ? `${format} import report` : `Importing ${format} model`}</h2>
      <div ref={content} className="pf-import-dialog-content" role="region" aria-label="Import compatibility messages" tabIndex={0}>
      <p id="model-import-description"><strong>{fileName}</strong></p>
      {report ? <>
        <p>{report.bodies} solids · {report.sheetFaces} sheet faces · {report.looseEdges} loose edges</p>
        <p>{report.definitions} definitions · {report.instances} instances · {report.materials} materials · {report.tags} tags{report.scenes ? <> · {report.scenes} scenes</> : null}{report.texts ? <> · {report.texts} texts</> : null}{report.images ? <> · {report.images} images</> : null}</p>
        {report.sectionPlanes || report.guides || report.dimensions ? <p>{report.sectionPlanes} section planes · {report.guides} guides · {report.dimensions} dimensions</p> : null}
        <p>Counts describe stored geometry; repeated instances share their definition.</p>
        {report.warnings.length ? <><h3>Import notes</h3><ul>{report.warnings.map(w => <li key={w}>{w}</li>)}</ul></> : null}
      </> : <div role="status" aria-live="polite">
        <p>{progress?.stage ?? 'Reading file…'}</p>
        {progress && progress.total > 0 ? <progress max={progress.total} value={progress.current} aria-label={`${format} import progress`} /> : <progress aria-label={`${format} import progress`} />}
      </div>}
      </div>
      <div className="pf-modal-actions"><button ref={button} type="button" onClick={onClose}>{report ? 'Continue' : 'Cancel'}</button></div>
    </div>
  </div>, document.body);
}
