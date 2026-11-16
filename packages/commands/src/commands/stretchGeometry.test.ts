// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  basisToWorld,
  m4identity,
  m4transformPoint,
  meshBounds,
  meshBox,
  planeBasis,
  v3dist,
  type CurveId,
  type Id,
  type Mat4,
  type MeshData,
  type Vec3,
} from '@pushform/core';
import { tessellateArc, tessellateCircle } from '@pushform/geom';
import { InlineBackend, KernelClient, meshTopologyProblems } from '@pushform/kernel';
import {
  allocId,
  bodyFromMesh,
  createDocument,
  createImprintGraph,
  type Body,
  type DocumentDraft,
} from '@pushform/model';
import { attachProfileCurves } from './profileCurves';
import { prepareBodyStretch, stretchMapping, type StretchPlane } from './stretchGeometry';

const kernels: KernelClient[] = [];
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.dispose();
});
function kernel(): KernelClient {
  const result = new KernelClient(new InlineBackend());
  kernels.push(result);
  return result;
}
function body(
  mesh = meshBox([0, 0, 0], [1, 1, 1]),
  decorate?: (draft: DocumentDraft, body: Body) => void,
): Body {
  const doc = createDocument();
  const id = doc.transact('Fixture', (draft) => {
    const result = bodyFromMesh(draft, mesh, {
      container: draft.definitions.get(draft.rootDefinitionId)!.entities,
    });
    decorate?.(draft, result);
    return result.id;
  }).value;
  return doc.rootDefinition.entities.bodies.get(id)!;
}
const plane = (axis: 0 | 1 | 2, offset: number, amount: number): StretchPlane => {
  const normal: [number, number, number] = [0, 0, 0],
    displacement: [number, number, number] = [0, 0, 0];
  normal[axis] = 1;
  displacement[axis] = amount;
  return { normal, offset, side: 'positive', displacement };
};
async function extrude(k: KernelClient, rings: Vec3[][], height: number): Promise<MeshData> {
  const result = await k.extrudeSketch({
    basis: planeBasis([0, 0, 0], [0, 0, 1]),
    polygon: rings.map((ring) => ring.map((p) => [p[0], p[1]])),
    distance: height,
    nextFaceId: 0,
  });
  expect(result.components).toHaveLength(1);
  return result.components[0]!.mesh;
}
async function cylinder(k: KernelClient): Promise<Body> {
  const ring = tessellateCircle([0, 0, 0], [0, 0, 1], 1, 24, Math.PI / 24).points;
  const mesh = await extrude(k, [ring], 1);
  return body(mesh, (draft, b) =>
    attachProfileCurves(draft, b, { points: ring, normal: [0, 0, 1], offset: [0, 0, 1] }),
  );
}

