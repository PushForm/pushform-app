// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { modelContentIdentity, openModelFile } from '@pushform/io';
import { meshTopologyProblems } from '@pushform/kernel';
import { main } from './cli';
import { createMcpServer } from './server';
import { HeadlessSession } from './session';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function connect() {
  const session = new HeadlessSession();
  const server = createMcpServer(session);
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    session.dispose();
  });
  /** Call a tool; parse its JSON text, or throw with its error text. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are free-form JSON
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
    const text = res.content[0]!.text;
    if (res.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { session, client, call };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pf-mcp-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('headless MCP server', () => {
  it('lists the registry commands and the read and file tools, with object input schemas', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['sketch_rectangle', 'pushpull_apply', 'solids_union', 'edit_undo', 'selection_set', 'model_open', 'model_save', 'model_new', 'model_info', 'model_entities', 'body_faces'])
      expect(names).toContain(n);
    expect(names).not.toContain('pushpull_preview'); // internal
    expect(names.some((n) => n.startsWith('camera_'))).toBe(false); // no viewport headless
    for (const t of tools) {
      expect(t.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(t.inputSchema.type).toBe('object');
    }
    const rect = tools.find((t) => t.name === 'sketch_rectangle')!;
    expect(Object.keys(rect.inputSchema.properties ?? {})).toEqual(['a', 'b', 'c', 'd']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('builds a staircase through tool calls only, saves it, and reopens an identical model', async () => {
    const { session, call } = await connect();
    const steps = 5, run = 0.3, rise = 0.18, width = 1;
    // one tread outline per step, side by side on the ground
    for (let i = 0; i < steps; i++) {
      const y0 = i * run, y1 = (i + 1) * run;
      await call('sketch_rectangle', { a: [0, y0, 0], b: [width, y0, 0], c: [width, y1, 0], d: [0, y1, 0] });
    }
    const faces = (await call('model_entities', { kinds: ['sketchFace'] })).items as { ref: { id: number }; normal: number[]; outline: number[][] }[];
    expect(faces).toHaveLength(steps);
    const stepOf = (f: (typeof faces)[number]) => Math.floor(Math.min(...f.outline.map((p) => p[1]!)) / run + 1e-6);
    let staircase: number | null = null;
    for (const f of [...faces].sort((x, y) => stepOf(x) - stepOf(y))) {
      const height = (stepOf(f) + 1) * rise;
      const pulled = await call('pushpull_apply', { target: { kind: 'sketchFace', path: [], id: f.ref.id }, distance: f.normal[2]! > 0 ? height : -height, mode: 'newBody' });
      const body = pulled.result.bodyIds.at(-1) as number;
      if (staircase === null) staircase = body;
      else staircase = (await call('solids_union', { a: { kind: 'body', path: [], id: staircase }, b: { kind: 'body', path: [], id: body } })).result.bodyIds[0];
    }
    const before = await call('model_entities', {});
    const bodies = before.items.filter((e: { ref: { kind: string } }) => e.ref.kind === 'body');
    expect(bodies).toHaveLength(1);
    // 5 steps of 1 × 0.3 m with heights 0.18, 0.36, ... 0.90
    expect(bodies[0].volume).toBeCloseTo(width * run * rise * (steps * (steps + 1)) / 2, 6);
    expect(bodies[0].valid).toBe(true);
    for (const b of session.model.host.doc.rootDefinition.entities.bodies.values()) expect(meshTopologyProblems(b.mesh)).toEqual([]);
    const faceList = await call('body_faces', { id: bodies[0].ref.id });
    expect(faceList.total).toBeGreaterThan(6);

    const file = join(tempDir(), 'stairs.pf');
    const saved = await call('model_save', { path: file });
    expect(saved.bytes).toBeGreaterThan(0);
    const content = modelContentIdentity(session.model.host.doc.state);
    const bytes = new Uint8Array(readFileSync(file));
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('PUSHFRM2');
    expect((await openModelFile(bytes)).contentIdentity).toBe(content);
    await call('model_new');
    expect((await call('model_info')).root.bodies).toBe(0);
    const opened = await call('model_open', { path: file });
    expect(opened.path).toBe(file);
    expect(opened.canUndo).toBe(false);
    expect(await call('model_entities', {})).toEqual(before);
    expect(modelContentIdentity(session.model.host.doc.state)).toBe(content);
    for (const b of session.model.host.doc.rootDefinition.entities.bodies.values()) expect(meshTopologyProblems(b.mesh)).toEqual([]);

    // saving without a path writes back to the opened file
    expect((await call('model_save')).path).toBe(file);
    await call('sketch_rectangle', { a: [10, 0, 0], b: [11, 0, 0], c: [11, 1, 0], d: [10, 1, 0] });
    expect(modelContentIdentity(session.model.host.doc.state)).not.toBe(content);
    await call('edit_undo');
    expect(modelContentIdentity(session.model.host.doc.state)).toBe(content);
  });

  it('runs undo and redo as commands and reports failures as tool errors without changing the model', async () => {
    const { call } = await connect();
    await call('sketch_rectangle', { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] });
    const revision = (await call('model_info')).revision;
    await expect(call('sketch_rectangle', { a: [0, 0, 0] })).rejects.toThrow(/command\.params/);
    await expect(call('pushpull_apply', { target: { kind: 'sketchFace', path: [], id: 99999 }, distance: 1 })).rejects.toThrow();
    await expect(call('no_such_tool')).rejects.toThrow(/command\.unknown/);
    await expect(call('model_save')).rejects.toThrow(/save\.path/);
    await expect(call('model_open', { path: join(tempDir(), 'missing.pf') })).rejects.toThrow();
    expect((await call('model_info')).revision).toBe(revision);
    expect((await call('model_info')).root.sketchFaces).toBe(1);
    await call('edit_undo');
    expect((await call('model_info')).root.sketchFaces).toBe(0);
    await call('edit_redo');
    expect((await call('model_info')).root.sketchFaces).toBe(1);
  });

  it('starts only with --headless', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    cleanups.push(() => write.mockRestore());
    expect(await main([])).toBe(2);
    expect(await main(['--headless', '--bogus'])).toBe(2);
    expect(await main(['--headless', join(tempDir(), 'missing.pf')])).toBe(1);
    expect(await main(['--help'])).toBe(0);
  });

  it('opens an application-native file through the bundled executable before serving tools', async () => {
    const { session, call } = await connect();
    await call('sketch_rectangle', { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] });
    const file = join(tempDir(), 'startup.pf');
    await call('model_save', { path: file });
    const client = new Client({ name: 'native-cli-test', version: '0' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../bin/pushform-mcp.mjs', import.meta.url)), '--headless', file], stderr: 'pipe' });
    cleanups.push(() => client.close());
    await client.connect(transport);
    const info = await client.callTool({ name: 'model_info', arguments: {} });
    expect(info.isError).not.toBe(true);
    const content = info.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]!.text)).toMatchObject({ path: file, root: { sketchFaces: 1 } });
    const saved = await client.callTool({ name: 'model_save', arguments: {} });
    expect(saved.isError).not.toBe(true);
    expect((await openModelFile(new Uint8Array(readFileSync(file)))).contentIdentity).toBe(modelContentIdentity(session.model.host.doc.state));
  }, 30_000);
});
