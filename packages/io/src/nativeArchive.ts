// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { unzipSync, type UnzipFileInfo } from 'fflate';

/**
 * Bounds on what a native .pf/.pfl archive may expand to before it is opened.
 *
 * The cloud download limit (100 MiB) bounds compressed bytes only; these bounds cover the
 * inflated manifest and image entries so a hostile or damaged archive cannot exhaust memory. The
 * largest known native sample manifests are the MC364 building model at about 83 MiB of JSON (the
 * SD variant is 21 MiB) and the MC364_A1_Site Layout at about 27 MiB; the full sample set stores
 * well under a hundred image entries per document. JSON compresses roughly 6:1 at the archive's
 * deflate level, so a 50 MiB upload of pure JSON expands to about 300 MiB. Uploads near 100 MiB
 * are dominated by already-compressed payloads (images, preserved LayOut packages), which expand
 * little, so 512 MiB still leaves headroom. It stays below V8's maximum string length for the
 * manifest text, which caps it regardless; 4096 entries is an order of magnitude above the sample
 * image counts.
 */
export const NATIVE_ARCHIVE_MAX_ENTRIES = 4096;
export const NATIVE_ARCHIVE_MAX_EXPANDED_BYTES = 512 * 1024 * 1024;

/** An archive that fails the bounds or cannot be read. Opening leaves the session unchanged. */
export class NativeArchiveError extends Error {}

export interface NativeArchiveOptions {
  /** Extension shown in error messages, such as `.pf`. */
  extension: string;
  /** Entries to inflate; everything else is skipped without being decompressed. */
  supported: (name: string) => boolean;
}

/**
 * Inflate the supported entries of a native archive, failing before any decompression when the
 * central directory declares more entries or more expanded bytes than the bounds allow. fflate
 * inflates each entry into a buffer sized from the directory, so the declared sizes bound memory.
 */
export function readNativeArchive(bytes: Uint8Array, options: NativeArchiveOptions): Record<string, Uint8Array> {
  const invalid = `Invalid ${options.extension} archive`;
  let entries = 0, expanded = 0;
  try {
    return unzipEntries(bytes, (name, file) => {
      if (++entries > NATIVE_ARCHIVE_MAX_ENTRIES)
        throw new NativeArchiveError(`${invalid}: more than ${NATIVE_ARCHIVE_MAX_ENTRIES} entries`);
      if (!options.supported(name)) return false;
      expanded += file.originalSize;
      if (expanded > NATIVE_ARCHIVE_MAX_EXPANDED_BYTES)
        throw new NativeArchiveError(`${invalid}: expands beyond ${NATIVE_ARCHIVE_MAX_EXPANDED_BYTES / (1024 * 1024)} MiB`);
      return true;
    });
  } catch (cause) {
    if (cause instanceof NativeArchiveError) throw cause;
    throw new NativeArchiveError(invalid);
  }
}

/**
 * Inflate the entries of a ZIP archive that `filter` accepts, keyed by their names. An entry name
 * without the archive's UTF-8 flag is read as UTF-8 when its bytes are valid UTF-8: some writers,
 * LayOut among them, store UTF-8 names without setting the flag, and reading them in the legacy
 * single-byte encoding garbles every non-ASCII name, so references to those entries never resolve.
 */
export function unzipEntries(bytes: Uint8Array, filter: (name: string, file: UnzipFileInfo) => boolean): Record<string, Uint8Array> {
  const names = utf8EntryNames(bytes);
  const files = unzipSync(bytes, { filter: file => filter(names.get(file.name) ?? file.name, file) });
  if (!names.size) return files;
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [names.get(name) ?? name, data]));
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Names of entries stored without the UTF-8 flag whose bytes are valid UTF-8 beyond ASCII, keyed by
 * the single-byte reading fflate gives them. Reads the central directory; an archive this cannot
 * read (ZIP64 or damaged) is left to fflate's own reading.
 */
function utf8EntryNames(bytes: Uint8Array): Map<string, string> {
  const names = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) return names;
  const count = view.getUint16(end + 10, true), directory = view.getUint32(end + 16, true);
  if (count === 0xffff || directory === 0xffffffff) return names;
  for (let at = directory, index = 0; index < count; index++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return names;
    const flags = view.getUint16(at + 8, true), length = view.getUint16(at + 28, true);
    const raw = bytes.subarray(at + 46, at + 46 + length);
    if (!(flags & 0x800) && raw.some(byte => byte >= 0x80)) {
      try {
        names.set(String.fromCharCode(...raw), strictUtf8.decode(raw));
      } catch { /* Not UTF-8: keep the single-byte reading. */ }
    }
    at += 46 + length + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return names;
}
