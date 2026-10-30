// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { formatLength, parseLength, typedLengthUnit } from '@pushform/core';
import type { LengthFormat, LengthUnit, UnitSettings } from '@pushform/core';
import type { PurgeUnusedResult, UnitsPatch } from '@pushform/commands';
import { dimensionStyleOf, entityCounts } from '@pushform/model';
import type { DimensionAlign, DimensionArrow, EntityCounts } from '@pushform/model';
import { useApp } from '../AppContext';
import { useDocumentState } from '../hooks/useDocument';
import { useSelectionRefs } from '../hooks/useSelection';

/** Model Info: the model's display units, dimension settings, statistics and Purge Unused. */

const FORMATS: readonly [LengthFormat, string][] = [['architectural', 'Architectural'], ['decimal', 'Decimal'], ['engineering', 'Engineering'], ['fractional', 'Fractional']];
const LENGTH_UNITS: readonly [LengthUnit, string][] = [['in', 'Inches'], ['ft', 'Feet'], ['yd', 'Yards'], ['mm', 'Millimeters'], ['cm', 'Centimeters'], ['m', 'Meters']];
const AREA_UNITS: readonly UnitSettings['areaUnit'][] = ['in²', 'ft²', 'yd²', 'mm²', 'cm²', 'm²'];
const VOLUME_UNITS: readonly UnitSettings['volumeUnit'][] = ['in³', 'ft³', 'yd³', 'mm³', 'cm³', 'm³', 'l'];
const ANGLE_SNAPS: readonly number[] = [0.1, 0.5, 1, 5, 10, 15, 30, 45, 90];
/** The snap length length snapping starts from when it has none: 1/16", as reads a stored zero. */
const DEFAULT_SNAP = 0.0254 / 16;

const decimals = (n: number): string => (n ? `0.${'0'.repeat(n)}` : '0');
/** A length precision: decimals, or the smallest fraction of an inch. */
const lengthPrecisionLabel = (units: UnitSettings, n: number): string =>
  units.format === 'architectural' || units.format === 'fractional' ? (n ? `1/${2 ** n}"` : '1"') : decimals(n);

const PANES = { units: 'Units', dimensions: 'Dimensions', statistics: 'Statistics' } as const;
type Pane = keyof typeof PANES;

/** Model Info panel: Units, Dimensions and Statistics panes. */
export function ModelInfoPanel(): JSX.Element {
  const [pane, setPane] = useState<Pane>('units');
  return (
    <div className="pf-form pf-model-info">
      <div className="pf-tabs" role="tablist" aria-label="Model Info">
        {(Object.keys(PANES) as Pane[]).map((p) => (
          <button key={p} type="button" role="tab" className={`pf-tab${pane === p ? ' is-active' : ''}`} aria-selected={pane === p} onClick={() => setPane(p)}>
            {PANES[p]}
          </button>
        ))}
      </div>
      {pane === 'units' ? <UnitsPane /> : pane === 'dimensions' ? <DimensionsPane /> : <StatisticsPane />}
    </div>
  );
}

const ALIGNMENTS: readonly [DimensionAlign, string][] = [['screen', 'Align to screen'], ['above', 'Above the line'], ['centered', 'Centered on the line'], ['outside', 'Outside the line']];
const ENDPOINTS: readonly [DimensionArrow, string][] = [['none', 'None'], ['slash', 'Slash'], ['dot', 'Dot'], ['closed', 'Closed arrow'], ['open', 'Open arrow']];
const FONT_SIZES: readonly number[] = [6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];

/**
 * Model Info › Dimensions: the text size, text alignment and endpoints new dimensions get, and Update Selected
 * Dimensions, which gives them to the selected dimensions.
 */
