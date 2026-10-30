// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { m4translation } from '@pushform/core';
import type { Box3, DefId, Id, Ray, Vec3 } from '@pushform/core';
import { freeInference, GROUND_PLANE } from '@pushform/inference';
import type { PickHit } from '@pushform/inference';
import { createEntityContainer } from '@pushform/model';
import type { EntityRef } from '@pushform/model';
import { CommandRegistry } from '../../registry/CommandRegistry';
import { sketchCommands } from '../../commands/sketch';
import { DocumentHost } from '../../host/DocumentHost';
import { hostOf, SERVICE_DOCUMENT } from '../../host/services';
import type { CameraHost, CameraState } from '../../camera/CameraHost';
import { ToolManager } from '../ToolManager';
import { NO_MODIFIERS } from '../Tool';
import type { ToolPointerEvent } from '../Tool';
import { enterPathOf, SelectTool } from './Select';

const CAMERA: CameraState = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 35, projection: 'parallel', orthoHeight: 6 };

class StubCamera implements CameraHost {
  getState(): CameraState {
    return CAMERA;
  }
  setState(): void {}
  viewportSize() {
    return { width: 800, height: 600 };
  }
  screenToRay(): Ray {
    return { origin: [0, 0, 10], dir: [0, 0, -1] };
  }
  pick(): Vec3 | null {
    return null;
  }
  sceneBounds(): Box3 | null {
    return null;
  }
  orbitStart(): void {}
  orbitDrag(): void {}
  orbitEnd(): void {}
  panStart(): void {}
  panDrag(): void {}
  panEnd(): void {}
  zoomAt(): void {}
  zoomExtents(): void {}
  zoomWindow(): void {}
  standardView(): void {}
  setProjection(): void {}
  setFov(): void {}
  setFocalLength(): void {}
  previousView(): boolean {
    return false;
  }
  nextView(): boolean {
    return false;
  }
}

/** Stub `context.*` commands with agent A's ids/params, backed by `host.setContext`. */
function stubContextCommands(registry: CommandRegistry, log: string[]) {
  registry.register({
    id: 'context.enter',
    title: 'Edit Group',
    category: 'edit',
    params: z.object({ path: z.array(z.number().int()) }),
    undoable: false,
    run: (ctx, p) => {
      log.push(`enter ${p.path.join('.')}`);
      hostOf(ctx).setContext(p.path as Id[]);
    },
  });
  registry.register({
    id: 'context.exit',
    title: 'Close Group',
    category: 'edit',
    params: z.object({}),
    undoable: false,
    when: (ctx) => hostOf(ctx).context.path.length > 0,
    run: (ctx) => {
      log.push('exit');
      const host = hostOf(ctx);
      host.setContext(host.context.path.slice(0, -1));
    },
  });
}

/** A group instance in the root with one nested group inside it. */
function addNestedGroups(host: DocumentHost): { outer: Id; inner: Id } {
  let outer = 0 as Id, inner = 0 as Id;
  host.doc.transact('setup', (draft) => {
    const defA = draft.meta.nextId++ as DefId, defB = draft.meta.nextId++ as DefId;
    const root = draft.definitions.get(draft.rootDefinitionId)!;
    draft.definitions.set(defA, { ...root, id: defA, name: 'Outer', isGroup: true, entities: createEntityContainer() } as never);
    draft.definitions.set(defB, { ...root, id: defB, name: 'Inner', isGroup: false, entities: createEntityContainer() } as never);
    outer = draft.meta.nextId++ as Id;
    inner = draft.meta.nextId++ as Id;
    const attrs = { materialId: null, tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} };
    root.entities.instances.set(outer, { id: outer, definitionId: defA, transform: m4translation([1, 0, 0]), name: 'House', ...attrs } as never);
    draft.definitions.get(defA)!.entities.instances.set(inner, { id: inner, definitionId: defB, transform: m4translation([0, 1, 0]), name: '', ...attrs } as never);
  });
  return { outer, inner };
}

function setup() {
  const host = new DocumentHost();
  const camera = new StubCamera();
  const registry = new CommandRegistry({ tx: host, camera, services: new Map([[SERVICE_DOCUMENT, host]]) });
  registry.registerAll(sketchCommands);
  const log: string[] = [];
  stubContextCommands(registry, log);
  const tools = new ToolManager(registry, camera);
  registry.ctx.tools = tools;
  tools.register(new SelectTool());
  tools.activate('select');
  return { host, registry, tools, log, select: tools.activeTool as SelectTool };
}

function at(p: Vec3, hit: PickHit | null = null): ToolPointerEvent {
  return {
    screen: [400 + p[0] * 100, 300 - p[1] * 100],
    ray: { origin: [p[0], p[1], 10], dir: [0, 0, -1] },
    button: 0,
    buttons: 1,
    modifiers: NO_MODIFIERS,
    inference: freeInference(p, GROUND_PLANE, hit),
    camera: CAMERA,
  };
}

