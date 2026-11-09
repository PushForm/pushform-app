// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  CommandRegistry,
  PHYSICAL_COPY_LIMITS,
  SERVICE_DOCUMENT,
  SERVICE_KERNEL,
  modelCommands,
  preparePhysicalStretch,
  transformCommands,
  type StretchPlane,
} from '@pushform/commands';
import {
  ANGLE_TOL,
  LENGTH_TOL,
  m4identity,
  m4invert,
  m4mul,
  m4transformPoint,
  v3dot,
  v3len,
  type DefId,
  type Mat4,
  type MMat4,
  type Vec3,
} from '@pushform/core';
import { ExtensionError, type FragmentProjection } from '@pushform/extension-protocol';
import { toMeshWire, type KernelClient } from '@pushform/kernel';
import { containerAt, type Body } from '@pushform/model';
import { refreshNativeModelFragment, type NativeModelFragment } from './modelFragments';

export type ProjectionAxes = [Vec3, Vec3, Vec3];
const invalid = (message: string): never => {
  throw new ExtensionError('validation.failed', message);
};
export function validateProjectionAxes(axes: ProjectionAxes): void {
  if (
    axes.length !== 3 ||
    axes.some(
      (axis) =>
        axis.length !== 3 ||
        axis.some((value) => !Number.isFinite(value)) ||
        Math.abs(v3len(axis) - 1) > ANGLE_TOL,
    ) ||
    Math.abs(v3dot(axes[0], axes[1])) > ANGLE_TOL ||
    Math.abs(v3dot(axes[0], axes[2])) > ANGLE_TOL ||
    Math.abs(v3dot(axes[1], axes[2])) > ANGLE_TOL
  )
    invalid('Choose three finite orthonormal measurement axes.');
}
function validatePose(pose: Mat4 | MMat4): void {
  if (
    pose.length !== 16 ||
    pose.some((value) => !Number.isFinite(value)) ||
    pose[3] !== 0 ||
    pose[7] !== 0 ||
    pose[11] !== 0 ||
    pose[15] !== 1 ||
    !m4invert(pose)?.every(Number.isFinite)
  )
    invalid('Choose a distance-preserving module pose.');
  validateProjectionAxes([
    [pose[0]!, pose[1]!, pose[2]!],
    [pose[4]!, pose[5]!, pose[6]!],
    [pose[8]!, pose[9]!, pose[10]!],
  ]);
}
function check(signal: AbortSignal, deadline: number): void {
  signal.throwIfAborted();
  if (Date.now() > deadline)
    throw new ExtensionError(
      'limit.exceeded',
      'The complete module analysis exceeded its time budget. Choose a smaller module.',
    );
}

