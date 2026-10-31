// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox } from '@pushform/core';
import type { Id, TagFolderId, TagId } from '@pushform/core';
import { SketchGraph, bodyFromMesh, createDocument } from '@pushform/model';
import type { Tag, TagFolder } from '@pushform/model';
import { bodiesToRender, colorByTagOn, fogToRender, guidesToRender, horizonColor, shadowsToRender, sketchToRender, tagStyleToken, taggedBodyEdges, tagVisible } from './renderAdapter';

function docWithTaggedContent() {
  const doc = createDocument();
  let tagId = 0 as TagId, folderId = 0 as TagFolderId, bodyId = 0 as Id, edgeId = 0 as Id, guideId = 0 as Id;
  doc.transact('content', (draft) => {
    tagId = draft.meta.nextId++ as TagId;
    const tag: Tag = { id: tagId, name: 'T', visible: true, color: [1, 0, 0], dashes: 'dot', folderId: null };
    draft.tags.set(tagId, tag as never);
    folderId = draft.meta.nextId++ as TagFolderId;
    const folder: TagFolder = { id: folderId, name: 'F', visible: true, parentId: null };
    draft.tagFolders.set(folderId, folder);
    const root = draft.definitions.get(draft.rootDefinitionId)!;
    bodyId = bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: root.entities, tagId }).id;
    bodyFromMesh(draft, meshBox([3, 3, 3], [4, 4, 4]), { container: root.entities });
    const g = SketchGraph.for(draft);
    edgeId = g.addEdge([5, 0, 0], [6, 0, 0], { tagId })[0]!;
    g.addEdge([7, 0, 0], [8, 0, 0]);
    guideId = draft.meta.nextId++ as Id;
    root.entities.guides.set(guideId, { id: guideId, kind: 'point', origin: [1, 1, 1], tagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {} });
  });
  return { doc, tagId, folderId, bodyId, edgeId, guideId };
}

describe('tag visibility in the render adapter', () => {
  it('hides bodies, sketch edges and guides whose tag (or folder) is off', () => {
    const { doc, tagId, folderId, bodyId, edgeId, guideId } = docWithTaggedContent();
    expect(bodiesToRender(doc.state)).toHaveLength(2);
    expect(sketchToRender(doc.state)!.edges.map((e) => e.id)).toContain(edgeId);
    expect(guidesToRender(doc.state).points.map((p) => p.id)).toEqual([guideId]);
    doc.transact('hide tag', (draft) => {
      draft.tags.get(tagId)!.visible = false;
    });
    expect(tagVisible(doc.state, tagId)).toBe(false);
    expect(bodiesToRender(doc.state).map((b) => b.entityId)).not.toContain(bodyId);
    expect(sketchToRender(doc.state)!.edges.map((e) => e.id)).not.toContain(edgeId);
    expect(sketchToRender(doc.state)!.edges).toHaveLength(1);
    expect(guidesToRender(doc.state).points).toHaveLength(0);
    // folder visibility cascades
    doc.transact('folder', (draft) => {
      draft.tags.get(tagId)!.visible = true;
      draft.tags.get(tagId)!.folderId = folderId;
      draft.tagFolders.get(folderId)!.visible = false;
    });
    expect(tagVisible(doc.state, tagId)).toBe(false);
    expect(bodiesToRender(doc.state)).toHaveLength(1);
    doc.transact('folder on', (draft) => {
      draft.tagFolders.get(folderId)!.visible = true;
    });
    expect(bodiesToRender(doc.state)).toHaveLength(2);
    // the sketch version token changes with tag state so the renderer rebuilds
    const v1 = sketchToRender(doc.state)!.version;
    expect(sketchToRender(doc.state)!.version).toBe(v1);
    doc.transact('hide again', (draft) => {
      draft.tags.get(tagId)!.visible = false;
    });
    expect(sketchToRender(doc.state)!.version).not.toBe(v1);
  });

  it('tag dashes reach body and sketch edges; Color by Tag colors faces and edges', () => {
    const { doc, tagId, bodyId } = docWithTaggedContent();
    const body = () => doc.rootDefinition.entities.bodies.get(bodyId)!;
    const edges1 = taggedBodyEdges(doc.state, body());
    expect(edges1.every((e) => e.dashes === 'dot' && e.color === undefined)).toBe(true);
    expect(taggedBodyEdges(doc.state, body())).toBe(edges1); // cached per tag token
    const tagged = sketchToRender(doc.state)!.edges.find((e) => e.dashes === 'dot');
    expect(tagged).toBeDefined();
    expect(colorByTagOn(doc.state)).toBe(false);
    const rb = bodiesToRender(doc.state).find((b) => b.entityId === bodyId)!;
    expect(rb.defaultColor).toBeUndefined();
    expect(rb.castShadows).toBe(true);
    const token = tagStyleToken(doc.state);
    doc.transact('color by tag', (draft) => {
      draft.styles.get(draft.activeStyleId)!.modeling.colorByTag = true;
    });
    expect(tagStyleToken(doc.state)).not.toBe(token);
    const rb2 = bodiesToRender(doc.state).find((b) => b.entityId === bodyId)!;
    expect(rb2.defaultColor).toBe('#ff0000');
    expect(rb2.edges!.every((e) => e.color === '#ff0000')).toBe(true);
    // the untagged box takes the default tag color
    const other = bodiesToRender(doc.state).find((b) => b.entityId !== bodyId)!;
    expect(other.defaultColor).toBe('#4d4d4d');
    expect(sketchToRender(doc.state)!.edges.find((e) => e.color === '#ff0000')).toBeDefined();
    // hidden tag on an edge-level tag marks the edge hidden
    doc.transact('edge tag', (draft) => {
      const b = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(bodyId)!;
      const first = b.edges.keys().next().value!;
      b.edges.get(first)!.tagId = draft.defaultTagId;
      draft.tags.get(tagId)!.visible = false;
    });
    expect(bodiesToRender(doc.state).find((b) => b.entityId === bodyId)).toBeUndefined();
    doc.transact('show body tag', (draft) => {
      draft.tags.get(tagId)!.visible = true;
      draft.tags.get(draft.defaultTagId)!.visible = false;
    });
    const rb3 = bodiesToRender(doc.state).find((b) => b.entityId === bodyId)!;
    expect(rb3.edges!.filter((e) => e.hidden)).toHaveLength(1);
  });
});