describe('SelectTool edit contexts', () => {
  it('clicks select hit.selectable (the instance seen from the context) and hover follows it', () => {
    const { host, tools } = setup();
    const { outer } = addNestedGroups(host);
    const face: EntityRef = { kind: 'face', path: [outer], id: 99 as Id, faceId: 0 as never, region: null };
    const selectable: EntityRef = { kind: 'instance', path: [], id: outer };
    const hit: PickHit = { ref: face, point: [1, 0, 0], t: 10, screenDist: 0, selectable, inContext: false };
    tools.pointerMove(at([1, 0, 0], hit));
    expect((tools.activeTool as SelectTool).hoverRef).toEqual(selectable);
    tools.click(at([1, 0, 0], hit));
    expect(host.selection.refs).toEqual([selectable]);
    // hits without `selectable` fall back to the ref itself
    const plain: PickHit = { ref: face, point: [1, 0, 0], t: 10, screenDist: 0 };
    tools.click(at([1, 0, 0], plain));
    expect(host.selection.refs).toEqual([face]);
  });

  it('double-click an instance enters it via context.enter, nested double-click goes one level deeper', () => {
    const { host, tools, log, select } = setup();
    const { outer, inner } = addNestedGroups(host);
    const instRef: EntityRef = { kind: 'instance', path: [], id: outer };
    const hit: PickHit = { ref: instRef, point: [1, 0, 0], t: 10, screenDist: 0 };
    tools.click(at([1, 0, 0], hit));
    tools.doubleClick(at([1, 0, 0], hit));
    expect(log).toEqual(['enter ' + outer]);
    expect(host.context.path).toEqual([outer]);
    expect(host.selection.isEmpty).toBe(true); // entering clears the selection
    expect(select.status().instructor).toMatch(/^Editing Group: House\./);

    // From inside `outer`, a face of `inner` (path [outer, inner]) enters `inner` (seen from the context).
    const deep: EntityRef = { kind: 'face', path: [outer, inner], id: 5 as Id, faceId: 0 as never, region: null };
    expect(enterPathOf({ ref: deep, point: [0, 0, 0], t: 1, screenDist: 0 }, [outer])).toEqual([outer, inner]);
    tools.doubleClick(at([1, 1, 0], { ref: deep, point: [1, 1, 0], t: 10, screenDist: 0 }));
    expect(host.context.path).toEqual([outer, inner]);
    expect(select.status().instructor).toMatch(/^Editing Component: Inner\./); // unnamed instance → definition name

    // Inside the context a face double-click keeps the M1 behaviour (body face → body), no context change.
    const own: EntityRef = { kind: 'face', path: [outer, inner], id: 7 as Id, faceId: 0 as never, region: null };
    tools.doubleClick(at([1, 1, 0], { ref: own, point: [1, 1, 0], t: 10, screenDist: 0, inContext: true }));
    expect(host.context.path).toEqual([outer, inner]);
    expect(host.selection.refs).toEqual([{ kind: 'body', path: [outer, inner], id: 7 }]);
  });

  it('Esc with nothing selected and a click on empty space exit one level; Esc with a selection does not', () => {
    const { host, tools, log, registry } = setup();
    const { outer, inner } = addNestedGroups(host);
    registry.execute('context.enter', { path: [outer, inner] });
    log.length = 0;
    host.selection.set([{ kind: 'body', path: [outer, inner], id: 7 as Id }]);
    tools.keyDown({ key: 'Escape', code: 'Escape', modifiers: NO_MODIFIERS, repeat: false });
    expect(log).toEqual([]);
    expect(host.context.path).toEqual([outer, inner]);
    host.selection.clear();
    tools.keyDown({ key: 'Escape', code: 'Escape', modifiers: NO_MODIFIERS, repeat: false });
    expect(log).toEqual(['exit']);
    expect(host.context.path).toEqual([outer]);
    tools.click(at([3, 3, 0])); // empty space
    expect(log).toEqual(['exit', 'exit']);
    expect(host.context.path).toEqual([]);
    expect((tools.activeTool as SelectTool).status().instructor).toMatch(/^Select objects/);
    // at the root an empty click just clears
    host.selection.set([{ kind: 'instance', path: [], id: outer }]);
    tools.click(at([3, 3, 0]));
    expect(host.selection.isEmpty).toBe(true);
    expect(log).toEqual(['exit', 'exit']);
  });

  it('works without the context commands registered (double-click falls back to expansion)', () => {
    const host = new DocumentHost();
    const camera = new StubCamera();
    const registry = new CommandRegistry({ tx: host, camera, services: new Map([[SERVICE_DOCUMENT, host]]) });
    registry.registerAll(sketchCommands);
    const tools = new ToolManager(registry, camera);
    tools.register(new SelectTool());
    tools.activate('select');
    const { outer } = addNestedGroups(host);
    const instRef: EntityRef = { kind: 'instance', path: [], id: outer };
    tools.doubleClick(at([1, 0, 0], { ref: instRef, point: [1, 0, 0], t: 10, screenDist: 0 }));
    expect(host.context.path).toEqual([]);
    expect(host.selection.refs).toEqual([instRef]);
  });
});
