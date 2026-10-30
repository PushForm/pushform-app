// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFile, writeFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { PushFormError, meshBounds, type Box3, type Id } from '@pushform/core';
import { contentWorldBounds, definitionAt, sketchFaceLoops, type DocumentState } from '@pushform/model';
import { z } from 'zod';
import type { HeadlessSession } from './session';
import { commandTools, objectSchema } from './tools';

export const SERVER_NAME = 'pushform-mcp';
export const SERVER_VERSION = '0.0.1';

/** Entities and faces per page of a read tool. */
export const PAGE_SIZE = 200;
/** Points of a face outline a read reports. */
export const LOOP_POINTS = 64;

/** File access for `model_open` / `model_save`; tests may substitute an in-memory one. */
export interface FileAccess {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}
export const nodeFiles: FileAccess = {
  read: async (path) => new Uint8Array(await readFile(path)),
  write: (path, bytes) => writeFile(path, bytes),
};

const pathSchema = z.array(z.number().int().nonnegative()).default([]).describe('Instance path of the container (empty = the model root)');
const ENTITY_KINDS = ['body', 'sketchFace', 'sketchEdge', 'instance', 'guide', 'text', 'dimension', 'image'] as const;

interface BuiltinTool {
  description: string;
  params: z.ZodType;
  run(session: HeadlessSession, params: never): unknown;
}

/** Tools that are not registry commands: files and reads. */
function builtinTools(files: FileAccess): Record<string, BuiltinTool> {
  return {
    model_new: {
      description: 'Start a new, empty model. Unsaved changes to the current model are discarded, with its undo history.',
      params: z.object({}),
      run: (s) => {
        s.newModel();
        return info(s);
      },
    },
    model_open: {
      description: 'Open a PushForm model (.pf) from a file path, replacing the current model and its undo history.',
      params: z.object({ path: z.string().min(1) }),
      run: async (s, p: { path: string }) => {
        await s.load(await files.read(p.path), p.path);
        return info(s);
      },
    },
    model_save: {
      description: 'Save the model as a PushForm model (.pf). Without a path, saves to the file it was opened from or last saved to.',
      params: z.object({ path: z.string().min(1).optional() }),
      run: async (s, p: { path?: string }) => {
        const path = p.path ?? s.path;
        if (!path) throw new PushFormError('save.path', 'This model has no file yet: give a path.');
        const revision = s.model.host.doc.version;
        const bytes = await s.model.encode();
        await files.write(path, bytes);
        s.path = path;
        return { path, bytes: bytes.byteLength, revision };
      },
    },
    model_info: {
      description: 'Summary of the open model: file, revision, undo/redo availability, entity counts at the root, world bounds and the selection.',
      params: z.object({}),
      run: (s) => info(s),
    },
    model_entities: {
      description: `Entities of one container (the root, or a group/component opened by instance path), ${PAGE_SIZE} per page, with references usable as command params. Coordinates are the container's own (meters, Z up).`,
      params: z.object({ path: pathSchema, kinds: z.array(z.enum(ENTITY_KINDS)).optional(), offset: z.number().int().nonnegative().default(0) }),
      run: (s, p: { path: Id[]; kinds?: (typeof ENTITY_KINDS)[number][]; offset: number }) => entities(s.model.host.doc.state, p.path, p.kinds, p.offset),
    },
    body_faces: {
      description: `Faces of a solid, ${PAGE_SIZE} per page: face id, unit normal, outer outline (up to ${LOOP_POINTS} points), number of loops and materials. Use the face id in a face reference ({kind:"face", id:<body>, faceId, region:null}).`,
      params: z.object({ path: pathSchema, id: z.number().int().nonnegative(), offset: z.number().int().nonnegative().default(0) }),
      run: (s, p: { path: Id[]; id: Id; offset: number }) => faces(s.model.host.doc.state, p.path, p.id, p.offset),
    },
  };
}

function info(s: HeadlessSession) {
  const host = s.model.host;
  const state = host.doc.state;
  const root = state.definitions.get(state.rootDefinitionId)!.entities;
  return {
    path: s.path,
    revision: host.doc.version,
    canUndo: host.canUndo(),
    canRedo: host.canRedo(),
    root: {
      bodies: root.bodies.size,
      sketchFaces: root.sketch.faces.size,
      sketchEdges: root.sketch.edges.size,
      instances: root.instances.size,
      guides: root.guides.size,
      texts: root.texts.size,
      dimensions: root.dimensions.size,
      images: root.images.size,
    },
    definitions: state.definitions.size - 1,
    bounds: box(contentWorldBounds(state, [])),
    selection: host.selection.refs,
  };
}

const box = (b: Box3 | null) => (b ? { min: [...b.min], max: [...b.max] } : null);

