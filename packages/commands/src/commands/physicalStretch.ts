// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import {
  LENGTH_TOL,
  PushFormError,
  box3Empty,
  box3Expand,
  m4identity,
  m4invert,
  m4mul,
  m4transformDir,
  m4transformPoint,
  m4translation,
  newGuid,
  v3dist,
  v3sub,
  basisToWorld,
  type Box3,
  type CurveId,
  type DefId,
  type Id,
  type Mat4,
  type SurfaceId,
  type Vec3,
} from '@pushform/core';
import type { KernelClient } from '@pushform/kernel';
import {
  containerAt,
  contextMatrix,
  continueTopologyElement,
  recordTopologyContinuation,
  textureTiles,
  type Body,
  type DocumentDraft,
  type DocumentState,
  type EntityRef,
} from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { DocumentHost } from '../host/DocumentHost';
import { hostOf } from '../host/services';
import { draftContainerAt } from './context';
import {
  captureContainerOccurrence,
  isolateContainerOccurrence,
  type ContainerIdentityChange,
} from './groups';
import { PHYSICAL_COPY_LIMITS, physicalCopySize, type PhysicalCopySize } from './physicalCopy';
import {
  prepareBodyStretch,
  stretchMapping,
  type PreparedBodyStretch,
  type StretchPlane,
} from './stretchGeometry';

type PhysicalRef = Extract<EntityRef, { kind: 'body' | 'instance' }>;
type Node = {
  ref: PhysicalRef;
  world: Mat4;
  children: Node[];
  prepared?: PreparedBodyStretch;
  shift?: Vec3 | null | undefined;
  changed: boolean;
};
interface Work {
  host: DocumentHost;
  revision: number;
  context: DocumentHost['context'];
  root: Node;
  scope: 'placement' | 'shared';
  signal?: AbortSignal;
}
export interface PhysicalStretchOptions {
  planes: readonly StretchPlane[];
  anchor?: Vec3;
  scope?: 'placement' | 'shared';
  signal?: AbortSignal;
  deadline?: number;
}
export interface PhysicalStretchResult {
  ref: PhysicalRef;
  refs: PhysicalRef[];
  changes: ContainerIdentityChange[];
}
export interface PreparedPhysicalStretch {
  token: string;
  size: PhysicalCopySize;
  bounds: Box3;
  changed: boolean;
  dispose(): void;
}
const prepared = new Map<string, Work>();
function fail(reason: string, message: string): never {
  throw new PushFormError(`stretch.${reason}`, message);
}
function actualRef(ref: PhysicalRef, changes: readonly ContainerIdentityChange[]): PhysicalRef {
  let id: number = ref.id,
    path = [...ref.path];
  for (const change of changes)
    if (change.prefix.every((id, i) => path[i] === id)) {
      id = change.ids.get(id) ?? id;
      path = path.map((id) => (change.ids.get(id) ?? id) as Id);
    }
  return { kind: ref.kind, id: id as Id, path };
}
function ownedId(
  id: number,
  path: readonly Id[],
  changes: readonly ContainerIdentityChange[],
): number {
  let next = id,
    at = [...path];
  for (const change of changes)
    if (change.prefix.every((id, i) => at[i] === id)) {
      next = change.ids.get(next) ?? next;
      at = at.map((id) => (change.ids.get(id) ?? id) as Id);
    }
  return next;
}

