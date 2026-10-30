// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { componentAxesPick, type PickedAxes } from '@pushform/commands';
import { instanceAt } from '@pushform/model';
import type { ComponentBehaviors, DocumentState, EntityRef } from '@pushform/model';
import { useApp } from '../AppContext';
import { installUiCommands } from '../engine/uiCommands';
import { noticeFromError } from '../hooks/useCommandNotices';
import { useAppStore } from '../store';
import { TextEditor } from './TextEditor';
import { Check, Dialog, Field } from './DialogParts';
import { Text3DDialog } from './Text3DDialog';

export type GlueTo = ComponentBehaviors['glueTo'];
const GLUE_OPTIONS: readonly { value: GlueTo; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'any', label: 'Any' },
  { value: 'horizontal', label: 'Horizontal' },
  { value: 'vertical', label: 'Vertical' },
  { value: 'sloped', label: 'Sloped' },
];

/** Params of `component.make` (agent A's command) as the dialog submits them. */
export interface MakeComponentParams {
  readonly name: string;
  readonly description: string;
  readonly glueTo: GlueTo;
  readonly cutOpening: boolean;
  readonly alwaysFaceCamera: boolean;
  readonly shadowsFaceSun: boolean;
  readonly replaceSelection: boolean;
  /** Picked component axes, world. */
  readonly axesOrigin?: readonly [number, number, number] | undefined;
  readonly axesX?: readonly [number, number, number] | undefined;
  readonly axesY?: readonly [number, number, number] | undefined;
  readonly axesZ?: readonly [number, number, number] | undefined;
}

const PICK_INSTRUCTION = 'Pick the component axes.';

/** Next free "Component#N" (N = component definitions so far + 1; the root and groups do not count). */
export function defaultComponentName(state: DocumentState): string {
  let n = 0;
  for (const d of state.definitions.values()) if (!d.isGroup && d.id !== state.rootDefinitionId) n++;
  return `Component#${n + 1}`;
}

/**
 * Make Component: Name, Description, Glue to, Cut opening, Always face camera, Shadows face sun, Set
 * Component Axes, Replace selection. Set Component Axes hides the dialog, keeping its entries, while the component
 * axes tool picks the axes.
 */