function DimensionsPane(): JSX.Element {
  const app = useApp();
  const style = dimensionStyleOf(useDocumentState());
  const selected = useSelectionRefs().filter((r) => r.kind === 'dimension').length;
  const [status, setStatus] = useState('');
  const set = (patch: Record<string, unknown>) => app.commands.tryExecute('model.setDimensionStyle', patch);
  const sizes = FONT_SIZES.includes(style.fontSizePt) ? FONT_SIZES : [...FONT_SIZES, style.fontSizePt].sort((a, b) => a - b);
  const update = (): void => {
    const r = app.commands.tryExecute('dimension.setStyle', {});
    setStatus(r.ok ? `Updated ${r.result as number} dimension${r.result === 1 ? '' : 's'}.` : 'Select dimensions to update.');
  };
  return (
    <>
      <div className="pf-form-section">Text</div>
      <div className="pf-form-row">
        <span className="pf-form-label">Size</span>
        <select className="pf-form-select" aria-label="Dimension text size" value={style.fontSizePt} onChange={(e) => set({ fontSizePt: Number(e.target.value) })}>
          {sizes.map((n) => <option key={n} value={n}>{`${n} pt`}</option>)}
        </select>
      </div>
      <div className="pf-form-row">
        <span className="pf-form-label">Alignment</span>
        <select className="pf-form-select" aria-label="Dimension text alignment" value={style.align} onChange={(e) => set({ align: e.target.value })}>
          {ALIGNMENTS.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
        </select>
      </div>
      <div className="pf-form-section">Leader lines</div>
      <div className="pf-form-row">
        <span className="pf-form-label">Endpoints</span>
        <select className="pf-form-select" aria-label="Dimension endpoints" value={style.arrow} onChange={(e) => set({ arrow: e.target.value })}>
          {ENDPOINTS.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
        </select>
      </div>
      <p className="pf-form-note">New dimensions use these settings.</p>
      <div className="pf-form-actions">
        <button type="button" className="pf-btn" disabled={selected === 0} onClick={update}>Update Selected Dimensions</button>
      </div>
      <p className="pf-form-note" role="status">{status}</p>
    </>
  );
}

function UnitsPane(): JSX.Element {
  const app = useApp();
  const units = useDocumentState().meta.units;
  const set = (patch: UnitsPatch) => app.commands.tryExecute('model.setUnits', { patch });
  const fixedUnit = units.format !== 'decimal';
  const select = (label: string, value: string | number, options: readonly (readonly [string | number, string])[], onChange: (value: string) => void, disabled = false) => (
    <div className="pf-form-row">
      <span className="pf-form-label">{label}</span>
      <select className="pf-form-select" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </div>
  );
  const range = (max: number) => Array.from({ length: max + 1 }, (_, n) => n);
  const angleSnaps = units.angleSnap !== null && !ANGLE_SNAPS.includes(units.angleSnap) ? [...ANGLE_SNAPS, units.angleSnap].sort((a, b) => a - b) : ANGLE_SNAPS;
  return (
    <>
      <div className="pf-form-section">Length units</div>
      {select('Format', units.format, FORMATS, (v) => set({ format: v as LengthFormat }))}
      {select('Length', units.lengthUnit, LENGTH_UNITS, (v) => set({ lengthUnit: v as LengthUnit }), fixedUnit)}
      {select('Precision', units.lengthPrecision, range(6).map((n) => [n, lengthPrecisionLabel(units, n)] as const), (v) => set({ lengthPrecision: Number(v) }))}
      <SnapLength units={units} onChange={(lengthSnap) => set({ lengthSnap })} />
      <label className="pf-form-check">
        <input type="checkbox" checked={units.displayUnitSuffix} onChange={(e) => set({ displayUnitSuffix: e.target.checked })} />
        Display units format
      </label>
      <label className="pf-form-check">
        <input type="checkbox" checked={units.forceZeroInches} disabled={units.format !== 'architectural'} onChange={(e) => set({ forceZeroInches: e.target.checked })} />
        Force display of 0"
      </label>
      <div className="pf-form-section">Area and volume</div>
      {select('Area', units.areaUnit, AREA_UNITS.map((u) => [u, u] as const), (v) => set({ areaUnit: v as UnitSettings['areaUnit'] }))}
      {select('Area precision', units.areaPrecision, range(6).map((n) => [n, decimals(n)] as const), (v) => set({ areaPrecision: Number(v) }))}
      {select('Volume', units.volumeUnit, VOLUME_UNITS.map((u) => [u, u === 'l' ? 'Liters' : u] as const), (v) => set({ volumeUnit: v as UnitSettings['volumeUnit'] }))}
      {select('Volume precision', units.volumePrecision, range(6).map((n) => [n, decimals(n)] as const), (v) => set({ volumePrecision: Number(v) }))}
      <div className="pf-form-section">Angle units</div>
      {select('Angle precision', units.anglePrecision, range(3).map((n) => [n, decimals(n)] as const), (v) => set({ anglePrecision: Number(v) }))}
      <label className="pf-form-check">
        <input type="checkbox" checked={units.angleSnap !== null} onChange={(e) => set({ angleSnap: e.target.checked ? 15 : null })} />
        Enable angle snapping
      </label>
      {select('Snap angle', units.angleSnap ?? 15, angleSnaps.map((a) => [a, `${a}°`] as const), (v) => set({ angleSnap: Number(v) }), units.angleSnap === null)}
    </>
  );
}

/** Length snapping: a checkbox and the snap length, typed in the model's units. */
function SnapLength({ units, onChange }: { units: UnitSettings; onChange: (meters: number | null) => void }): JSX.Element {
  const shown = formatLength(units.lengthSnap ?? DEFAULT_SNAP, units);
  const [text, setText] = useState(shown);
  const [error, setError] = useState(false);
  useEffect(() => { setText(shown); setError(false); }, [shown]);
  const commit = (): void => {
    const meters = parseLength(text, typedLengthUnit(units));
    if (meters === null || meters <= 0) { setError(true); return; }
    setError(false);
    if (meters !== units.lengthSnap) onChange(meters);
    else setText(shown);
  };
  return (
    <>
      <label className="pf-form-check">
        <input type="checkbox" checked={units.lengthSnap !== null} onChange={(e) => onChange(e.target.checked ? parseLength(text, typedLengthUnit(units)) ?? DEFAULT_SNAP : null)} />
        Enable length snapping
      </label>
      <div className="pf-form-row">
        <span className="pf-form-label">Snap length</span>
        <input className={`pf-form-input${error ? ' is-error' : ''}`} aria-label="Snap length" aria-invalid={error} value={text} disabled={units.lengthSnap === null}
          onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setText(shown); e.stopPropagation(); }} />
      </div>
    </>
  );
}

