// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState } from 'react';
import type { JSX, KeyboardEvent, ReactNode } from 'react';
import { parseLength, type TagId } from '@pushform/core';
import type { DocumentState, EntityRef, Material } from '@pushform/model';
import { useApp } from '../AppContext';
import { useAppStore } from '../store';
import { formatArea, formatLength, formatVolume, rgbToCss } from '../engine/format';
import { useSelectionRefs } from '../hooks/useSelection';
import { describeSelection } from './entityInfo';
import type { EntityInfo, InstanceInfo } from './entityInfo';

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="pf-ei-row">
      <span className="pf-ei-label">{label}</span>
      <span className="pf-ei-value">{children}</span>
    </div>
  );
}

/** Material swatch; with `onApply` it is a button that paints the face side with the active material (Materials panel). */
function Swatch({ material, label, onApply }: { material: Material | null; label?: string; onApply?: (() => void) | undefined }): JSX.Element {
  const css = material ? rgbToCss(material.color) : '#ffffff';
  const name = material ? material.name : 'Default';
  const inner = (
    <>
      <span className="pf-swatch" style={{ background: css, opacity: material?.alpha ?? 1 }} aria-hidden="true" />
      <span className={material ? undefined : 'pf-ei-muted'}>{name}</span>
    </>
  );
  if (onApply) {
    return (
      <button type="button" className="pf-swatch-btn" title={`${name} — click to apply the active material`} aria-label={label ?? name} onClick={onApply}>
        {inner}
      </button>
    );
  }
  return (
    <span className="pf-swatch-wrap" title={name}>
      {inner}
    </span>
  );
}

/** The selection's tag; choosing one assigns it to everything selected. A mixed selection shows a blank. */
function TagSelect({ state, tagId, refs }: { state: DocumentState; tagId: TagId | null; refs: readonly EntityRef[] }): JSX.Element {
  const app = useApp();
  const value = tagId === null ? '' : String(tagId);
  return (
    <select className="pf-ei-select" value={value} aria-label="Tag"
      onChange={(e) => { if (e.target.value !== '') app.commands.tryExecute('tag.assign', { refs, tagId: Number(e.target.value) }); }}>
      {tagId === null ? <option value="">—</option> : null}
      {[...state.tags.values()].map((t) => (
        <option key={t.id} value={String(t.id)}>
          {t.name}
        </option>
      ))}
    </select>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean | null; onChange?: ((v: boolean) => void) | undefined }): JSX.Element {
  return (
    <label className="pf-ei-check">
      <input
        type="checkbox"
        disabled={!onChange}
        checked={checked === true}
        readOnly={!onChange}
        onChange={onChange ? (e) => onChange(e.target.checked) : undefined}
        ref={(el) => {
          if (el) el.indeterminate = checked === null;
        }}
      />
      {label}
    </label>
  );
}

/** Text field that commits on Enter / blur when changed and reverts on Esc. */
function EditableText({ value, label, placeholder, onCommit }: { value: string; label: string; placeholder?: string; onCommit: (v: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') setDraft(value);
    e.stopPropagation();
  };
  return (
    <input
      className="pf-ei-input is-editable"
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  );
}

/**
 * A value typed as text (a length in any unit, or a whole number): shown formatted, committed on Enter or blur when it
 * parses and changed, and restored on Esc or when it does not parse.
 */
function MeasureInput({ value, label, parse, onCommit }: { value: string; label: string; parse: (text: string) => number | null; onCommit: (v: number) => void }): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() === value) return;
    const parsed = parse(draft);
    if (parsed === null) setDraft(value);
    else onCommit(parsed);
  };
  return (
    <input
      className="pf-ei-input is-editable"
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
        else if (e.key === 'Escape') setDraft(value);
        e.stopPropagation();
      }}
    />
  );
}

