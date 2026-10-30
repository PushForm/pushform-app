// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { unzipSync } from 'fflate';

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
    return unzipSync(bytes, {
      filter: (file) => {
        if (++entries > NATIVE_ARCHIVE_MAX_ENTRIES)
          throw new NativeArchiveError(`${invalid}: more than ${NATIVE_ARCHIVE_MAX_ENTRIES} entries`);
        if (!options.supported(file.name)) return false;
        expanded += file.originalSize;
        if (expanded > NATIVE_ARCHIVE_MAX_EXPANDED_BYTES)
          throw new NativeArchiveError(`${invalid}: expands beyond ${NATIVE_ARCHIVE_MAX_EXPANDED_BYTES / (1024 * 1024)} MiB`);
        return true;
      },
    });
  } catch (cause) {
    if (cause instanceof NativeArchiveError) throw cause;
    throw new NativeArchiveError(invalid);
  }
}