function entities(state: DocumentState, path: Id[], kinds: readonly string[] | undefined, offset: number) {
  const container = definitionAt(state, path).entities;
  const want = (k: string) => !kinds || kinds.includes(k);
  const all: Record<string, unknown>[] = [];
  if (want('body'))
    for (const b of container.bodies.values())
      all.push({ ref: { kind: 'body', path, id: b.id }, volume: b.props.volume, area: b.props.area, faces: b.faces.size, valid: b.valid, bounds: box(meshBounds(b.mesh)), hidden: b.hidden });
  if (want('sketchFace'))
    for (const f of container.sketch.faces.values()) {
      const loops = sketchFaceLoops(container.sketch, f);
      all.push({ ref: { kind: 'sketchFace', path, id: f.id }, normal: f.plane.n, outline: (loops[0] ?? []).slice(0, LOOP_POINTS), loops: loops.length });
    }
  if (want('sketchEdge'))
    for (const e of container.sketch.edges.values())
      all.push({ ref: { kind: 'sketchEdge', path, id: e.id }, a: container.sketch.vertices.get(e.a)?.p, b: container.sketch.vertices.get(e.b)?.p });
  if (want('instance'))
    for (const i of container.instances.values()) {
      const def = state.definitions.get(i.definitionId);
      all.push({ ref: { kind: 'instance', path, id: i.id }, definitionId: i.definitionId, definition: def?.name, group: def?.isGroup, name: i.name, transform: i.transform });
    }
  if (want('guide')) for (const g of container.guides.values()) all.push({ ref: { kind: 'guide', path, id: g.id }, guide: g });
  if (want('text')) for (const t of container.texts.values()) all.push({ ref: { kind: 'text', path, id: t.id }, text: t.text, textKind: t.kind, position: t.position });
  if (want('dimension')) for (const d of container.dimensions.values()) all.push({ ref: { kind: 'dimension', path, id: d.id }, dimensionKind: d.kind, start: d.start, end: d.end });
  if (want('image')) for (const im of container.images.values()) all.push({ ref: { kind: 'image', path, id: im.id }, image: im });
  return page(all, offset);
}

function faces(state: DocumentState, path: Id[], id: Id, offset: number) {
  const body = definitionAt(state, path).entities.bodies.get(id);
  if (!body) throw new PushFormError('entity.missing', `There is no solid ${id} in that container.`);
  const all = [...body.faces.values()].map((f) => ({
    faceId: f.id,
    normal: f.plane.n,
    outline: (f.loops[0] ?? []).slice(0, LOOP_POINTS),
    loops: f.loops.length,
    frontMaterialId: f.frontMaterialId,
    backMaterialId: f.backMaterialId,
  }));
  return page(all, offset);
}

function page<T>(all: T[], offset: number) {
  return { total: all.length, offset, next: offset + PAGE_SIZE < all.length ? offset + PAGE_SIZE : null, items: all.slice(offset, offset + PAGE_SIZE) };
}

/** JSON text for a result: maps become objects, typed arrays are summarized. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v instanceof Map) return Object.fromEntries(v);
    if (v instanceof Set) return [...v];
    if (ArrayBuffer.isView(v)) return `[${v.constructor.name} of ${(v as unknown as ArrayLike<unknown>).length}]`;
    return v;
  });
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof PushFormError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * The MCP server over a headless session. Registry commands and the built-in
 * read and file tools are listed together; calls run one at a time, in arrival order, so a
 * command never sees the model change under it.
 */
export function createMcpServer(session: HeadlessSession, files: FileAccess = nodeFiles): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
  const builtins = builtinTools(files);
  let queue: Promise<unknown> = Promise.resolve();

  server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools: Tool[] = Object.entries(builtins).map(([name, t]) => ({ name, description: t.description, inputSchema: objectSchema(t.params) as Tool['inputSchema'] }));
    for (const t of commandTools(session.model.registry)) tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema as Tool['inputSchema'] });
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const run = async (): Promise<CallToolResult> => {
      const { name, arguments: args = {} } = request.params;
      try {
        const builtin = builtins[name];
        if (builtin) {
          const parsed = builtin.params.safeParse(args);
          if (!parsed.success) throw new PushFormError('command.params', `Invalid params for ${name}: ${parsed.error.message}`);
          return { content: [{ type: 'text', text: toJson(await builtin.run(session, parsed.data as never)) }] };
        }
        const tool = commandTools(session.model.registry).find((t) => t.name === name);
        if (!tool) throw new PushFormError('command.unknown', `Unknown tool: ${name}`);
        const result = await session.model.registry.execute(tool.commandId, args);
        return { content: [{ type: 'text', text: toJson({ result: result ?? null, revision: session.model.host.doc.version }) }] };
      } catch (error) {
        return errorResult(error);
      }
    };
    const next = queue.then(run, run);
    queue = next;
    return next;
  });

  return server;
}
