// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import type { Isolation, PackageSpec } from '../harness/harness';
import type { Hit } from '../server';

declare global {
  interface Window { isolation: Isolation }
}

/** What one attack inside a hostile extension came to. */
export interface Attempt { readonly outcome: 'allowed' | 'blocked'; readonly detail: string }
export type Attempts = Readonly<Record<string, Attempt>>;

/** One attack: a plain-language title and the code the hostile extension runs, as `(p) => ...` source. */
export interface Attack { readonly title: string; readonly code: string }

export const editorOrigin = (info: TestInfo): string => {
  const origin = info.project.metadata.editor === 'enforced' ? process.env.ISOLATION_ENFORCED : process.env.ISOLATION_HOSTED;
  if (!origin) throw new Error('The harness servers are not running (global-setup.ts).');
  return origin;
};
export const remoteOrigin = (): string => process.env.ISOLATION_REMOTE!;
export const stunAddress = (): string => process.env.ISOLATION_STUN!;

/** A tag unique to the project and the test, put into every URL an attack uses, so its server hits can be told apart. */
export const tagFor = (info: TestInfo, name: string): string => `${info.project.name}-${name}`.replace(/[^a-z0-9-]/gi, '-');

/** Requests that reached the editor or the outside server carrying `tag`, or every datagram for `udp`. */
export async function hitsFor(tag: string): Promise<Hit[]> {
  const response = await fetch(`${process.env.ISOLATION_HOSTED}/__hits?tag=${encodeURIComponent(tag)}`);
  return (await response.json()) as Hit[];
}

/** Every request that reached either server outside the harness's own files. */
export async function allHits(): Promise<Hit[]> {
  const response = await fetch(`${process.env.ISOLATION_HOSTED}/__hits?all=1`);
  return (await response.json()) as Hit[];
}

/** A fresh editor page with the harness loaded, under the project's editor headers. */
export async function openHarness(browser: Browser, info: TestInfo): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`${editorOrigin(info)}/`);
  await page.waitForFunction(() => typeof window.isolation === 'object', null, { timeout: 15_000 });
  return page;
}

/**
 * The probe library every hostile package carries as `probe.js` (so module linking is exercised too). `attemptAll`
 * runs each attack in turn, bounded in time, and records `allowed` with what it got, or `blocked` with the error.
 */
export const PROBE_LIBRARY = `
export const remote = (p, name) => p.remote + '/x/' + p.tag + '/' + name;
export const editor = (p, name) => p.editor + '/x/' + p.tag + '/' + name;
export const settle = (target, ok, fail) => new Promise((resolve, reject) => {
  target[ok] = () => resolve(ok.slice(2));
  target[fail] = () => reject(new Error(fail.slice(2) + ' event'));
});
const show = (value) => {
  try { return typeof value === 'string' ? value.slice(0, 200) : (JSON.stringify(value) ?? String(value)).slice(0, 200); } catch { return String(value).slice(0, 200); }
};
export async function attemptAll(attacks, p) {
  const results = {};
  for (const [name, attack] of Object.entries(attacks)) {
    try {
      const value = await Promise.race([Promise.resolve().then(() => attack(p)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('no answer within ' + (p.timeoutMs ?? 1500) + ' ms')), p.timeoutMs ?? 1500))]);
      results[name] = { outcome: 'allowed', detail: show(value) };
    } catch (error) {
      results[name] = { outcome: 'blocked', detail: String(error && error.name || 'Error') + ': ' + String(error && error.message || error).slice(0, 200) };
    }
  }
  return results;
}
`;

/** A hostile package whose `run` command performs `attacks` and returns their attempts. */
export function hostilePackage(id: string, attacks: Readonly<Record<string, Attack>>, options: { wasm?: boolean; files?: Record<string, string>; permissions?: PackageSpec['permissions'] } = {}): PackageSpec {
  const table = Object.entries(attacks).map(([name, attack]) => `  ${JSON.stringify(name)}: ${attack.code},`).join('\n');
  return {
    id, permissions: options.permissions ?? [], commands: ['run'], ...(options.wasm ? { wasm: true } : {}),
    files: {
      'probe.js': PROBE_LIBRARY,
      'main.js': `import { attemptAll, remote, editor, settle } from './probe.js';
const attacks = {
${table}
};
export function activate(context) {
  context.commands.register(${JSON.stringify(`${id}.run`)}, (params) => attemptAll(attacks, params));
}`,
      ...options.files,
    },
  };
}

/** Asserts an attack was refused, and records how on the test for the report. */
export function expectBlocked(attempts: Attempts, name: string): void {
  const attempt = attempts[name];
  expect(attempt, `no result for ${name}`).toBeDefined();
  test.info().annotations.push({ type: attempt!.outcome, description: attempt!.detail });
  expect(attempt!.outcome, `${name} was allowed: ${attempt!.detail}`).toBe('blocked');
}
