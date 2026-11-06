// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { containerAt } from '@pushform/model';
import type { EntityRef, TextEntity } from '@pushform/model';
import type { AppInstance } from '../bootstrap';
import { Icon } from './Icon';
import { LayoutFontOptions } from './LayoutFontPicker';

/** The model text `ref` names, or null when it is gone. */
export function modelTextAt(app: AppInstance, ref: EntityRef): TextEntity | null {
  if (ref.kind !== 'text') return null;
  try {
    return containerAt(app.document.doc.state, ref.path).texts.get(ref.id) ?? null;
  } catch {
    return null;
  }
}

const toHex = (c: readonly [number, number, number]): string =>
  `#${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (hex: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : null;
};

/**
 * The style row of a model text in the tool options bar: font, size, bold, italic and color, for the
 * text being edited or the one selected. Each change is one `text.setStyle` step.
 */
export function ModelTextStyleRow({ app, target }: { app: AppInstance; target: EntityRef }): JSX.Element | null {
  const text = modelTextAt(app, target);
  const [size, setSize] = useState(String(text?.fontSizePt ?? ''));
  useEffect(() => setSize(String(text?.fontSizePt ?? '')), [text?.fontSizePt]);
  if (!text) return null;
  const set = (patch: Record<string, unknown>) => app.commands.tryExecute('text.setStyle', { refs: [target], ...patch });
  return (
    <span className="pf-model-text-style" role="group" aria-label="Text style">
      <select aria-label="Text font" title="Font family" value={text.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })}>
        <LayoutFontOptions value={text.fontFamily} />
      </select>
      <label className="pf-model-text-size">
        <input
          aria-label="Text size"
          title="Font size in points"
          type="number"
          min="1"
          step="0.5"
          value={size}
          onChange={(e) => {
            setSize(e.target.value);
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= 1) set({ fontSizePt: v });
          }}
          onBlur={() => setSize(String(text.fontSizePt))}
        />
        pt
      </label>
      {(['bold', 'italic'] as const).map((key) => (
        <button
          key={key}
          type="button"
          aria-label={`Text ${key}`}
          title={key === 'bold' ? 'Bold' : 'Italic'}
          aria-pressed={Boolean(text[key])}
          // keep the text editor's focus while emphasis is toggled
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => set({ [key]: !text[key] })}
        >
          <Icon name={`text-${key}`} size={16} />
        </button>
      ))}
      <input
        className="pf-model-text-color"
        aria-label="Text color"
        title="Text color"
        type="color"
        value={toHex(text.color)}
        onChange={(e) => {
          const color = fromHex(e.target.value);
          if (color) set({ color });
        }}
      />
    </span>
  );
}