const STATISTICS: readonly [keyof EntityCounts, string][] = [
  ['solids', 'Solids'], ['solidFaces', 'Solid faces'], ['sheetFaces', 'Sheet faces'], ['edges', 'Edges'], ['groups', 'Groups'],
  ['componentInstances', 'Component instances'], ['guides', 'Guides'], ['dimensions', 'Dimensions'], ['texts', 'Texts'], ['images', 'Images'],
  ['sectionPlanes', 'Section planes'], ['componentDefinitions', 'Component definitions'], ['materials', 'Materials'], ['tags', 'Tags'],
  ['styles', 'Styles'], ['scenes', 'Scenes'],
];
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What Purge Unused removed, for the status line. */
export function purgeSummary(r: PurgeUnusedResult): string {
  const parts = [
    r.definitions ? plural(r.definitions, 'group or component definition', 'group and component definitions') : '',
    r.styles ? plural(r.styles, 'style') : '', r.tags ? plural(r.tags, 'tag or folder', 'tags and folders') : '',
    r.materials ? plural(r.materials, 'material') : '', r.images ? plural(r.images, 'image') : '',
  ].filter(Boolean);
  return parts.length ? `Purged ${parts.join(', ')}.` : 'Nothing to purge.';
}

function StatisticsPane(): JSX.Element {
  const app = useApp();
  const state = useDocumentState();
  const [nested, setNested] = useState(false);
  const [status, setStatus] = useState('');
  const counts = useMemo(() => entityCounts(state, nested), [state, nested]);
  const purge = (): void => {
    const r = app.commands.tryExecute('model.purgeUnused', {});
    setStatus(r.ok ? purgeSummary(r.result as PurgeUnusedResult) : 'Purge failed.');
  };
  return (
    <>
      <label className="pf-form-check">
        <input type="checkbox" checked={nested} onChange={(e) => setNested(e.target.checked)} />
        Show nested components
      </label>
      <table className="pf-model-stats" aria-label="Statistics">
        <tbody>
          {STATISTICS.map(([key, label]) => (
            <tr key={key}><th scope="row">{label}</th><td>{counts[key]}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="pf-form-actions">
        <button type="button" className="pf-btn" onClick={purge}>Purge Unused</button>
      </div>
      <p className="pf-form-note" role="status">{status}</p>
    </>
  );
}