describe('shadowsToRender / fogToRender', () => {
  it('maps document shadow settings to a sun direction and flags', () => {
    const doc = createDocument();
    const s0 = shadowsToRender(doc.state);
    expect(s0.enabled).toBe(false);
    expect(s0).toMatchObject({ light: 80, dark: 45, onFaces: true, onGround: true, fromEdges: false, useSunForShading: true });
    // default: Nov 8, 13:30 in Boulder → sun up, from the south-west-ish
    expect(s0.sunUp).toBe(true);
    expect(s0.sunDirection[2]).toBeGreaterThan(0.3);
    expect(s0.sunDirection[1]).toBeLessThan(0); // sun to the south → direction has -Y
    doc.transact('night', (draft) => {
      draft.shadows = { ...draft.shadows, enabled: true, time: 2 * 60 };
    });
    const night = shadowsToRender(doc.state);
    expect(night.enabled).toBe(true);
    expect(night.sunUp).toBe(false);
    expect(night.sunDirection[2]).toBeLessThan(0);
    doc.transact('north', (draft) => {
      draft.shadows = { ...draft.shadows, time: 12 * 60 + 60, northAngle: 180 };
    });
    expect(shadowsToRender(doc.state).sunDirection[1]).toBeGreaterThan(0);
  });

  it('fog uses the style background color when asked, else its own', () => {
    const doc = createDocument();
    // the default style draws a half-transparent beige ground, so the horizon is a little off white
    expect(fogToRender(doc.state)).toEqual({ enabled: false, near: 0, far: 100, color: '#eeece6' });
    doc.transact('fog', (draft) => {
      draft.fog = { enabled: true, near: 1, far: 20, useBackground: false, color: [0, 0.5, 1] };
    });
    expect(fogToRender(doc.state)).toEqual({ enabled: true, near: 1, far: 20, color: '#0080ff' });
    doc.transact('bg', (draft) => {
      draft.fog = { ...draft.fog!, useBackground: true };
      const bg = draft.styles.get(draft.activeStyleId)!.background;
      bg.color = [0, 0, 0];
      bg.ground = false;
    });
    expect(fogToRender(doc.state).color).toBe('#000000');
  });

  it('fades toward the ground color seen at the horizon, by how opaque the ground is', () => {
    const b = { color: [1, 1, 1], ground: true, groundColor: [0, 0, 0], groundTransparency: 0 } as const;
    expect(horizonColor(b)).toEqual([0.55, 0.55, 0.55]);
    expect(horizonColor({ ...b, groundTransparency: 1 })).toEqual([1, 1, 1]);
    expect(horizonColor({ ...b, ground: false })).toEqual([1, 1, 1]);
  });
});