/** Cast Shadows and Receive Shadows for solids, groups and components. */
function ShadowChecks({ refs, cast, receive }: { refs: readonly EntityRef[]; cast: boolean; receive: boolean }): JSX.Element {
  const app = useApp();
  return (
    <>
      <Check label="Cast Shadows" checked={cast} onChange={(v) => app.commands.tryExecute('entity.setShadows', { refs, cast: v })} />
      <Check label="Receive Shadows" checked={receive} onChange={(v) => app.commands.tryExecute('entity.setShadows', { refs, receive: v })} />
    </>
  );
}

function InstanceFields({ state, info }: { state: DocumentState; info: InstanceInfo }): JSX.Element {
  const app = useApp();
  const units = state.meta.units;
  const run = (id: string, params: unknown) => app.commands.tryExecute(id, params);
  return (
    <>
      {!info.isGroup ? (
        <Row label="Definition">
          <EditableText
            value={info.definitionName}
            label="Definition name"
            onCommit={(name) => run('definition.rename', { definitionId: info.definitionId, name })}
          />
        </Row>
      ) : null}
      <Row label="Instance">
        <EditableText value={info.instanceName} label="Instance name" placeholder={info.definitionName} onCommit={(name) => run('instance.rename', { ref: info.ref, name })} />
      </Row>
      <Row label="Instances">{`${info.count} in model`}</Row>
      <Row label="Tag">
        <TagSelect state={state} tagId={info.tagId} refs={[info.ref]} />
      </Row>
      {info.volume !== null ? <Row label="Volume">{formatVolume(info.volume, units)}</Row> : null}
      <div className="pf-ei-checks">
        <Check label="Hidden" checked={info.hidden} onChange={(hidden) => run('instance.setHidden', { refs: [info.ref], hidden })} />
        <Check label="Locked" checked={info.locked} onChange={(locked) => run('instance.setLocked', { refs: [info.ref], locked })} />
        <ShadowChecks refs={[info.ref]} cast={info.castShadows} receive={info.receiveShadows} />
      </div>
    </>
  );
}

/** Ref kinds `geometry.setHidden` hides and unhides. */
const GEOMETRY_KINDS: ReadonlySet<EntityRef['kind']> = new Set(['edge', 'imprintEdge', 'sketchEdge', 'face', 'sketchFace']);