describe('native stretch preparation', () => {
  it('classifies original coordinates simultaneously and keeps the chosen anchor fixed', () => {
    const planes = [plane(0, 0.4, 0.5), plane(0, 0.8, 0.25)];
    const a = stretchMapping({ world: m4identity(), planes }),
      b = stretchMapping({ world: m4identity(), planes: [...planes].reverse() });
    expect(a.point([0.6, 0, 0])).toEqual([1.1, 0, 0]);
    expect(b.point([0.6, 0, 0])).toEqual(a.point([0.6, 0, 0]));
    const anchored = stretchMapping({ world: m4identity(), planes, anchor: [1, 0, 0] });
    expect(anchored.point([1, 0, 0])).toEqual([1, 0, 0]);
    expect(anchored.point([0, 0, 0])).toEqual([-0.75, 0, 0]);
  });

  it('validates a longer solid while retaining decorations and the captured source', async () => {
    const source = body(undefined, (_draft, b) => {
      b.referenceFrame = m4identity() as Mat4;
      b.attributes = { fixture: { owner: 'fixture', value: 7 } };
      const edge = [...b.edges.values()][0]!;
      edge.soft = true;
      edge.smooth = true;
      edge.hidden = true;
      [...b.faces.values()][0]!.uv = { kind: 'affine', matrix: [2, 0, 0, 3, 0.2, 0.3] };
    });
    const before = structuredClone(source),
      k = kernel(),
      upload = vi.spyOn(k, 'ensureBody');
    const result = await prepareBodyStretch(k, source, {
      world: m4identity(),
      planes: [plane(0, 0.5, 0.75)],
    });
    expect(result.source).toBe(source);
    expect(result.body).not.toBe(source);
    expect(result.changed).toBe(true);
    expect(source).toEqual(before);
    expect(upload).not.toHaveBeenCalled();
    expect(meshBounds(result.body.mesh).max).toEqual([1.75, 1, 1]);
    expect(result.body.props.volume).toBeCloseTo(1.75, 8);
    expect(result.body.version).toBe(source.version + 1);
    expect(result.body.referenceFrame).toEqual(source.referenceFrame);
    expect(result.body.attributes).toEqual(source.attributes);
    expect(
      [...result.body.edges.values()].filter((e) => e.soft && e.smooth && e.hidden),
    ).toHaveLength(1);
    expect(meshTopologyProblems(result.body.mesh)).toEqual([]);
  });

  it('lengthens an extrusion while retaining exact curve IDs, radii, grouped edges and its surface', async () => {
    const k = kernel(),
      source = await cylinder(k);
    const result = (
      await prepareBodyStretch(k, source, { world: m4identity(), planes: [plane(2, 0.5, 2)] })
    ).body;
    expect(meshTopologyProblems(result.mesh)).toEqual([]);
    expect(result.props.volume).toBeCloseTo(source.props.volume * 3, 7);
    expect([...result.curves.keys()]).toEqual([...source.curves.keys()]);
    for (const [id, curve] of result.curves) {
      const old = source.curves.get(id)!;
      expect(curve.kind).toBe('circle');
      expect(curve.radius).toBe(old.radius);
      expect(curve.center[2]).toBeCloseTo(old.center[2] > 0.5 ? 3 : 0, 8);
      expect(curve.edgeRefs).toHaveLength(24);
      expect(
        curve.edgeRefs.every(
          (ref) => typeof ref === 'string' && result.edges.get(ref as never)?.curveId === id,
        ),
      ).toBe(true);
    }
    expect([...result.surfaces.keys()]).toEqual([...source.surfaces.keys()]);
    expect([...result.surfaces.values()][0]!.faceIds).toHaveLength(24);
  });

  it('carries the manufacturing reference origin when the entire body translates', async () => {
    const source = body();
    const result = (
      await prepareBodyStretch(kernel(), source, { world: m4identity(), planes: [plane(0, -1, 2)] })
    ).body;
    expect(meshBounds(result.mesh).min).toEqual([2, 0, 0]);
    expect(m4transformPoint(result.referenceFrame!, [0, 0, 0])).toEqual([2, 0, 0]);
    expect(source.referenceFrame).toBeUndefined();
  });

  it('refuses an analytic circle crossing hidden between sampled vertices before invoking Manifold', async () => {
    const k = kernel(),
      source = await cylinder(k),
      run = vi.spyOn(k, 'autofold'),
      before = structuredClone(source);
    expect(meshBounds(source.mesh).max[0]).toBeLessThan(0.997);
    await expect(
      prepareBodyStretch(k, source, { world: m4identity(), planes: [plane(0, 0.997, 0.2)] }),
    ).rejects.toMatchObject({ code: 'stretch.curveCrossing' });
    expect(run).not.toHaveBeenCalled();
    expect(source).toEqual(before);
  });

  it('uses the complete affine occurrence frame for curve protection and local displacement', async () => {
    const k = kernel(),
      source = await cylinder(k);
    const world: Mat4 = [-2, 0, 0, 0, 0.5, 3, 0, 0, 0.2, 0, 0.5, 0, 4, -2, 1, 1];
    const result = (
      await prepareBodyStretch(k, source, {
        world,
        planes: [
          { normal: [0, 0, 1], offset: 1.25, side: 'positive', displacement: [0.4, 0.3, 1] },
        ],
      })
    ).body;
    for (const [id, curve] of result.curves) {
      const old = source.curves.get(id)!,
        before = m4transformPoint(world, old.center),
        after = m4transformPoint(world, curve.center);
      expect(
        v3dist(
          after,
          old.center[2] > 0.5 ? [before[0] + 0.4, before[1] + 0.3, before[2] + 1] : before,
        ),
      ).toBeLessThan(1e-6);
      expect(curve.radius).toBe(old.radius);
    }
    const run = vi.spyOn(k, 'autofold');
    run.mockClear();
    await expect(
      prepareBodyStretch(k, source, {
        world,
        planes: [{ normal: [1, 0, 0], offset: 4, side: 'positive', displacement: [0.5, 0, 0] }],
      }),
    ).rejects.toMatchObject({ code: 'stretch.curveCrossing' });
    expect(run).not.toHaveBeenCalled();
  });

  it('moves a drilled hole intact instead of scaling its radius', async () => {
    const k = kernel(),
      ring = tessellateCircle([0.75, 0.5, 0], [0, 0, 1], 0.1, 24).points;
    const mesh = await extrude(
      k,
      [
        [
          [0, 0, 0],
          [2, 0, 0],
          [2, 1, 0],
          [0, 1, 0],
        ],
        [...ring].reverse(),
      ],
      0.1,
    );
    const source = body(mesh, (draft, b) =>
      attachProfileCurves(draft, b, { points: ring, normal: [0, 0, 1], offset: [0, 0, 0.1] }),
    );
    const result = (
      await prepareBodyStretch(k, source, { world: m4identity(), planes: [plane(0, 0.5, 1)] })
    ).body;
    expect(result.props.volume).toBeCloseTo(source.props.volume + 0.1, 8);
    for (const [id, curve] of result.curves) {
      expect(curve.radius).toBe(source.curves.get(id)!.radius);
      expect(curve.center[0]).toBeCloseTo(1.75, 8);
    }
    expect(meshTopologyProblems(result.mesh)).toEqual([]);
  });

  function markedBody(segments: number): Body {
    return body(meshBox([0, 0, 0], [4, 4, 1]), (draft, b) => {
      const face = [...b.faces.values()].find((face) => face.plane.n[2] > 0.9)!,
        graph = createImprintGraph();
      const arc = tessellateArc([2, 2, 1], [0, 0, 1], 1, Math.PI / 4, (3 * Math.PI) / 4, segments),
        id = allocId<CurveId>(draft);
      arc.points.forEach((p, i) => {
        const q = [p[0] - face.basis.origin[0], p[1] - face.basis.origin[1]];
        graph.vertices.set(i, [q[0]!, q[1]!]);
      });
      for (let i = 0; i < segments; i++)
        graph.edges.set(i, {
          id: i,
          a: i,
          b: i + 1,
          soft: false,
          smooth: false,
          hidden: false,
          curveId: id,
        });
      graph.nativeUnknownFields = [new Uint8Array([255, 0, 128])];
      graph.nextId = segments + 1;
      b.imprints.set(face.id, graph);
      b.curves.set(id, { id, ...arc.curve, edgeRefs: [...graph.edges.keys()] as Id[] });
    });
  }

  it('moves an entire arc using its points rather than incorrectly classifying its center, and retains imprint bytes', async () => {
    const source = markedBody(8),
      result = (
        await prepareBodyStretch(kernel(), source, {
          world: m4identity(),
          planes: [plane(1, 2.5, 1)],
        })
      ).body;
    const curve = [...result.curves.values()][0]!;
    expect(curve.center).toEqual([2, 3, 1]);
    expect(curve.radius).toBe(1);
    expect(curve.kind).toBe('arc');
    expect(curve.edgeRefs).toHaveLength(8);
    const [fid, graph] = [...result.imprints][0]!;
    expect(graph.nativeUnknownFields).toEqual([new Uint8Array([255, 0, 128])]);
    const face = result.faces.get(fid)!;
    expect(basisToWorld(face.basis, ...graph.vertices.get(4)!)).toEqual([2, 4, 1]);
    expect(graph.version).toBe([...source.imprints.values()][0]!.version + 1);
  });

  it('checks arc extrema between endpoints rather than extending the check to an unused circle', async () => {
    const source = markedBody(1),
      k = kernel(),
      run = vi.spyOn(k, 'autofold');
    await expect(
      prepareBodyStretch(k, source, { world: m4identity(), planes: [plane(1, 2.99, 1)] }),
    ).rejects.toMatchObject({ code: 'stretch.curveCrossing' });
    expect(run).not.toHaveBeenCalled();
    await expect(
      prepareBodyStretch(k, source, { world: m4identity(), planes: [plane(1, 2.5, 1)] }),
    ).resolves.toMatchObject({ changed: true });
  });

  it('retains a move affecting only interior machining marks even when outer vertices stay put', async () => {
    const source = markedBody(8);
    const result = await prepareBodyStretch(kernel(), source, {
      world: m4identity(),
      planes: [plane(1, 2.5, 1), plane(1, 3.5, -1)],
    });
    expect(result.changed).toBe(true);
    expect(meshBounds(result.body.mesh)).toEqual(meshBounds(source.mesh));
    expect(result.body.props.volume).toBeCloseTo(source.props.volume, 8);
    expect([...result.body.curves.values()][0]!.center).toEqual([2, 3, 1]);
  });

  it('refuses collapsed machining marks even if the enclosing solid remains valid', async () => {
    const source = body(undefined, (_draft, b) => {
      const face = [...b.faces.values()].find((face) => face.plane.n[2] > 0.9)!,
        graph = createImprintGraph();
      graph.vertices.set(0, [0.5, 0.4]);
      graph.vertices.set(1, [0.5, 0.6]);
      graph.edges.set(0, {
        id: 0,
        a: 0,
        b: 1,
        soft: false,
        smooth: false,
        hidden: false,
        curveId: null,
      });
      b.imprints.set(face.id, graph);
    });
    const before = structuredClone(source);
    await expect(
      prepareBodyStretch(kernel(), source, { world: m4identity(), planes: [plane(1, 0.5, -0.2)] }),
    ).rejects.toMatchObject({ code: 'stretch.imprint' });
    expect(source).toEqual(before);
  });

  it('refuses a tangent plane that would tear a protected curve at its stationary boundary', async () => {
    const k = kernel(),
      source = await cylinder(k);
    await expect(
      prepareBodyStretch(k, source, { world: m4identity(), planes: [plane(0, -1, 0.2)] }),
    ).rejects.toMatchObject({ code: 'stretch.curveCrossing' });
    const result = await prepareBodyStretch(k, source, {
      world: m4identity(),
      planes: [{ ...plane(0, -1, 0.2), side: 'negative' }],
    });
    expect(result.changed).toBe(false);
    expect(result.body).toBe(source);
  });

  it('retains the original body when kernel validation refuses collapse or cancellation arrives after preparation', async () => {
    const source = body(),
      before = structuredClone(source),
      k = kernel();
    await expect(
      prepareBodyStretch(k, source, { world: m4identity(), planes: [plane(0, 0.5, -1)] }),
    ).rejects.toMatchObject({ code: 'stretch.invalidSolid' });
    expect(source).toEqual(before);
    const abort = new AbortController(),
      run = k.autofold.bind(k);
    vi.spyOn(k, 'autofold').mockImplementation(async (params) => {
      const result = await run(params);
      abort.abort();
      return result;
    });
    await expect(
      prepareBodyStretch(k, source, {
        world: m4identity(),
        planes: [plane(0, 0.5, 1)],
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(source).toEqual(before);
  });

  it('refuses invalid frames, planes and incomplete curve ownership before kernel work', async () => {
    const k = kernel(),
      source = await cylinder(k),
      run = vi.spyOn(k, 'autofold');
    await expect(
      prepareBodyStretch(k, source, {
        world: new Array(16).fill(0) as unknown as Mat4,
        planes: [plane(0, 0.5, 1)],
      }),
    ).rejects.toMatchObject({ code: 'stretch.frame' });
    await expect(
      prepareBodyStretch(k, source, {
        world: m4identity(),
        planes: [{ ...plane(0, 0.5, 1), normal: [2, 0, 0] }],
      }),
    ).rejects.toMatchObject({ code: 'stretch.planes' });
    const broken = structuredClone(source);
    [...broken.curves.values()][0]!.edgeRefs = ['999:1000:0'];
    await expect(
      prepareBodyStretch(k, broken, { world: m4identity(), planes: [plane(2, 0.5, 1)] }),
    ).rejects.toMatchObject({ code: 'stretch.curve' });
    expect(run).not.toHaveBeenCalled();
  });
});
