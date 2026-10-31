// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global console, process */
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { ExtensionPackageError } from '@pushform/extension-protocol';
import { packDirectory, validateArchive } from './pack.ts';

const USAGE = `pushform-extension pack <build-dir> [--out <file.zip>]   package and validate a build directory
pushform-extension validate <file.zip>                    validate a package as PushForm does at install`;

function report(error: unknown): never {
  if (error instanceof ExtensionPackageError) {
    console.error(`Refused (${error.details.problem}${error.details.path ? `, ${error.details.path}` : ''}): ${error.message}`);
    for (const issue of error.details.issues ?? []) console.error(`  ${issue}`);
  } else console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const [command, target, ...rest] = process.argv.slice(2);
try {
  if (command === 'pack' && target) {
    const outFlag = rest.indexOf('--out');
    const named = outFlag >= 0 && rest[outFlag + 1] ? resolve(rest[outFlag + 1]!) : null;
    const packed = await packDirectory(resolve(target), named ? [named] : []);
    const out = named ?? resolve(`${packed.manifest.id}-${packed.manifest.version}.zip`);
    await writeFile(out, packed.archive);
    console.log(`Packed ${packed.manifest.id} ${packed.manifest.version}: ${packed.files.size} files, ${packed.archive.byteLength} bytes → ${basename(out)}`);
    console.log(`Content hash ${packed.contentHash} (${packed.integrity})`);
  } else if (command === 'validate' && target) {
    const validated = await validateArchive(new Uint8Array(await readFile(resolve(target))));
    console.log(`Valid: ${validated.manifest.id} ${validated.manifest.version} (${validated.integrity}), content hash ${validated.contentHash}`);
  } else {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  report(error);
}
