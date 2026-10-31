// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { loadCommonsModel, type CloudSession, type CommonsOpenIntent, type OpenedCommonsModel } from '@pushform/cloud';
import { MESH_UNITS, type MeshUnit } from '@pushform/io';
import { openCommonsModel } from '../commonsOpening';
import type { DocumentSession } from '../session';
import { showToast } from '../toasts';

export interface CommonsOpeningConfig { intent: CommonsOpenIntent | null; filesUrl?: string | undefined; handled(): void }
export function CommonsOpening({ intent, filesUrl, cloud, session, done, opened }: { intent: CommonsOpenIntent; filesUrl: string | undefined; cloud: CloudSession | undefined; session: DocumentSession; done(): void; opened(): void }) {
  const [error, setError] = useState<string|null>(null); const [source, setSource] = useState<OpenedCommonsModel|null>(null);
  const [stage, setStage] = useState('Downloading Commons model…'); const [attempt, setAttempt] = useState(0);
  const [unit, setUnit] = useState<MeshUnit>('mm'); const [up, setUp] = useState<'z'|'y'>('z');
  const controller = useRef<AbortController|null>(null); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  const install = async (model: OpenedCommonsModel, abort: AbortController): Promise<void> => {
    try {
      setSource(null); setStage('Opening a new model…');
      const result = await openCommonsModel(session, model, abort.signal, /\.(obj|stl|3ds)$/i.test(model.name) ? { unit, up } : undefined);
      if (!alive.current || abort.signal.aborted) return;
      showToast(result.warnings.length ? `Commons model opened with ${result.warnings.length} import notices. Original credits are retained.` : 'Commons model opened. Original licenses and credits are retained.');
      opened(); done();
    } catch (cause) { if (alive.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not open this model.'); }
  };
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort; setError(null); setSource(null); setStage('Downloading Commons model…');
    void (async () => {
      try {
        const token = await cloud?.getAccessToken(); if (!token) throw new Error('Sign in to open this Commons model.');
        const model = await loadCommonsModel(filesUrl ?? '', token, intent, abort.signal);
        if (abort.signal.aborted) return;
        if (/\.(obj|stl|3ds)$/i.test(model.name)) setSource(model);
        else await install(model, abort);
      } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not open this model.'); }
    })();
    return () => abort.abort();
  }, [attempt, intent, filesUrl, cloud]);
  return createPortal(<div className="pf-modal-backdrop"><section className="pf-modal" role="dialog" aria-modal="true" aria-label="Open Commons model">
    <h2>Open in PushForm</h2>
    {error ? <><p role="alert">{error}</p><button onClick={() => setAttempt(n => n + 1)}>Try again</button></> : source ? <>
      <p>{source.attribution.title} by {source.attribution.creator}</p><p>This file does not record its units. Choose how to read its dimensions.</p>
      <label>Units <select value={unit} onChange={event => setUnit(event.target.value as MeshUnit)}>{MESH_UNITS.map(item => <option key={item.unit} value={item.unit}>{item.label}</option>)}</select></label>
      <label>Up axis <select value={up} onChange={event => setUp(event.target.value as 'z'|'y')}><option value="z">Z up</option><option value="y">Y up</option></select></label>
      <button onClick={() => { if (controller.current) void install(source, controller.current); }}>Open model</button>
    </> : <p role="status">{stage}</p>}
    <p>Opens a separate model with its original licenses and credits. Your current project stays open.</p>
    <button onClick={() => { controller.current?.abort(); done(); }}>Cancel</button>
  </section></div>, document.body);
}
