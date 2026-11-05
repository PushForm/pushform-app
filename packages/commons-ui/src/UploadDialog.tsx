// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useCallback, useId, useEffect, useMemo, useRef, useState, type DragEvent, type JSX, type ReactNode } from 'react';
import { COMMONS_FILE_LIMIT, COMMONS_IMAGE_LIMIT, COMMONS_MODEL_EXTENSIONS, CommonsPublishing, commonsHandleSchema, commonsFileKind, fetchCommonsImage, fetchCommonsThumbnail,
  removeCommonsFile, streamCommonsRender, uploadCommonsFile, type CommonsOwnModels, type CommonsOwnRevision, type CommonsProfile,
  type CommonsSubmission, type CommonsRenderEvent, type CommonsUpload, type CommonsUploadProgress } from '@pushform/cloud';
import type { CommonsAccount } from './account';
import { CATEGORIES, DESCRIPTION_LIMIT, RIGHTS_BASIS, TITLE_LIMIT, detailsFromMetadata, detailsProblem, formatBytes, metadataFor, publishLicenses,
  titleFromFileName, type LicenseChoice, type LicenseKey, type ModelDetails } from './modelDetails';

/** One file in the dialog: its upload, then (for the model file) its conversion. */
interface FileState {
  name: string; size: number; asset: CommonsUpload | null;
  upload: CommonsUploadProgress | null; error: string | null;
  render: CommonsRenderEvent | { state: 'idle' } ;
  image: string | null;
}
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
interface ModelState { id: string; published: string | null; draft: CommonsOwnRevision | null; current: CommonsOwnRevision | null }
export interface UploadDialogProps {
  account: CommonsAccount; filesUrl: string | undefined;
  /** The model to edit, or null to upload a new one. */
  modelId: string | null;
  initialFile?: File | undefined;
  snapshotLabel?: string | undefined;
  scopeControl?: ReactNode;
  inherited?: (Pick<CommonsSubmission, 'licenses' | 'credits' | 'source'> & { creator?: string }) | undefined;
  newModelId?: string | undefined;
  onClose(): void; onPublished(modelId: string): void;
}

const ACCEPT = [...COMMONS_MODEL_EXTENSIONS].map((extension) => '.' + extension).join(',');
const FORMAT_LIST = 'SKP, SKB, DAE, KMZ, OBJ, 3DS, STL, DXF, glTF, GLB, STEP, PF, FCStd or ZIP';
const SAVE_DELAY_MS = 800;
const POLL_MS = 3000;
const emptyDetails: ModelDetails = { title: '', description: '', category: 'Other', license: 'CC BY 4.0', terms: '' };

/** Upload verification and preview progress. */
export function fileStatus(file: FileState): { label: string; detail: string | null; tone: 'busy' | 'good' | 'bad'; progress: number | null } {
  if (file.error) return { label: file.asset ? 'Preview failed' : 'Upload failed', detail: file.error, tone: 'bad', progress: null };
  const upload = file.upload;
  if (upload && upload.stage === 'preparing') return { label: 'Preparing upload', detail: null, tone: 'busy', progress: 0 };
  if (upload && upload.stage === 'uploading') {
    const share = upload.total ? upload.loaded / upload.total : 0;
    return { label: `Uploading ${Math.floor(share * 100)}%`, detail: `${formatBytes(upload.loaded)} of ${formatBytes(upload.total)}`, tone: 'busy', progress: share };
  }
  if (upload && upload.stage === 'verifying') return { label: 'Checking file', detail: 'Size and checksum', tone: 'busy', progress: 1 };
  const render = file.render;
  if (render.state === 'waiting') return { label: 'Waiting for converter', detail: 'Your other conversions finish first.', tone: 'busy', progress: null };
  if (render.state === 'starting' || render.state === 'converting') return { label: 'Converting preview', detail: 'Upload complete. File checked.', tone: 'busy', progress: null };
  if (render.state === 'storing') return { label: 'Saving preview', detail: null, tone: 'busy', progress: null };
  if (render.state === 'pending') return { label: 'Preview on its way', detail: 'You can publish now; the preview finishes shortly.', tone: 'busy', progress: null };
  if (render.state === 'ready') return { label: 'Preview ready', detail: render.triangles !== null ? `${render.triangles.toLocaleString()} triangles` : null, tone: 'good', progress: null };
  if (render.state === 'failed') return { label: 'Preview failed', detail: render.error, tone: 'bad', progress: null };
  return { label: 'File checked', detail: null, tone: 'good', progress: null };
}