export function MakeComponentDialog({ onClose }: { onClose: () => void }): JSX.Element | null {
  const app = useApp();
  const state = app.document.doc.state;
  const [name, setName] = useState(() => defaultComponentName(state));
  const [description, setDescription] = useState('');
  const [glueTo, setGlueTo] = useState<GlueTo>('none');
  const [cutOpening, setCutOpening] = useState(false);
  const [alwaysFaceCamera, setAlwaysFaceCamera] = useState(false);
  const [shadowsFaceSun, setShadowsFaceSun] = useState(false);
  const [replaceSelection, setReplaceSelection] = useState(true);
  const [axes, setAxes] = useState<PickedAxes | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // a pick still pending when the dialog goes away answers nobody
  useEffect(() => () => {
    if (componentAxesPick.request?.instruction === PICK_INSTRUCTION) componentAxesPick.request = null;
  }, []);

  const pickAxes = () => {
    componentAxesPick.request = {
      instruction: PICK_INSTRUCTION,
      onPicked: (picked) => {
        setAxes(picked);
        setPicking(false);
      },
      onCancel: () => setPicking(false),
    };
    setPicking(true);
    app.commands.execute('tool.activate', { id: 'componentAxes' });
  };
  // Always face camera brings Shadows face sun with it
  const setFaceCamera = (on: boolean) => {
    setAlwaysFaceCamera(on);
    setShadowsFaceSun(on);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const params: MakeComponentParams = {
      name: name.trim() || 'Component',
      description,
      glueTo,
      cutOpening,
      alwaysFaceCamera,
      shadowsFaceSun: alwaysFaceCamera && shadowsFaceSun,
      replaceSelection,
      ...(axes ? { axesOrigin: axes.origin, axesX: axes.x, axesY: axes.y, axesZ: axes.z } : {}),
    };
    const res = app.commands.tryExecute('component.make', params);
    if (res.ok) onClose();
    else setError(noticeFromError(res.error));
  };

  if (picking) return null;
  return (
    <Dialog title="Create Component" onClose={onClose}>
      <form className="pf-dialog-form" onSubmit={submit}>
        <Field label="Name" htmlFor="pf-mc-name">
          <input id="pf-mc-name" className="pf-dialog-input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description" htmlFor="pf-mc-desc">
          <textarea id="pf-mc-desc" className="pf-dialog-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <fieldset className="pf-dialog-group">
          <legend>Alignment</legend>
          <Field label="Glue to" htmlFor="pf-mc-glue">
            <select id="pf-mc-glue" className="pf-dialog-input" value={glueTo} onChange={(e) => setGlueTo(e.target.value as GlueTo)}>
              {GLUE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="pf-dialog-checks">
            <Check id="pf-mc-cut" label="Cut opening" checked={cutOpening} onChange={setCutOpening} />
            <Check id="pf-mc-face" label="Always face camera" checked={alwaysFaceCamera} onChange={setFaceCamera} />
            <Check id="pf-mc-sun" label="Shadows face sun" checked={alwaysFaceCamera && shadowsFaceSun} onChange={setShadowsFaceSun} disabled={!alwaysFaceCamera} />
          </div>
          <div className="pf-dialog-row">
            <button type="button" className="pf-dialog-btn" onClick={pickAxes}>
              Set Component Axes
            </button>
            {axes ? <span className="pf-dialog-note">Custom axes set</span> : null}
          </div>
        </fieldset>
        <Check id="pf-mc-replace" label="Replace selection with component" checked={replaceSelection} onChange={setReplaceSelection} />
        {error ? (
          <p className="pf-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="pf-dialog-actions">
          <button type="button" className="pf-dialog-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="pf-dialog-btn is-primary">
            Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Rename a group/component instance (context menu "Rename…"): `instance.rename { ref, name }`. */
export function RenameInstanceDialog({ target, onClose }: { target: EntityRef; onClose: () => void }): JSX.Element {
  const app = useApp();
  const state = app.document.doc.state;
  const [name, setName] = useState(() => {
    try {
      const inst = target.kind === 'instance' ? instanceAt(state, [...target.path, target.id]) : null;
      return inst?.name ?? '';
    } catch {
      return '';
    }
  });
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const res = app.commands.tryExecute('instance.rename', { ref: target, name: name.trim() });
    if (res.ok) onClose();
    else setError(noticeFromError(res.error));
  };
  return (
    <Dialog title="Rename" onClose={onClose}>
      <form className="pf-dialog-form" onSubmit={submit}>
        <Field label="Name" htmlFor="pf-rn-name">
          <input id="pf-rn-name" className="pf-dialog-input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {error ? (
          <p className="pf-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="pf-dialog-actions">
          <button type="button" className="pf-dialog-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="pf-dialog-btn is-primary">
            OK
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Mounts whichever dialog `store.dialog` names. The integrator renders this once inside the app shell. */
export function DialogHost(): JSX.Element | null {
  const app = useApp();
  const dialog = useAppStore((s) => s.dialog);
  const dialogRef = useAppStore((s) => s.dialogRef);
  const close = useAppStore((s) => s.closeDialog);
  useEffect(() => installUiCommands(app.commands), [app]);
  if (dialog === 'makeComponent') return <MakeComponentDialog onClose={close} />;
  if (dialog === 'text3d') return <Text3DDialog onClose={close} />;
  if (dialog === 'renameInstance' && dialogRef) return <RenameInstanceDialog target={dialogRef} onClose={close} />;
  if (dialog === 'editText' && dialogRef) return <TextEditor target={dialogRef} onClose={close} />;
  return null;
}
