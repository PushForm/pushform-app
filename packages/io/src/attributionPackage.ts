// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { parseModelAttributions, type DocumentState } from '@pushform/model';

/** Service packages store bytes without compression; rejecting other methods bounds expansion. */
export function readStoredAttributionPackage(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.length > 134217728 + 262144) throw new Error('Model package is too large.');
  let entries = 0;
  const files = unzipSync(bytes, { filter(entry) {
    if (++entries > 3 || entry.compression !== 0 || entry.originalSize > 134217728 || entry.name.startsWith('/') || entry.name.split('/').some(segment => segment === '..' || segment === '.') || entry.name.includes('\\')) throw new Error('Invalid model package.');
    return true;
  } });
  if (!files['ATTRIBUTION.json'] || files['ATTRIBUTION.json'].length > 65536 || !files['README.txt'] || files['README.txt'].length > 65536) throw new Error('Missing model notices.');
  return files;
}

/** Geometry formats lacking native notices travel with them in one portable ZIP. */
export function packageModelExport(state: DocumentState, bytes: Uint8Array, fileName: string): { bytes: Uint8Array; fileName: string; packaged: boolean } {
  const notices = state.meta.attributions;
  if (!notices?.length) return { bytes, fileName, packaged: false };
  if (!fileName || /[/\\]/.test(fileName)) throw new Error('Invalid export filename.');
  const entries = /\.zip$/i.test(fileName) ? unzipSync(bytes) : { [fileName]: bytes };
  // Keep existing notices in a supplied/exported archive rather than overwrite them.
  let noticeName = 'ATTRIBUTION.json'; let suffix = 1;
  while (Object.hasOwn(entries, noticeName)) noticeName = suffix++ === 1 ? 'PUSHFORM_ATTRIBUTION.json' : `PUSHFORM_ATTRIBUTION_${suffix}.json`;
  entries[noticeName] = strToU8(JSON.stringify({ version: 1, attributions: parseModelAttributions(notices) }, null, 2));
  return { bytes: zipSync(entries, { level: 0 }), fileName: fileName.replace(/\.[^.]+$/, '') + '.zip', packaged: true };
}