/** Complete physical projection, including hidden parts and repeated occurrences, without lossy query outlines. */
export async function projectNativeModelFragment(
  fragment: NativeModelFragment,
  axes: ProjectionAxes,
  signal: AbortSignal,
  deadline = Date.now() + 30_000,
  kernel?: KernelClient,
): Promise<FragmentProjection> {
  validateProjectionAxes(axes);
  check(signal, deadline);
  const state = fragment.host.doc.state,
    rows: { body: Body; matrix: Mat4 | MMat4 }[] = [],
    definitions = new Set<DefId>();
  let entities = 0,
    vertices = 0;
  const visit = (
    definitionId: DefId,
    matrix: Mat4 | MMat4,
    ancestry: ReadonlySet<DefId>,
    depth: number,
  ): void => {
    if (ancestry.has(definitionId) || depth > 64)
      invalid('The module contains a recursive or excessively deep assembly.');
    definitions.add(definitionId);
    if (
      definitions.size > PHYSICAL_COPY_LIMITS.definitions ||
      !m4invert(matrix)?.every(Number.isFinite)
    )
      invalid('The complete module exceeds its definition budget or has an invalid transform.');
    const definition = state.definitions.get(definitionId);
    if (!definition) invalid('A module definition is missing.');
    const into = definition!.entities;
    if (
      into.meshParts.size ||
      into.sketch.vertices.size ||
      into.guides.size ||
      into.images.size ||
      into.sectionPlanes.size ||
      into.texts.size ||
      into.dimensions.size
    )
      invalid(
        'Module fitting needs native solid parts. Separate drawings, guides, images and imported display meshes first.',
      );
    entities += into.bodies.size + into.instances.size;
    if (entities > PHYSICAL_COPY_LIMITS.entities)
      invalid('The complete physical module exceeds its entity budget.');
    for (const body of into.bodies.values()) {
      if (!body.valid || !body.mesh.verts.length)
        invalid('The module contains an invalid or empty native solid.');
      vertices += body.mesh.verts.length / 3;
      if (vertices > PHYSICAL_COPY_LIMITS.vertices)
        invalid('The complete physical module exceeds its geometry budget.');
      rows.push({ body, matrix });
    }
    const next = new Set(ancestry);
    next.add(definitionId);
    for (const instance of into.instances.values())
      visit(instance.definitionId, m4mul(matrix, instance.transform), next, depth + 1);
  };
  const root = containerAt(state, []).instances.get(fragment.root.id);
  if (!root) invalid('The canonical module root is missing.');
  visit(root!.definitionId, root!.transform, new Set(), 0);
  if (!rows.length) invalid('The module contains no measurable native solids.');
  if (kernel)
    for (const body of new Set(rows.map((row) => row.body))) {
      check(signal, deadline);
      const result = await kernel.autofold({
        body: { bodyId: body.id, version: body.version },
        mesh: toMeshWire(body.mesh),
        nextFaceId: body.nextFaceId,
      });
      if (result.components.length !== 1 || !(result.components[0]!.props.volume > 0))
        invalid('The fitted module must retain valid connected solids.');
      check(signal, deadline);
    }
  const min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let counted = 0;
  for (const { body, matrix } of rows)
    for (let i = 0; i < body.mesh.verts.length; i += 3) {
      if (++counted % 20_000 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        check(signal, deadline);
      }
      const point = m4transformPoint(matrix, [
        body.mesh.verts[i]!,
        body.mesh.verts[i + 1]!,
        body.mesh.verts[i + 2]!,
      ]);
      if (point.some((value) => !Number.isFinite(value)))
        invalid('The module exceeds the supported coordinate range.');
      for (const axis of [0, 1, 2] as const) {
        const value = v3dot(axes[axis], point);
        if (!Number.isFinite(value)) invalid('The module exceeds the supported projection range.');
        min[axis] = Math.min(min[axis], value);
        max[axis] = Math.max(max[axis], value);
      }
    }
  check(signal, deadline);
  if (max.some((value, axis) => !Number.isFinite(value - min[axis]!)))
    invalid('The module exceeds the supported measurement range.');
  return {
    axes: axes.map((axis) => [...axis]) as FragmentProjection['axes'],
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

export interface NativeFragmentFitInput {
  axes: ProjectionAxes;
  size: Vec3;
  pose?: Mat4 | MMat4;
  planes: readonly StretchPlane[];
  anchor?: Vec3;
}
/** Only call with a newly decoded private clone; no original snapshot or live document is edited. */
export async function fitNativeModelFragment(
  fragment: NativeModelFragment,
  input: NativeFragmentFitInput,
  kernel: KernelClient,
  signal: AbortSignal,
): Promise<{ fragment: NativeModelFragment; projection: FragmentProjection }> {
  const deadline = Date.now() + 30_000,
    pose = input.pose ?? m4identity();
  validateProjectionAxes(input.axes);
  validatePose(pose);
  if (
    input.size.length !== 3 ||
    input.size.some((value) => !Number.isFinite(value) || value <= LENGTH_TOL)
  )
    invalid('Choose three positive fitted dimensions.');
  check(signal, deadline);
  const commands = new CommandRegistry({
    tx: fragment.host,
    services: new Map<string, unknown>([
      [SERVICE_DOCUMENT, fragment.host],
      [SERVICE_KERNEL, kernel],
    ]),
  });
  commands.registerAll(modelCommands);
  commands.registerAll(transformCommands);
  await commands.execute('transform.apply', { refs: [fragment.root], matrix: pose });
  check(signal, deadline);
  if (input.planes.length) {
    const work = await preparePhysicalStretch(fragment.host, kernel, fragment.root, {
      planes: input.planes,
      ...(input.anchor ? { anchor: input.anchor } : {}),
      signal,
      deadline,
    });
    try {
      commands.execute('part.stretch', { prepared: work.token });
    } finally {
      work.dispose();
    }
  }
  const result = refreshNativeModelFragment(fragment),
    projection = await projectNativeModelFragment(result, input.axes, signal, deadline, kernel);
  if (projection.size.some((value, axis) => Math.abs(value - input.size[axis]!) > LENGTH_TOL))
    throw new ExtensionError(
      'validation.failed',
      'The authored stretch planes did not produce the requested physical dimensions. Adjust the planes or choose another module.',
    );
  check(signal, deadline);
  return { fragment: result, projection };
}
