// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useId } from 'react';
import { GOOGLE_LAYOUT_FONTS, SYSTEM_LAYOUT_FONTS } from './layoutFontCatalog';

export function LayoutFontOptions({ value }: { value: string }) {
  const known = SYSTEM_LAYOUT_FONTS.includes(value) || GOOGLE_LAYOUT_FONTS.some(font => font.family === value);
  return <>
    {!known ? <option>{value}</option> : null}
    <optgroup label="System fonts">{SYSTEM_LAYOUT_FONTS.map(font => <option key={font}>{font}</option>)}</optgroup>
    {['Sans Serif', 'Serif', 'Monospace', 'Display', 'Handwriting'].map(category =>
      <optgroup key={category} label={`Google Fonts · ${category}`}>
        {GOOGLE_LAYOUT_FONTS.filter(font => font.category === category).map(font => <option key={font.family}>{font.family}</option>)}
      </optgroup>)}
  </>;
}

/** Keep custom and locally installed font names available alongside catalog suggestions. */
export function LayoutFontInput({ value, onChange }: { value: string; onChange: (family: string) => void }) {
  const list = useId();
  return <><input list={list} value={value} onChange={event => { if (event.target.value.trim()) onChange(event.target.value); }} />
    <datalist id={list}><LayoutFontOptions value={value} /></datalist></>;
}