export function UploadDialog({ account, filesUrl, modelId, initialFile, newModelId, snapshotLabel, scopeControl, inherited, onClose, onPublished }: UploadDialogProps): JSX.Element {
  const api = useMemo(() => new CommonsPublishing(account.client), [account.client]);
  const [profile, setProfile] = useState<CommonsProfile | null | undefined>();
  const [loadError, setLoadError] = useState('');
  const [model, setModel] = useState<ModelState | null>(null);
  const [step, setStep] = useState<'upload' | 'details'>(modelId ? 'details' : 'upload');
  const [details, setDetails] = useState<ModelDetails>(emptyDetails);
  const [modelFile, setModelFile] = useState<FileState | null>(null);
  const [cover, setCover] = useState<FileState | null>(null);
  const [save, setSave] = useState<SaveState>('idle');
  const [message, setMessage] = useState('');
  const [creditCreator, setCreditCreator] = useState(inherited?.creator ?? '');
  const [rights, setRights] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(modelId !== null);
  const modelRef = useRef<ModelState | null>(null); modelRef.current = model;
  const detailsRef = useRef(details); detailsRef.current = details;
  const filesRef = useRef<string[]>([]);
  const creating = useRef<Promise<CommonsOwnRevision> | null>(null);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const dirty = useRef(false);
  const control = useRef(new AbortController());
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const urls = useRef<string[]>([]);

  const token = useCallback(async () => {
    const value = await account.session.getAccessToken();
    if (!value) throw new Error('Sign in again to keep working on this model.');
    return value;
  }, [account.session]);
  const blobUrl = (blob: Blob) => { const url = URL.createObjectURL(blob); urls.current.push(url); return url; };

  useEffect(() => () => { control.current.abort(); for (const url of urls.current) URL.revokeObjectURL(url); }, []);
  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && dialog.current) {
        const controls = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden]), textarea:not(:disabled), select:not(:disabled)')].filter(control => control.offsetParent !== null);
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (controls.length && (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === controls.length - 1)) { event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0]?.focus(); }
      }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const abort = new AbortController();
    void account.profiles.mine(abort.signal).then(setProfile, () => { if (!abort.signal.aborted) setLoadError('Your public profile could not be loaded. Try again.'); });
    return () => abort.abort();
  }, [account.profiles]);

  /** The model's current state from My models: its draft, its published revision and their files. */
  const refresh = useCallback(async (id: string): Promise<{ state: CommonsOwnModels; model: ModelState }> => {
    const state = await api.mine(control.current.signal);
    const row = state.models.find((item) => item.id === id);
    if (!row) throw new Error('This model is no longer available.');
    const revision = (rid: string | null) => state.revisions.find((item) => item.id === rid) ?? null;
    const latest = revision(row.latest_submission), published = revision(row.published_revision);
    const draft = latest && latest.status === 'pending' ? latest : null;
    const next = { id, published: row.published_revision, draft, current: draft ?? published };
    setModel(next); modelRef.current = next;
    return { state, model: next };
  }, [api]);

  const startRender = useCallback(async (asset: CommonsUpload, retry = false) => {
    if (!filesUrl) return;
    const set = (render: FileState['render']) => setModelFile((file) => file && file.asset?.id === asset.id ? { ...file, render, error: null } : file);
    const thumbnail = async () => {
      for (let attempt = 0; attempt < 40 && !control.current.signal.aborted; attempt++) {
        const result = await fetchCommonsThumbnail(filesUrl, await token(), asset.id, control.current.signal);
        if (result.kind === 'image') { const url = blobUrl(result.blob); setModelFile((file) => file && file.asset?.id === asset.id ? { ...file, image: url } : file); return; }
        if (result.status === 'failed' || result.status === 'unsupported' || result.status === 'missing') return;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    };
    try {
      set({ state: 'starting' });
      const last = await streamCommonsRender(filesUrl, await token(), asset.id, control.current.signal, set, { retry });
      if (last.state === 'ready' || last.state === 'pending') await thumbnail();
    } catch (failure) {
      if (control.current.signal.aborted) return;
      set({ state: 'failed', error: failure instanceof Error ? failure.message : 'The preview could not be created.', code: null, retry: true });
    }
  }, [filesUrl, token]);

  // Edit: load the model, its details and files, and resume its preview.
  useEffect(() => {
    if (!modelId || !filesUrl) return;
    let live = true;
    void (async () => {
      try {
        const { state, model: loaded } = await refresh(modelId);
        if (!live) return;
        setDetails(detailsFromMetadata(loaded.current?.metadata));
        const files = state.assets.filter((asset) => asset.revision_id === loaded.current?.id);
        // An upload interrupted by closing the dialog is discarded; the owner chooses the file again.
        for (const pending of files.filter((asset) => asset.status === 'pending')) await removeCommonsFile(filesUrl, await token(), pending.id, control.current.signal).catch(() => {});
        const ready = files.filter((asset) => asset.status === 'ready');
        filesRef.current = ready.map((asset) => asset.filename);
        const main = ready.find((asset) => commonsFileKind(asset.filename) === 'model' || !commonsFileKind(asset.filename));
        const picture = ready.find((asset) => commonsFileKind(asset.filename) === 'image');
        if (main) { setModelFile({ name: main.filename, size: main.size_bytes, asset: main, upload: null, error: null, render: { state: 'idle' }, image: null }); void startRender(main); }
        if (picture) {
          setCover({ name: picture.filename, size: picture.size_bytes, asset: picture, upload: null, error: null, render: { state: 'idle' }, image: null });
          const url = blobUrl(await fetchCommonsImage(filesUrl, await token(), picture.id, control.current.signal));
          setCover((file) => file ? { ...file, image: url } : file);
        }
      } catch (failure) { if (live) setLoadError(failure instanceof Error ? failure.message : 'This model could not be loaded.'); }
      finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [modelId, filesUrl, refresh, startRender, token]);

  const publicationMetadata = useCallback((...args: Parameters<typeof metadataFor>) => {
    const metadata = metadataFor(...args);
    if (!inherited) return args[3]?.source ? { ...metadata, creator: args[3].creator } : metadata;
    const publisher = args[1];
    const credits = [...metadata.credits.filter(credit => credit.text !== `Original model by ${publisher}.`), ...inherited.credits, { name: publisher, url: null, text: `Published by ${publisher}.` }];
    return { ...metadata, creator: creditCreator.trim(), source: inherited.source, licenses: [...metadata.licenses, ...inherited.licenses], credits: [...new Map(credits.map(credit => [JSON.stringify(credit), credit])).values()] };
  }, [inherited, creditCreator]);
  const creator = profile?.displayName ?? '';
  /** The pending revision changes go into, created on first need: a new model, or the next revision of a published one. */
  const ensureDraft = useCallback(async (): Promise<CommonsOwnRevision> => {
    const current = modelRef.current;
    if (current?.draft) return current.draft;
    if (!creating.current) {
      creating.current = (async () => {
        const id = current?.id ?? newModelId ?? 'model-' + crypto.randomUUID();
        const draft = await api.submit(id, publicationMetadata(detailsRef.current, creator, filesRef.current, current?.current?.metadata), RIGHTS_BASIS, !inherited && !current?.current?.metadata.source, current?.published ?? null, control.current.signal);
        const { state } = await refresh(id);
        // A published model's next revision carries its files over as new records: point the dialog at them.
        const copies = state.assets.filter((asset) => asset.revision_id === draft.id && asset.status === 'ready');
        setModelFile((file) => { const copy = file?.asset && copies.find((asset) => asset.sha256 === file.asset!.sha256 && asset.filename === file.asset!.filename); return file && copy ? { ...file, asset: copy } : file; });
        setCover((file) => { const copy = file?.asset && copies.find((asset) => asset.sha256 === file.asset!.sha256 && asset.filename === file.asset!.filename); return file && copy ? { ...file, asset: copy } : file; });
        dirty.current = false;
        return draft;
      })().finally(() => { creating.current = null; });
    }
    return await creating.current;
  }, [api, creator, refresh, newModelId, inherited, publicationMetadata]);

  /** Saves the details into the draft in place. */
  const saveNow = useCallback(async () => {
    const current = modelRef.current, values = detailsRef.current;
    if (!dirty.current || detailsProblem(values)) return;
    setSave('saving');
    try {
      if (!current?.draft) await ensureDraft();
      else {
        dirty.current = false;
        const updated = await api.updateDraft(current.draft.id, publicationMetadata(values, creator, filesRef.current, current.draft.metadata), current.draft.details_version, control.current.signal);
        const next = { ...current, draft: updated, current: updated }; setModel(next); modelRef.current = next;
      }
      setSave('saved');
    } catch (failure) {
      dirty.current = true; setSave('error');
      setMessage(failure instanceof Error ? failure.message : 'Your changes could not be saved.');
    }
  }, [api, creator, ensureDraft]);
  const queueSave = useCallback(() => { saving.current = saving.current.then(saveNow); return saving.current; }, [saveNow]);

  const update = (patch: Partial<ModelDetails>) => { setDetails((value) => ({ ...value, ...patch })); dirty.current = true; setSave('idle'); setMessage(''); };
  useEffect(() => {
    if (!dirty.current || (!model && step !== 'details')) return;
    if (!model && !modelFile?.asset) return;
    const timer = setTimeout(() => { void queueSave(); }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [details, model, modelFile?.asset, step, queueSave]);

  /** Uploads a model file or cover photo into the draft, replacing the previous one. */
  const uploadInto = async (file: File, kind: 'model' | 'image') => {
    if (!filesUrl) return;
    const set = kind === 'model' ? setModelFile : setCover;
    const previous = kind === 'model' ? modelFile : cover;
    set({ name: file.name, size: file.size, asset: null, upload: { stage: 'preparing', loaded: 0, total: file.size }, error: null, render: { state: 'idle' }, image: null });
    try {
      const draft = await ensureDraft();
      const old = previous?.asset ? (await refresh(modelRef.current!.id)).state.assets.find((asset) => asset.revision_id === draft.id && asset.status !== 'removed' && asset.sha256 === previous.asset!.sha256 && asset.filename === previous.asset!.filename) : null;
      if (old) await removeCommonsFile(filesUrl, await token(), old.id, control.current.signal);
      const asset = await uploadCommonsFile(filesUrl, await token(), draft.id, file, control.current.signal,
        { onProgress: (progress) => set((value) => value && value.name === file.name ? { ...value, upload: progress } : value) });
      filesRef.current = [...filesRef.current.filter((name) => name !== previous?.name), file.name];
      set((value) => value && value.name === file.name ? { ...value, asset, upload: null } : value);
      if (kind === 'model') { dirty.current = true; void queueSave(); void startRender(asset); }
      else set((value) => value && value.name === file.name ? { ...value, image: blobUrl(file) } : value);
    } catch (failure) {
      if (control.current.signal.aborted) return;
      set((value) => value && value.name === file.name ? { ...value, upload: null, error: failure instanceof Error ? failure.message : 'The upload failed. Try again.' } : value);
    }
  };

  const chooseModel = (file: File | undefined) => {
    if (!file) return;
    setMessage('');
    if (commonsFileKind(file.name) !== 'model') { setMessage(`Choose a ${FORMAT_LIST} file.`); return; }
    if (file.size < 1 || file.size > COMMONS_FILE_LIMIT) { setMessage('Choose a file of up to 128 MiB.'); return; }
    if (step === 'upload') { setDetails((value) => ({ ...value, title: value.title || titleFromFileName(file.name) })); detailsRef.current = { ...detailsRef.current, title: detailsRef.current.title || titleFromFileName(file.name) }; setStep('details'); }
    void uploadInto(file, 'model');
  };
  const seeded = useRef(false);
  useEffect(() => {
    if (!initialFile || seeded.current || !profile?.active || loading || loadError) return;
    seeded.current = true;
    chooseModel(initialFile);
  }, [initialFile, profile, loading, loadError]);

  const chooseCover = (file: File | undefined) => {
    if (!file) return;
    if (commonsFileKind(file.name) !== 'image' || !/^image\/(png|jpeg)$/.test(file.type)) { setMessage('Choose a PNG or JPEG cover photo.'); return; }
    if (file.size > COMMONS_IMAGE_LIMIT) { setMessage('Choose a cover photo of up to 8 MiB.'); return; }
    void uploadInto(file, 'image');
  };
  const removeCover = async () => {
    if (!filesUrl || !cover?.asset) { setCover(null); return; }
    try {
      const draft = await ensureDraft();
      const current = (await refresh(modelRef.current!.id)).state.assets.find((asset) => asset.revision_id === draft.id && asset.status !== 'removed' && asset.filename === cover.name);
      if (current) await removeCommonsFile(filesUrl, await token(), current.id, control.current.signal);
      filesRef.current = filesRef.current.filter((name) => name !== cover.name);
      setCover(null);
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : 'The cover photo could not be removed.'); }
  };

  const shareAlike = inherited?.licenses.find(license => /ShareAlike|(?:^|-)SA(?:-| |$)/i.test(license.name));
  const problem = (inherited && !creditCreator.trim() ? 'Enter the creator credit.' : null) ?? detailsProblem(details) ?? (shareAlike && details.license !== shareAlike.name ? 'This source requires its ShareAlike license. Choose the same license before publishing.' : null);
  const fileReady = !!modelFile?.asset && !modelFile.upload && !modelFile.error;
  const coverBusy = !!cover && (!!cover.upload || (!cover.asset && !cover.error));
  const hasChanges = !!model?.draft || dirty.current || !model?.published;
  const canPublish = fileReady && !coverBusy && !problem && rights && !publishing && hasChanges;
  const publish = async () => {
    if (!canPublish) return;
    setPublishing(true); setMessage('');
    try {
      dirty.current = true; await queueSave();
      const draft = await ensureDraft();
      const { model: fresh, state } = await refresh(modelRef.current!.id);
      const revision = state.revisions.find((item) => item.id === draft.id)!;
      await api.publish(revision.id, fresh.published, revision.asset_version, true, control.current.signal);
      window.dispatchEvent(new Event('commons:catalog-changed'));
      onPublished(fresh.id);
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : 'The model could not be published.');
    } finally { setPublishing(false); }
  };

  const onDrop = (event: DragEvent) => { event.preventDefault(); setDragging(false); chooseModel(event.dataTransfer.files[0]); };
  const status = modelFile ? fileStatus(modelFile) : null;
  const editing = modelId !== null;

  const body = (() => {
    if (!filesUrl) return <p role="alert">Uploads are unavailable in this build.</p>;
    if (loadError) return <p role="alert">{loadError}</p>;
    if (profile === undefined || loading) return <p role="status">Loading…</p>;
    if (!profile?.active) return <ProfileStep account={account} profile={profile} onReady={setProfile}/>;
    if (step === 'upload') return <div className={dragging ? 'drop-zone dragging' : 'drop-zone'} onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <p className="drop-main">Drag a model file here</p>
      <button type="button" className="link-button" onClick={() => fileInput.current?.click()}>or browse for a file</button>
      <p className="drop-note">{FORMAT_LIST}</p>
      <p className="drop-note">One file up to 128 MiB. The draft stays private until you publish.</p>
      {message && <p role="alert">{message}</p>}
    </div>;
    return <div className="upload-details">
      <section className="upload-files" aria-label="Files">
        <div className="upload-preview">{modelFile?.image ? <img src={modelFile.image} alt={`Preview of ${details.title || modelFile.name}`}/> : <span aria-hidden="true">◇</span>}</div>
        {modelFile && status && <div className={`file-row tone-${status.tone}`}>
          <div className="file-head"><strong>{modelFile.name}</strong><span>{formatBytes(modelFile.size)}</span></div>
          {status.progress !== null && <div className="file-bar" role="progressbar" aria-label={`Uploading ${modelFile.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(status.progress * 100)}><span style={{ width: `${Math.round(status.progress * 100)}%` }}/></div>}
          <p className="file-state" role="status"><span className="dot" aria-hidden="true"/>{status.label}</p>
          {status.detail && <p className="file-detail">{status.detail}</p>}
          <div className="file-actions">
            {modelFile.error && !modelFile.asset && <button type="button" className="secondary" onClick={() => fileInput.current?.click()}>Try again</button>}
            {modelFile.render.state === 'failed' && modelFile.render.retry && modelFile.asset && <button type="button" className="secondary" onClick={() => void startRender(modelFile.asset!, true)}>Try again</button>}
            <button type="button" className="secondary" disabled={!!modelFile.upload} onClick={() => fileInput.current?.click()}>Replace file</button>
          </div>
        </div>}
        {!modelFile && <button type="button" onClick={() => fileInput.current?.click()}>Choose a model file</button>}
        <div className="cover-field">
          {cover?.image ? <img src={cover.image} alt="Cover photo"/> : null}
          {cover ? <p className="file-detail">{cover.error ?? (cover.upload ? fileStatus(cover).label : cover.name)}</p> : null}
          <div className="file-actions">
            <button type="button" className="secondary" disabled={coverBusy} onClick={() => coverInput.current?.click()}>{cover ? 'Replace cover photo' : 'Add a cover photo'}</button>
            {cover && !coverBusy && <button type="button" className="secondary" onClick={() => void removeCover()}>Remove</button>}
          </div>
          <p className="file-detail">Optional. PNG or JPEG, up to 8 MiB. Without one, the preview is used.</p>
        </div>
      </section>
      <section className="upload-form" aria-label="Details">
        {inherited && <label>Creator credit<input value={creditCreator} maxLength={1000} onChange={event => { setCreditCreator(event.target.value); dirty.current = true; }} /><span className="field-note">Keep the original creator for redistributed work. For your own design using these sources, enter your public name. Original source notices remain attached.</span></label>}
        <label><span className="field-head"><span>Title *</span><span>{details.title.length} / {TITLE_LIMIT}</span></span>
          <input value={details.title} maxLength={TITLE_LIMIT} onChange={(event) => update({ title: event.target.value })}/></label>
        <label><span className="field-head"><span>Description</span><span>Optional · {details.description.length.toLocaleString()} / {DESCRIPTION_LIMIT.toLocaleString()}</span></span>
          <textarea value={details.description} maxLength={DESCRIPTION_LIMIT} rows={5} placeholder="What it is, how it is built, sizes and materials" onChange={(event) => update({ description: event.target.value })}/></label>
        <label><span className="field-head"><span>Category *</span></span>
          <select value={details.category} onChange={(event) => update({ category: event.target.value })}>{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label>
        <label><span className="field-head"><span>License *</span></span>
          <select value={details.license} onChange={(event) => update({ license: event.target.value as LicenseChoice })}>
            {(Object.keys(publishLicenses) as LicenseKey[]).map((key) => <option key={key} value={key}>{publishLicenses[key].label}</option>)}
            <option value="other">Other (describe the terms)</option>
          </select></label>
        <p className="field-note">{details.license === 'other' ? 'Describe how others may use, share and credit this model.' : publishLicenses[details.license].summary}</p>
        {details.license === 'other' && <label><span className="field-head"><span>License terms *</span></span>
          <textarea value={details.terms} rows={4} onChange={(event) => update({ terms: event.target.value })}/></label>}
        {!snapshotLabel && <label className="rights"><input type="checkbox" checked={rights} onChange={(event) => setRights(event.target.checked)}/>
          <span>I created this model, or have the right to share it and everything it includes under this license.</span></label>}
      </section>
    </div>;
  })();

  const saveLabel = save === 'saving' ? 'Saving…' : save === 'saved' ? 'Draft saved' : save === 'error' ? 'Not saved' : model?.draft ? 'Draft saved' : '';
  const blocked = step === 'details' && profile?.active ? (!modelFile ? 'Add a model file.' : !fileReady ? (modelFile.error ? 'Upload the model file again.' : 'Waiting for the file check.') : problem ?? (!rights && (!snapshotLabel || reviewing) ? 'Confirm your right to share it.' : !hasChanges ? 'No changes to publish.' : null)) : null;
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className={`upload-dialog${!profile?.active ? ' upload-dialog-profile' : ''}`} role="dialog" aria-modal="true" aria-labelledby="upload-dialog-title">
      <header className="dialog-head">
        <div><h2 id="upload-dialog-title" ref={heading} tabIndex={-1}>{snapshotLabel ? 'Share with the community' : editing ? 'Edit model' : 'Upload model'}</h2>
          {profile?.active && snapshotLabel ? <ol className="dialog-steps"><li aria-current={!reviewing ? 'step' : undefined}>1 Details</li><li aria-current={reviewing ? 'step' : undefined}>2 Review</li></ol> : profile?.active && <ol className="dialog-steps"><li aria-current={step === 'upload' ? 'step' : undefined}>1 Upload</li><li aria-current={step === 'details' ? 'step' : undefined}>2 Details</li></ol>}</div>
        <button type="button" className="dialog-close" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <div className="dialog-body">{scopeControl}{snapshotLabel && <p className="snapshot-note">{snapshotLabel}. This exact snapshot is used; later edits stay private.</p>}{inherited && <section aria-label="Retained source licenses"><h3>Original licenses and credits</h3>{inherited.licenses.map((license, index) => <p key={index}>{license.name}: {license.conditions.join('; ')}</p>)}{inherited.credits.map((credit, index) => <p key={index}>{credit.name}: {credit.text}</p>)}</section>}{reviewing ? <section><h3>Review your public snapshot</h3><p>{details.title} by {inherited ? creditCreator : model?.current?.metadata.source ? model.current.metadata.creator : creator}</p><p>{details.description}</p><p>Commons revision {model?.draft?.number ?? (model?.current?.number ?? 0) + 1}. License: {details.license}</p><p>Private change notes and cloud history are not published. Future edits stay private.</p><label><input type="checkbox" checked={rights} onChange={event => setRights(event.target.checked)} />I have the right to publish this model and its included assets under the listed terms.</label><button type="button" className="secondary" onClick={() => setReviewing(false)}>Back to details</button></section> : body}</div>
      {step === 'details' && profile?.active && !loading && filesUrl && <footer className="dialog-foot">
        <span className="save-state" role="status">{message ? <span role="alert">{message}</span> : blocked ?? saveLabel}</span>
        <button type="button" className="secondary" onClick={async () => { dirty.current = dirty.current || !model; if (model || modelFile?.asset) await queueSave(); onClose(); }}>Save draft</button>
        <button type="button" disabled={snapshotLabel && !reviewing ? !fileReady || coverBusy || !!problem || publishing || !hasChanges : !canPublish} onClick={() => { if (!snapshotLabel || reviewing) void publish(); else { setRights(false); setReviewing(true); } }}>{publishing ? 'Publishing…' : snapshotLabel && !reviewing ? 'Review publication' : model?.published ? 'Publish changes' : 'Publish model'}</button>
      </footer>}
      <input ref={fileInput} type="file" hidden accept={ACCEPT} aria-label="Choose a model file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; chooseModel(file); }}/>
      <input ref={coverInput} type="file" hidden accept="image/png,image/jpeg,.png,.jpg,.jpeg" aria-label="Choose a cover photo" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; chooseCover(file); }}/>
    </div>
  </div>;
}

/** A first-time contributor creates a public profile before publishing. */
function ProfileStep({ account, profile, onReady }: { account: CommonsAccount; profile: CommonsProfile | null; onReady(profile: CommonsProfile): void }): JSX.Element {
  const fieldId = useId();
  const [handle, setHandle] = useState(profile?.handle ?? '');
  const [name, setName] = useState(profile?.displayName ?? '');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [handleError, setHandleError] = useState('');
  const submit = async () => {
    const parsed = commonsHandleSchema.safeParse(handle);
    if (!parsed.success) { setHandleError(parsed.error.issues[0]?.message ?? 'Check your public handle.'); return; }
    setHandleError('');
    if (!name.trim()) { setError('Enter a display name.'); return; }
    setBusy(true); setError('');
    try {
      onReady(await account.profiles.save({ handle, displayName: name, bio: profile?.bio ?? '', avatarUrl: profile?.avatarUrl ?? null, links: profile?.links ?? [] }, profile?.version ?? null, true));
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Your public profile could not be saved.'); }
    finally { setBusy(false); }
  };
  return <form className="profile-step" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <p>Models are published under your public profile. Choose how you appear; your account details stay private.</p>
    <label htmlFor={`${fieldId}-handle`}>Public handle</label>
    <input id={`${fieldId}-handle`} value={handle} onChange={(event) => { setHandle(event.target.value.toLowerCase()); setHandleError(''); setError(''); }} disabled={busy || !!profile} required minLength={3} maxLength={32} autoCapitalize="none" spellCheck={false} aria-describedby={`${fieldId}-hint${handleError ? ` ${fieldId}-error` : ''}`} aria-invalid={!!handleError}/>
    <p id={`${fieldId}-hint`} className="profile-hint">3–32 lowercase letters, numbers or hyphens. Start with a letter, end with a letter or number. No @ needed.</p>
    {handleError && <p id={`${fieldId}-error`} className="profile-error" role="alert">{handleError}</p>}
    <label htmlFor={`${fieldId}-name`}>Display name</label>
    <input id={`${fieldId}-name`} value={name} onChange={(event) => { setName(event.target.value); setError(''); }} disabled={busy} required maxLength={100}/>
    {error && <p className="profile-error" role="alert">{error}</p>}
    <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Continue'}</button>
  </form>;
}
