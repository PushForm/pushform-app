// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { clampDay, dayOfYear, monthDayOf } from '@pushform/commands';
import type { ShadowPatch } from '@pushform/commands';
import { useApp } from '../AppContext';
import { installUiServices } from '../engine/uiServices';
import { useDocumentState } from '../hooks/useDocument';

const UTC_OFFSETS: number[] = [];
for (let h = -12; h <= 14; h++) UTC_OFFSETS.push(h);

export function formatTime(minutes: number): string {
  const m = Math.max(0, Math.min(1439, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "HH:MM" (or "H:MM", "HHMM", "1:30 pm") → minutes since midnight, or null. */
export function parseTime(text: string): number | null {
  const m = /^\s*(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?\s*$/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatDate(month: number, day: number): string {
  return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
}

/** "MM/DD" → month/day, or null. */
export function parseDate(text: string): { month: number; day: number } | null {
  const m = /^\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*$/.exec(text);
  if (!m) return null;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return null;
  return { month, day: clampDay(month, Number(m[2])) };
}

const utcLabel = (h: number): string => `UTC${h >= 0 ? '+' : '−'}${String(Math.abs(h)).padStart(2, '0')}:00`;

/**
 * Shadows panel: Show Shadows, UTC offset, time slider + field, date slider +
 * field, Light / Dark, Use Sun for Shading and the Display On Faces / On Ground / From Edges
 * toggles. All edits go through `shadows.set`.
 */
export function ShadowsPanel(): JSX.Element {
  const app = useApp();
  const state = useDocumentState();
  useEffect(() => installUiServices(app.commands), [app]);
  const s = state.shadows;
  const [timeText, setTimeText] = useState<string | null>(null);
  const [dateText, setDateText] = useState<string | null>(null);
  const set = (patch: ShadowPatch) => app.commands.tryExecute('shadows.set', { patch });

  const commitTime = () => {
    if (timeText === null) return;
    const v = parseTime(timeText);
    if (v !== null) set({ time: v });
    setTimeText(null);
  };
  const commitDate = () => {
    if (dateText === null) return;
    const v = parseDate(dateText);
    if (v) set({ month: v.month, day: v.day });
    setDateText(null);
  };

  return (
    <div className="pf-form pf-shadows">
      <label className="pf-form-check">
        <input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Show Shadows
      </label>
      <div className="pf-form-row">
        <span className="pf-form-label">Time zone</span>
        <select className="pf-form-select" aria-label="UTC offset" value={s.utcOffsetHours} onChange={(e) => set({ utcOffsetHours: Number(e.target.value) })}>
          {UTC_OFFSETS.map((h) => (
            <option key={h} value={h}>
              {utcLabel(h)}
            </option>
          ))}
        </select>
      </div>
      <div className="pf-form-row">
        <span className="pf-form-label">Time</span>
        <div className="pf-form-range">
          <input type="range" aria-label="Time of day" min={0} max={1439} step={5} value={s.time} onChange={(e) => set({ time: Number(e.target.value) })} />
          <input
            className="pf-form-input"
            aria-label="Time (HH:MM)"
            value={timeText ?? formatTime(s.time)}
            onChange={(e) => setTimeText(e.target.value)}
            onBlur={commitTime}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTime();
              if (e.key === 'Escape') setTimeText(null);
            }}
          />
        </div>
      </div>
      <div className="pf-form-row">
        <span className="pf-form-label">Date</span>
        <div className="pf-form-range">
          <input
            type="range"
            aria-label="Day of year"
            min={1}
            max={366}
            value={dayOfYear(s.month, s.day)}
            onChange={(e) => {
              const md = monthDayOf(Number(e.target.value));
              set({ month: md.month, day: md.day });
            }}
          />
          <input
            className="pf-form-input"
            aria-label="Date (MM/DD)"
            value={dateText ?? formatDate(s.month, s.day)}
            onChange={(e) => setDateText(e.target.value)}
            onBlur={commitDate}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDate();
              if (e.key === 'Escape') setDateText(null);
            }}
          />
        </div>
      </div>
      <div className="pf-form-row">
        <span className="pf-form-label">Light</span>
        <div className="pf-form-range">
          <input type="range" aria-label="Light" min={0} max={100} value={s.light} onChange={(e) => set({ light: Number(e.target.value) })} />
          <span>{s.light}</span>
        </div>
      </div>
      <div className="pf-form-row">
        <span className="pf-form-label">Dark</span>
        <div className="pf-form-range">
          <input type="range" aria-label="Dark" min={0} max={100} value={s.dark} onChange={(e) => set({ dark: Number(e.target.value) })} />
          <span>{s.dark}</span>
        </div>
      </div>
      <label className="pf-form-check">
        <input type="checkbox" checked={s.useSunForShading} onChange={(e) => set({ useSunForShading: e.target.checked })} />
        Use sun for shading
      </label>
      <div className="pf-form-section">Display</div>
      <label className="pf-form-check">
        <input type="checkbox" checked={s.onFaces} onChange={(e) => set({ onFaces: e.target.checked })} />
        On faces
      </label>
      <label className="pf-form-check">
        <input type="checkbox" checked={s.onGround} onChange={(e) => set({ onGround: e.target.checked })} />
        On ground
      </label>
      <label className="pf-form-check">
        <input type="checkbox" checked={s.fromEdges} onChange={(e) => set({ fromEdges: e.target.checked })} />
        From edges
      </label>
      <p className="pf-form-note">
        Location {s.latitude.toFixed(3)}, {s.longitude.toFixed(3)} (north {s.northAngle}°). Set it with <code>shadows.setLocation</code>.
      </p>
    </div>
  );
}