function Fields({ state, info, refs }: { state: DocumentState; info: EntityInfo; refs: readonly EntityRef[] }): JSX.Element | null {
  const app = useApp();
  const activeMaterialId = useAppStore((s) => s.activeMaterialId);
  const units = state.meta.units;
  // One face, or one smooth surface (paint.apply paints all of it from any of its faces).
  const faceRef = info.kind === 'face' && refs[0] && (refs[0].kind === 'face' || refs[0].kind === 'sketchFace') ? refs[0] : null;
  const paint = (side: 'front' | 'back') => {
    if (!faceRef) return;
    app.commands.tryExecute('paint.apply', { refs: [faceRef], materialId: activeMaterialId, mode: 'single', side });
  };
  /** Hidden for the selected edges and faces, as one undoable step. */
  const setHidden = (hidden: boolean) => app.commands.tryExecute('geometry.setHidden', { refs, hidden });
  const run = (id: string, params: unknown) => app.commands.tryExecute(id, params);
  const length = (text: string): number | null => { const m = parseLength(text, units.lengthUnit); return m !== null && m > 0 ? m : null; };
  switch (info.kind) {
    case 'empty':
      return <p className="pf-ei-muted">Select an entity to see its properties.</p>;
    case 'instance':
      return <InstanceFields state={state} info={info} />;
    case 'edge': {
      const edge = refs[0]!;
      // Sketch edges and solid (or imprint) edges keep their flags through different commands.
      const setFlag = (flag: 'soft' | 'smooth', value: boolean) => edge.kind === 'sketchEdge'
        ? run('sketch.setEdgeFlags', { ids: [edge.id], [flag]: value })
        : run('edges.setFlags', { refs: [edge], [flag]: value });
      const curve = info.curve;
      return (
        <>
          <Row label="Tag">
            <TagSelect state={state} tagId={info.tagId} refs={refs} />
          </Row>
          <Row label="Length">
            {info.lengthEditable
              ? <MeasureInput value={formatLength(info.length, units)} label="Length" parse={length}
                onCommit={(meters) => run('sketch.setEdgeLength', { id: edge.id, length: meters })} />
              : <input className="pf-ei-input" value={formatLength(info.length, units)} readOnly aria-label="Length" />}
          </Row>
          {curve ? (
            <>
              <Row label="Radius">
                <MeasureInput value={formatLength(curve.radius, units)} label="Radius" parse={length}
                  onCommit={(radius) => run('sketch.setCurveRadius', { curveId: curve.id, radius })} />
              </Row>
              <Row label="Segments">
                <MeasureInput value={String(curve.segments)} label="Segments"
                  parse={(text) => { const n = Number(text.trim()); return Number.isInteger(n) && n >= (curve.kind === 'arc' ? 1 : 3) && n <= 999 ? n : null; }}
                  onCommit={(segments) => run('sketch.setCurveSegments', { curveId: curve.id, segments })} />
              </Row>
            </>
          ) : null}
          <div className="pf-ei-checks">
            <Check label="Soft" checked={info.soft} onChange={(v) => setFlag('soft', v)} />
            <Check label="Smooth" checked={info.smooth} onChange={(v) => setFlag('smooth', v)} />
            <Check label="Hidden" checked={info.hidden} onChange={setHidden} />
          </div>
        </>
      );
    }
    case 'face':
      return (
        <>
          <Row label="Tag">
            <TagSelect state={state} tagId={info.tagId} refs={refs} />
          </Row>
          <Row label="Area">{formatArea(info.area, units)}</Row>
          <Row label="Front">
            <Swatch material={info.front} label="Front material" onApply={faceRef ? () => paint('front') : undefined} />
          </Row>
          <Row label="Back">
            <Swatch material={info.back} label="Back material" onApply={faceRef ? () => paint('back') : undefined} />
          </Row>
          <div className="pf-ei-checks">
            <Check label="Hidden" checked={info.hidden} onChange={setHidden} />
          </div>
        </>
      );
    case 'body':
      return (
        <>
          <Row label="Tag">
            <TagSelect state={state} tagId={info.tagId} refs={refs} />
          </Row>
          {info.volume !== null ? <Row label="Volume">{formatVolume(info.volume, units)}</Row> : null}
          <Row label="Faces">{info.faceCount}</Row>
          <Row label="Edges">{info.edgeCount}</Row>
          <div className="pf-ei-checks">
            <Check label="Hidden" checked={info.hidden} onChange={(hidden) => run('bodies.setHidden', { refs, hidden })} />
            <ShadowChecks refs={refs} cast={info.castShadows} receive={info.receiveShadows} />
          </div>
        </>
      );
    case 'meshPart':
      return (
        <>
          <Row label="Name">{info.name}</Row>
          <Row label="Source">{info.system ? `${info.format} · ${info.system}` : info.format}</Row>
          <Row label="Tag">
            <TagSelect state={state} tagId={info.tagId} refs={refs} />
          </Row>
          <Row label="Triangles">{info.triangleCount}</Row>
          <Row label="Faces">{info.faceCount}</Row>
          <Row label="Edges">{info.edgeCount}</Row>
          <Row label="Placements">{info.placements}</Row>
          <div className="pf-ei-checks">
            <Check label="Hidden" checked={info.hidden} onChange={(hidden) => run('bodies.setHidden', { refs, hidden })} />
            <ShadowChecks refs={refs} cast={info.castShadows} receive={info.receiveShadows} />
          </div>
        </>
      );
    case 'vertex':
      return (
        <>
          <Row label="X">{formatLength(info.position[0], units)}</Row>
          <Row label="Y">{formatLength(info.position[1], units)}</Row>
          <Row label="Z">{formatLength(info.position[2], units)}</Row>
        </>
      );
    case 'sectionPlane': {
      const plane = { path: [...info.ref.path], id: info.ref.id };
      return (
        <>
          <Row label="Name">
            <EditableText value={info.name} label="Section plane name" onCommit={(name) => { if (name) app.commands.tryExecute('sectionPlane.rename', { ...plane, name }); }} />
          </Row>
          <Row label="Symbol">
            <EditableText value={info.symbol} label="Section plane symbol" onCommit={(symbol) => { if (symbol) app.commands.tryExecute('sectionPlane.rename', { ...plane, symbol: symbol.slice(0, 3) }); }} />
          </Row>
          <Row label="Tag">
            <TagSelect state={state} tagId={info.tagId} refs={[info.ref]} />
          </Row>
          <div className="pf-ei-checks">
            <Check label="Active Cut" checked={info.active} onChange={(active) => app.commands.tryExecute('sectionPlane.setActive', { ...plane, active })} />
            <Check label="Hidden" checked={info.hidden} onChange={(hidden) => app.commands.tryExecute('sectionPlane.setHidden', { refs: [plane], hidden })} />
          </div>
        </>
      );
    }
    case 'image': {
      const ref = { kind: 'image', path: [...info.ref.path], id: info.ref.id };
      return (
        <>
          <Row label="Name">{info.name}</Row>
          <Row label="Width">{formatLength(info.width, units)}</Row>
          <Row label="Height">{formatLength(info.height, units)}</Row>
          {info.pixels ? <Row label="Pixels">{`${info.pixels[0]} × ${info.pixels[1]}`}</Row> : null}
          <Row label="Tag">
            <TagSelect state={state} tagId={info.tagId} refs={refs} />
          </Row>
          <button type="button" className="pf-ei-action" onClick={() => app.commands.tryExecute('image.useAsMaterial', { refs: [ref] })}>Use as Material</button>
        </>
      );
    }
    case 'dimension': {
      const ref = { kind: 'dimension', path: [...info.ref.path], id: info.ref.id };
      return (
        <>
          <Row label="Text">
            <EditableText value={info.text} label="Dimension text" placeholder={info.measured}
              onCommit={(text) => { if (text !== info.text) app.commands.tryExecute('dimension.edit', { ref, text }); }} />
          </Row>
          {info.type !== 'linear' ? (
            <Row label="Type">
              <select className="pf-ei-select" aria-label="Dimension type" value={info.type}
                onChange={(e) => app.commands.tryExecute('dimension.edit', { ref, type: e.target.value })}>
                <option value="radial">Radius</option>
                <option value="diametric">Diameter</option>
              </select>
            </Row>
          ) : null}
          <Row label="Tag">
            <TagSelect state={state} tagId={info.tagId} refs={refs} />
          </Row>
        </>
      );
    }
    case 'other':
      return (
        <Row label="Tag">
          <TagSelect state={state} tagId={info.tagId} refs={refs} />
        </Row>
      );
    case 'multi':
      return (
        <>
          <Row label="Tag">
            <TagSelect state={state} tagId={info.tagId} refs={refs} />
          </Row>
          <div className="pf-ei-checks">
            <Check label="Hidden" checked={info.hidden} onChange={refs.every((r) => GEOMETRY_KINDS.has(r.kind)) ? setHidden : undefined} />
          </div>
        </>
      );
  }
}

/** Entity Info: header with type + count, tag, hidden, per-type measurements; groups/components get names, counts, lock. */
export function EntityInfoPanel(): JSX.Element {
  const app = useApp();
  const refs = useSelectionRefs();
  const state = app.document.doc.state;
  const info = describeSelection(state, refs);
  return (
    <div className="pf-entity-info">
      <h3 className="pf-ei-title">{info.title}</h3>
      <Fields state={state} info={info} refs={refs} />
    </div>
  );
}
