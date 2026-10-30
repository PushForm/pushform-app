// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Identity of the running build, supplied by the host: the web app embeds it at build time
 * (apps/web/vite.config.ts) and passes it to `App`. Shown by the About dialog.
 */
export interface BuildInfo {
  /** Product version `<yr>.<week>.<increment>`. */
  readonly version: string;
  /** Build identifier: the short git commit of the built source, `-dirty` when uncommitted. */
  readonly commit: string;
  /** When the bundle was built, as an ISO 8601 timestamp; empty when unknown. */
  readonly date: string;
}

/** What a host that supplies no build identity reports. */
export const UNKNOWN_BUILD: BuildInfo = { version: 'unknown', commit: 'unknown', date: '' };

/** `YYYY-MM-DD HH:MM UTC` for a parseable timestamp; the text itself otherwise, `unknown` when empty. */
export function formatBuildDate(date: string): string {
  if (!date) return 'unknown';
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
