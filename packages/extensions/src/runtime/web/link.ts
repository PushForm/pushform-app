// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// The pure-JavaScript build: no WebAssembly, so the runtime's policy need not allow compiling any. It needs no init.
import { parse } from 'es-module-lexer/js';
import { ExtensionError } from '@pushform/extension-protocol/runtime-core';

/**
 * Links an extension package's ES modules for its isolated runtime. The runtime has no URL that serves package
 * files, so every JavaScript file becomes a blob URL, and the specifiers that name other package files are rewritten
 * to those URLs, dependencies first. Only relative specifiers that resolve to a `.js` or `.mjs` file of the package
 * are linked: a bare specifier (`react`), an absolute URL or a path leaving the package is refused, because the
 * package must carry all of its code. Import cycles between files are refused too, since a blob URL's content is
 * fixed when it is made; bundle cyclic modules into one file. Dynamic `import()` is linked when its specifier is a
 * string literal; any other dynamic import cannot reach package files and is left to fail at run time.
 */

const JS = /\.m?js$/;

/** Turns a module's linked source into a URL the runtime can import. */
export type MintModuleUrl = (path: string, source: string) => string;

/** Links the module graph reachable from `main` and returns the URL to import it by. */
export async function linkModules(files: ReadonlyMap<string, Uint8Array>, main: string, mint: MintModuleUrl): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const urls = new Map<string, string>();
  const visiting: string[] = [];

  const visit = (path: string): string => {
    const done = urls.get(path);
    if (done !== undefined) return done;
    if (visiting.includes(path))
      throw new ExtensionError('validation.failed', `The modules ${[...visiting.slice(visiting.indexOf(path)), path].join(' → ')} import each other in a cycle; bundle them into one file.`);
    const bytes = files.get(path);
    if (!bytes || !JS.test(path)) throw new ExtensionError('validation.failed', `"${path}" is not a JavaScript file of the package.`);
    let source: string;
    try {
      source = decoder.decode(bytes);
    } catch {
      throw new ExtensionError('validation.failed', `"${path}" is not UTF-8 text.`);
    }
    let imports: ReturnType<typeof parse>[0];
    try {
      [imports] = parse(source, path);
    } catch (error) {
      throw new ExtensionError('validation.failed', `"${path}" is not a valid ES module (${(error as Error).message}).`);
    }
    visiting.push(path);
    // Replace from the end so earlier offsets stay valid.
    const edits: { start: number; end: number; text: string }[] = [];
    for (const entry of imports) {
      if (entry.d === -2) continue; // import.meta
      if (entry.n === undefined) continue; // dynamic import of a non-literal expression
      const target = resolve(path, entry.n);
      const url = visit(target);
      edits.push(entry.d === -1 ? { start: entry.s, end: entry.e, text: url } : { start: entry.s, end: entry.e, text: JSON.stringify(url) });
    }
    visiting.pop();
    let linked = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) linked = linked.slice(0, edit.start) + edit.text + linked.slice(edit.end);
    const url = mint(path, linked);
    urls.set(path, url);
    return url;
  };

  return visit(main);
}

/** The package path a relative specifier names from `importer`, or a refusal. */
export function resolve(importer: string, specifier: string): string {
  if (!specifier.startsWith('./') && !specifier.startsWith('../'))
    throw new ExtensionError('validation.failed', `"${importer}" imports "${specifier}"; extension packages may import only their own files by relative path.`);
  const segments = importer.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (segments.length === 0) throw new ExtensionError('validation.failed', `"${importer}" imports "${specifier}", which is outside the package.`);
      segments.pop();
    } else segments.push(part);
  }
  return segments.join('/');
}