/** Captures and validates a complete native solid assembly; the returned receipt is host-only. */
export async function preparePhysicalStretch(
  host: DocumentHost,
  kernel: KernelClient,
  input: EntityRef,
  options: PhysicalStretchOptions,
): Promise<PreparedPhysicalStretch> {
  options.signal?.throwIfAborted();
  if (input.kind !== 'body' && input.kind !== 'instance')
    fail('target', 'Choose one solid or assembly placement to stretch.');
  const ref: PhysicalRef = { kind: input.kind, id: input.id, path: [...input.path] },
    scope = options.scope ?? 'placement';
  const planes = options.planes.map((p) => ({
    ...p,
    normal: [...p.normal] as Vec3,
    displacement: [...p.displacement] as Vec3,
  }));
  const anchor = options.anchor ? ([...options.anchor] as Vec3) : undefined;
  const mapping = stretchMapping({ world: m4identity(), planes, ...(anchor ? { anchor } : {}) });
  const revision = host.doc.version,
    context = host.context,
    state = host.doc.state;
  captureContainerOccurrence(host, ref.path, scope === 'placement');
  physicalCopySize(host, ref);
  const size: PhysicalCopySize = { entities: 0, vertices: 0 },
    bodies: Node[] = [];
  const visit = (ref: PhysicalRef, ancestry: ReadonlySet<DefId>): Node => {
    if (++size.entities > PHYSICAL_COPY_LIMITS.entities || ref.path.length > 64)
      fail('limit', 'Choose a smaller or less deeply nested assembly to stretch.');
    const container = containerAt(state, ref.path),
      parent = contextMatrix(state, ref.path);
    if (ref.kind === 'body') {
      const body = container.bodies.get(ref.id);
      if (!body || !body.valid || body.locked)
        fail('target', 'Every captured part must be an unlocked, valid solid.');
      size.vertices += body.mesh.verts.length / 3;
      if (size.vertices > PHYSICAL_COPY_LIMITS.vertices)
        fail('limit', 'The complete physical assembly exceeds the stretch geometry budget.');
      const node: Node = { ref, world: parent as Mat4, children: [], changed: false };
      bodies.push(node);
      return node;
    }
    const instance = container.instances.get(ref.id);
    if (!instance || instance.locked)
      fail('target', 'Unlock the captured assembly and its nested placements before stretching.');
    if (ancestry.has(instance.definitionId))
      fail('recursive', 'The captured assembly contains a recursive definition.');
    const definition = state.definitions.get(instance.definitionId);
    if (!definition) fail('target', 'A captured assembly definition is missing.');
    const entities = definition.entities;
    if (
      entities.meshParts.size ||
      entities.sketch.vertices.size ||
      entities.guides.size ||
      entities.images.size ||
      entities.sectionPlanes.size ||
      entities.texts.size ||
      entities.dimensions.size
    )
      fail(
        'contents',
        'This stretch needs native solid parts. Separate drawings, guides, images and imported display meshes from the assembly first.',
      );
    const path = [...ref.path, ref.id],
      next = new Set(ancestry);
    next.add(instance.definitionId);
    const world = m4mul(parent, instance.transform) as Mat4;
    stretchMapping({ world, planes, ...(anchor ? { anchor } : {}) });
    return {
      ref,
      world,
      children: [...entities.bodies.keys()]
        .map((id) => visit({ kind: 'body', id, path }, next))
        .concat(
          [...entities.instances.keys()].map((id) => visit({ kind: 'instance', id, path }, next)),
        ),
      changed: false,
    };
  };
  const root = visit(ref, new Set());
  if (!bodies.length) fail('target', 'The captured assembly has no native solid parts.');
  for (const node of bodies) {
    if (options.deadline !== undefined && Date.now() > options.deadline)
      fail('limit', 'The stretch exceeded its analysis time budget. Choose a smaller assembly.');
    const source = containerAt(state, node.ref.path).bodies.get(node.ref.id)!;
    node.prepared = await prepareBodyStretch(kernel, source, {
      world: node.world,
      planes,
      ...(anchor ? { anchor } : {}),
      tiles: textureTiles(state),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (options.deadline !== undefined && Date.now() > options.deadline)
      fail('limit', 'The stretch exceeded its analysis time budget. Choose a smaller assembly.');
    node.changed = node.prepared.changed;
    const first: Vec3 = [source.mesh.verts[0]!, source.mesh.verts[1]!, source.mesh.verts[2]!];
    const shift = mapping.translation(m4transformPoint(node.world, first));
    const equalShift = (point: Vec3): boolean =>
      v3dist(mapping.translation(m4transformPoint(node.world, point)), shift) <= LENGTH_TOL;
    let uniform = true;
    for (let i = 0; i < source.mesh.verts.length; i += 3)
      if (
        !equalShift([source.mesh.verts[i]!, source.mesh.verts[i + 1]!, source.mesh.verts[i + 2]!])
      ) {
        uniform = false;
        break;
      }
    for (const [fid, graph] of source.imprints)
      for (const p of graph.vertices.values())
        if (!equalShift(basisToWorld(source.faces.get(fid)!.basis, p[0], p[1]))) uniform = false;
    for (const [id, curve] of source.curves)
      if (
        v3dist(
          m4transformDir(
            node.world,
            v3sub(node.prepared.body.curves.get(id)!.center, curve.center),
          ),
          shift,
        ) > LENGTH_TOL
      )
        uniform = false;
    node.shift = uniform ? shift : null;
  }
  const combine = (node: Node): void => {
    if (node.ref.kind === 'body') return;
    node.children.forEach(combine);
    node.changed = node.children.some((child) => child.changed);
    const physical = node.children.filter((child) => child.shift !== undefined);
    const first = physical[0]?.shift;
    node.shift =
      first && physical.every((child) => child.shift && v3dist(child.shift, first) <= LENGTH_TOL)
        ? first
        : physical.length
          ? null
          : undefined;
  };
  combine(root);
  options.signal?.throwIfAborted();
  if (host.doc.version !== revision || host.doc.state !== state || host.context !== context)
    fail(
      'stale',
      'The model or editing context changed while preparing the stretch. Capture it again.',
    );
  const bounds = box3Empty();
  for (const node of bodies) {
    const vertices = node.prepared!.body.mesh.verts;
    for (let i = 0; i < vertices.length; i += 3)
      box3Expand(
        bounds,
        m4transformPoint(node.world, [vertices[i]!, vertices[i + 1]!, vertices[i + 2]!]),
      );
  }
  const token = newGuid();
  prepared.set(token, {
    host,
    revision,
    context,
    root,
    scope,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    token,
    size,
    bounds,
    changed: root.changed,
    dispose: () => {
      prepared.delete(token);
    },
  };
}

function installBody(
  draft: DocumentDraft,
  node: Node,
  changes: readonly ContainerIdentityChange[],
): PhysicalRef {
  const ref = actualRef(node.ref, changes),
    container = draftContainerAt(draft, ref.path),
    current = container.bodies.get(ref.id)!;
  const source = node.prepared!.source,
    result = node.prepared!.body;
  const faces = new Map<number, number>(),
    edges = new Map<string, string>();
  for (const id of source.faces.keys()) {
    const target = continueTopologyElement(result, {
      kind: 'face',
      faceId: id,
      bodyVersion: source.version,
    });
    if (target?.kind === 'face') faces.set(id, target.faceId);
  }
  for (const key of source.edges.keys()) {
    const target = continueTopologyElement(result, {
      kind: 'edge',
      edgeKey: key,
      bodyVersion: source.version,
    });
    if (target?.kind === 'edge') edges.set(key, target.edgeKey);
  }
  const body: Body = structuredClone(result);
  body.id = current.id;
  body.version = current.version + 1;
  const curveId = (id: CurveId): CurveId => ownedId(id, node.ref.path, changes) as CurveId;
  const surfaceId = (id: SurfaceId): SurfaceId => ownedId(id, node.ref.path, changes) as SurfaceId;
  body.curves = new Map(
    [...body.curves].map(([id, curve]) => {
      const next = curveId(id);
      return [next, { ...curve, id: next }];
    }),
  );
  body.surfaces = new Map(
    [...body.surfaces].map(([id, surface]) => {
      const next = surfaceId(id);
      return [
        next,
        {
          ...surface,
          id: next,
          curveId: surface.curveId === null ? null : curveId(surface.curveId),
        },
      ];
    }),
  );
  for (const edge of body.edges.values())
    if (edge.curveId !== null) edge.curveId = curveId(edge.curveId);
  for (const graph of body.imprints.values())
    for (const edge of graph.edges.values())
      if (edge.curveId !== null) edge.curveId = curveId(edge.curveId);
  for (const face of body.faces.values())
    if (face.surfaceId !== null) face.surfaceId = surfaceId(face.surfaceId);
  recordTopologyContinuation(current.mesh, current.version, body.mesh, body.version, faces, edges);
  container.bodies.set(ref.id, body);
  return ref;
}

/** Consume a trusted precomputed result inside the caller's ordinary native Undo transaction. */
export const physicalStretch = defineCommand({
  id: 'part.stretch',
  title: 'Stretch Physical Entity',
  category: 'internal',
  undoable: true,
  params: z.object({ prepared: z.string() }),
  run(ctx, input): PhysicalStretchResult {
    const host = hostOf(ctx),
      work = prepared.get(input.prepared);
    prepared.delete(input.prepared);
    if (!work || work.host !== host)
      fail('receipt', 'This stretch was not prepared by this document host.');
    work.signal?.throwIfAborted();
    if (host.doc.version !== work.revision || host.context !== work.context)
      fail(
        'stale',
        'The model or editing context changed after preparing the stretch. Capture it again.',
      );
    const { root, scope } = work;
    captureContainerOccurrence(host, root.ref.path, scope === 'placement');
    if (!root.changed) return { ref: root.ref, refs: [], changes: [] };
    return host.edit('Stretch Physical Entity', (draft) => {
      const changes: ContainerIdentityChange[] = [],
        refs: PhysicalRef[] = [];
      const minimum =
        scope === 'shared' ? root.ref.path.length + (root.ref.kind === 'instance' ? 1 : 0) : 0;
      const apply = (node: Node, isRoot = false): void => {
        if (!node.changed) return;
        work.signal?.throwIfAborted();
        const ref = actualRef(node.ref, changes);
        const rigidInstance =
          ref.kind === 'instance' && node.shift && !(isRoot && scope === 'shared');
        const path = ref.kind === 'instance' && !rigidInstance ? [...ref.path, ref.id] : ref.path;
        const isolated = isolateContainerOccurrence(draft, path, Math.min(minimum, path.length));
        changes.push(...isolated.changes);
        if (rigidInstance) {
          const actual = actualRef(node.ref, changes),
            container = draftContainerAt(draft, actual.path),
            instance = container.instances.get(actual.id)!;
          const parent = contextMatrix(draft as unknown as DocumentState, actual.path),
            inverse = m4invert(parent);
          if (!inverse) fail('frame', 'The captured assembly transform is singular.');
          instance.transform = m4mul(
            inverse,
            m4mul(m4translation(node.shift!), m4mul(parent, instance.transform)),
          ) as Mat4;
          refs.push(actual);
        } else if (ref.kind === 'body') refs.push(installBody(draft, node, changes));
        else node.children.forEach((child) => apply(child));
      };
      apply(root, true);
      work.signal?.throwIfAborted();
      return { ref: actualRef(root.ref, changes), refs, changes };
    });
  },
});
