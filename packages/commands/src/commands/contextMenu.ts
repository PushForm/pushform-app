// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CurveId, Id, MaterialId, TagId } from '@pushform/core';
import { containerAt, instanceAt, parseEdgeKey } from '@pushform/model';
import type { DocumentState, EntityContainer, EntityRef, UvMapping } from '@pushform/model';
import { connectedSketchRefs, facesUsingEdge } from './sketchQueries';
import { geometryHidden } from './sketch';
import { chainEdges } from './curves';

/**
 * One entry of a right-click menu. Pure data: the UI renders it and runs
 * `command` with `params` through the registry. Items whose command is not registered are
 * shown disabled by the UI; `disabled` marks placeholders for planned entries that have no
 * implementation yet. `separator` draws a divider above the item. `children` is a submenu.
 */
export interface ContextMenuItem {
  readonly label: string;
  readonly command: string;
  readonly params?: unknown;
  readonly disabled?: boolean;
  readonly separator?: boolean;
  readonly children?: readonly ContextMenuItem[];
  /** Shown with a check mark (a toggle that is on). */
  readonly checked?: boolean;
}

export interface ContextMenuOptions {
  /** The open edit context (instance path); empty/undefined = root. Adds "Exit Group" to the empty-space menu. */
  readonly contextPath?: readonly Id[] | undefined;
  /** Active tool id: the Position Texture tool replaces the menu with its pin menu (Done/Reset/Flip/Rotate). */
  readonly activeToolId?: string | null | undefined;
  /** The clipboard holds a copy: enables Paste In Place in the empty-space menu. */
  readonly canPaste?: boolean | undefined;
}

/** Command ids the menu uses that live in other modules (groups/context: agent A; ui.*: the UI layer). */
export const MENU_COMMANDS = {
  entityInfo: 'ui.panel.open',
  softenEdges: 'ui.panel.open',
  makeComponent: 'ui.makeComponent',
  renameInstance: 'ui.renameInstance',
  makeGroup: 'group.make',
  explode: 'group.explode',
  makeUnique: 'component.makeUnique',
  changeAxes: 'component.changeAxesPick',
  unglue: 'component.unglue',
  setHidden: 'instance.setHidden',
  setLocked: 'instance.setLocked',
  hideBodies: 'bodies.setHidden',
  /** Edges and faces of any kind. */
  hideGeometry: 'geometry.setHidden',
  contextEnter: 'context.enter',
  contextExit: 'context.exit',
  erase: 'edit.delete',
  selectAll: 'edit.selectAll',
  zoomExtents: 'camera.zoomExtents',
  pasteInPlace: 'edit.pasteInPlace',
  /** Frames the selection; reverses sketch faces, reporting that faces of a solid cannot be. */
  zoomSelection: 'camera.zoomSelection',
  reverseFaces: 'faces.reverse',
  /** Texture submenu (materials agent): Position (pins tool), Reset Position, Projected (placeholder). */
  texturePosition: 'texture.positionTool',
  textureReset: 'texture.reset',
  textureProjected: 'texture.projected',
  texturePinDone: 'texture.pin.done',
  texturePinReset: 'texture.pin.reset',
  texturePinFlip: 'texture.pin.flip',
  texturePinRotate: 'texture.pin.rotate',
  /** Texts. */
  editText: 'ui.editText',
  textArrow: 'text.setArrow',
  textLeader: 'text.setLeader',
  /** Commands that take parameters, reachable only from these menus. */
  weld: 'sketch.weld',
  explodeCurve: 'sketch.explodeCurve',
  intersectFaces: 'intersect.faces',
  flipAlong: 'edit.flipAlong',
  selectTag: 'tag.selectAll',
  selectMaterial: 'material.selectFaces',
} as const;

/** Solid Tools: the pair operations take the first-selected solid as `a` (the cutter of Subtract and Trim). */
const SOLID_PAIR_TOOLS = [['Union', 'solids.union'], ['Subtract', 'solids.subtract'], ['Trim', 'solids.trim'], ['Intersect', 'solids.intersect'], ['Split', 'solids.split']] as const;
const FLIP_AXES = [['Red', 'x'], ['Green', 'y'], ['Blue', 'z']] as const;

type RefClass = 'edge' | 'face' | 'sketch' | 'body' | 'instance' | 'sectionPlane' | 'text' | 'image' | 'other';

function classOf(ref: EntityRef): RefClass {
  switch (ref.kind) {
    case 'edge':
    case 'sketchEdge':
    case 'imprintEdge':
      return 'edge';
    case 'face':
    case 'sketchFace':
      return 'face';
    case 'sketchVertex':
      return 'sketch';
    case 'body':
      return 'body';
    case 'instance':
      return 'instance';
    case 'sectionPlane':
      return 'sectionPlane';
    case 'text':
      return 'text';
    case 'image':
      return 'image';
    default:
      return 'other';
  }
}

const entityInfo = (): ContextMenuItem => ({ label: 'Entity Info', command: MENU_COMMANDS.entityInfo, params: { id: 'entityInfo' } });
const erase = (): ContextMenuItem => ({ label: 'Erase', command: MENU_COMMANDS.erase });
const makeGroup = (refs: readonly EntityRef[], separator = true): ContextMenuItem => ({
  label: 'Make Group',
  command: MENU_COMMANDS.makeGroup,
  params: { refs },
  separator,
});
const makeComponent = (): ContextMenuItem => ({ label: 'Make Component…', command: MENU_COMMANDS.makeComponent });
const zoomSelection = (): ContextMenuItem => ({ label: 'Zoom Selection', command: MENU_COMMANDS.zoomSelection, separator: true });
const softenSmooth = (): ContextMenuItem => ({ label: 'Soften/Smooth Edges', command: MENU_COMMANDS.softenEdges, params: { id: 'softenEdges' } });

function containerOf(state: DocumentState, ref: EntityRef): EntityContainer | null {
  try {
    return containerAt(state, ref.path);
  } catch {
    return null;
  }
}

function sketchOf(state: DocumentState, ref: EntityRef) {
  return containerOf(state, ref)?.sketch ?? null;
}

/** The tag `tag.selectAll` matches the entity by: a solid's own tag for the solid and its faces and edges. */
function tagOf(state: DocumentState, ref: EntityRef): TagId | null {
  const c = containerOf(state, ref);
  if (!c) return null;
  switch (ref.kind) {
    case 'body':
    case 'face':
    case 'edge':
    case 'imprintEdge':
      return c.bodies.get(ref.id)?.tagId ?? null;
    case 'instance':
      return c.instances.get(ref.id)?.tagId ?? null;
    case 'sketchEdge':
      return c.sketch.edges.get(ref.id)?.tagId ?? null;
    case 'sketchFace':
      return c.sketch.faces.get(ref.id)?.tagId ?? null;
    case 'guide':
      return c.guides.get(ref.id)?.tagId ?? null;
    default:
      return null;
  }
}

/** A face's front material as `material.selectFaces` matches it (null = the default material); undefined for non-faces. */
function frontMaterialOf(state: DocumentState, ref: EntityRef): MaterialId | null | undefined {
  const c = containerOf(state, ref);
  const f = ref.kind === 'face' ? c?.bodies.get(ref.id)?.faces.get(ref.faceId) : ref.kind === 'sketchFace' ? c?.sketch.faces.get(ref.id) : undefined;
  return f ? (f.frontMaterialId ?? null) : undefined;
}

/** The curve an edge belongs to, if any. */
function curveOf(state: DocumentState, ref: EntityRef): CurveId | null {
  const c = containerOf(state, ref);
  if (!c) return null;
  if (ref.kind === 'sketchEdge') return c.sketch.edges.get(ref.id)?.curveId ?? null;
  if (ref.kind === 'edge') return c.bodies.get(ref.id)?.edges.get(ref.edgeKey)?.curveId ?? null;
  if (ref.kind === 'imprintEdge') return c.bodies.get(ref.id)?.imprints.get(ref.faceId)?.edges.get(ref.edgeId)?.curveId ?? null;
  return null;
}

/** The single value every item maps to, or undefined when they differ or there are none. */
function shared<T>(values: readonly T[]): T | undefined {
  return values.length > 0 && values.every((v) => v === values[0]) ? values[0] : undefined;
}

/**
 * Weld Edges and Explode Curve. Weld Edges for two or more sketch edges, available when they form one chain;
 * Explode Curve for edges on curves, available when they all belong to one curve.
 */
function curveItems(state: DocumentState, refs: readonly EntityRef[]): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (refs.length >= 2 && refs.every((r) => r.kind === 'sketchEdge')) {
    const sketch = sketchOf(state, refs[0]!);
    const edges = refs.map((r) => sketch?.edges.get(r.id));
    const chain = edges.every((e) => e !== undefined) ? chainEdges(edges as { id: Id; a: Id; b: Id }[]) : null;
    items.push({ label: 'Weld Edges', command: MENU_COMMANDS.weld, params: { edgeIds: refs.map((r) => r.id) }, disabled: !chain });
  }
  const curves = refs.map((r) => curveOf(state, r));
  if (curves.some((c) => c !== null)) {
    const curve = shared(curves);
    items.push({ label: 'Explode Curve', command: MENU_COMMANDS.explodeCurve, params: { curveId: curve ?? null }, disabled: curve === undefined || curve === null });
  }
  if (items.length) items[0] = { ...items[0]!, separator: true };
  return items;
}

/**
 * `Intersect Faces ›`: With Model needs a selected face; With Selection also needs a selected solid to
 * intersect the faces with.
 */
function intersectSubmenu(refs: readonly EntityRef[]): ContextMenuItem {
  const faces = refs.some((r) => r.kind === 'face' || r.kind === 'sketchFace');
  const bodies = refs.some((r) => r.kind === 'body');
  return {
    label: 'Intersect Faces',
    command: '',
    separator: true,
    children: [
      { label: 'With Model', command: MENU_COMMANDS.intersectFaces, params: { refs, with: 'model' }, disabled: !faces },
      { label: 'With Selection', command: MENU_COMMANDS.intersectFaces, params: { refs, with: 'selection' }, disabled: !faces || !bodies },
    ],
  };
}

/** `Flip Along ›` Red, Green, Blue: mirrors the selection about its centre along a model axis. */
function flipSubmenu(refs: readonly EntityRef[], disabled: boolean): ContextMenuItem {
  return {
    label: 'Flip Along',
    command: '',
    separator: true,
    children: FLIP_AXES.map(([label, axis]) => ({ label, command: MENU_COMMANDS.flipAlong, params: { refs, axis }, disabled })),
  };
}

/** `Solid Tools ›`: the pair operations for exactly two solids, Outer Shell for two or more. */
function solidToolsSubmenu(state: DocumentState, refs: readonly EntityRef[]): ContextMenuItem {
  const bodies = refs.map((r) => ({ kind: 'body' as const, path: [...r.path], id: r.id }));
  const solid = refs.every((r) => containerOf(state, r)?.bodies.get(r.id)?.valid === true);
  return {
    label: 'Solid Tools',
    command: '',
    children: [
      ...SOLID_PAIR_TOOLS.map(([label, command]) => ({ label, command, params: { a: bodies[0], b: bodies[1] }, disabled: !solid || bodies.length !== 2 })),
      { label: 'Outer Shell', command: 'solids.outerShell', params: { bodies }, disabled: !solid || bodies.length < 2 },
    ],
  };
}

/** Faces sharing the edge (sketch: the sketch faces; body: the two faces of the edge key). */
function connectedFaces(state: DocumentState, ref: EntityRef): EntityRef[] {
  const path = ref.path;
  if (ref.kind === 'sketchEdge') {
    const sketch = sketchOf(state, ref);
    return sketch ? facesUsingEdge(sketch, ref.id).map((id): EntityRef => ({ kind: 'sketchFace', path, id })) : [];
  }
  if (ref.kind === 'edge') {
    const { faceA, faceB } = parseEdgeKey(ref.edgeKey);
    return [faceA, faceB].map((faceId): EntityRef => ({ kind: 'face', path, id: ref.id, faceId, region: null }));
  }
  if (ref.kind === 'imprintEdge') return [{ kind: 'face', path, id: ref.id, faceId: ref.faceId, region: null }];
  return [];
}

/** Everything connected: all sketch geometry reachable from the ref, or the whole body. */
function allConnected(state: DocumentState, ref: EntityRef): EntityRef[] {
  if (ref.kind === 'edge' || ref.kind === 'face' || ref.kind === 'imprintEdge' || ref.kind === 'body') {
    return [{ kind: 'body', path: ref.path, id: ref.id }];
  }
  const sketch = sketchOf(state, ref);
  if (!sketch) return [ref];
  const refs = connectedSketchRefs(sketch, ref).map((r) => ({ ...r, path: ref.path }));
  return refs.length ? refs : [ref];
}

function selectSubmenu(state: DocumentState, refs: readonly EntityRef[]): ContextMenuItem {
  const faces = refs.flatMap((r) => [r, ...connectedFaces(state, r)]);
  const all = refs.flatMap((r) => allConnected(state, r));
  // One tag, or faces showing one material in front, selects everything in the open context that matches.
  const tag = shared(refs.map((r) => tagOf(state, r)));
  const material = shared(refs.map((r) => frontMaterialOf(state, r)));
  return {
    label: 'Select',
    command: '',
    children: [
      { label: 'Connected Faces', command: 'selection.set', params: { refs: faces } },
      { label: 'All Connected', command: 'selection.set', params: { refs: all } },
      { label: 'All on Same Tag', command: MENU_COMMANDS.selectTag, params: { id: tag ?? null }, disabled: tag === undefined || tag === null },
      { label: 'All with Same Material', command: MENU_COMMANDS.selectMaterial, params: { id: material ?? null }, disabled: material === undefined },
    ],
  };
}

/** Hide, or Unhide when every selected edge and face is hidden; one step for edges and faces of any kind. */
function hideGeometry(state: DocumentState, refs: readonly EntityRef[]): ContextMenuItem {
  const allHidden = refs.length > 0 && refs.every((r) => geometryHidden(state, r) === true);
  return { label: allHidden ? 'Unhide' : 'Hide', command: MENU_COMMANDS.hideGeometry, params: { refs, hidden: !allHidden } };
}

function edgeItems(state: DocumentState, refs: readonly EntityRef[]): ContextMenuItem[] {
  return [
    entityInfo(),
    erase(),
    hideGeometry(state, refs),
    { ...selectSubmenu(state, refs), separator: true },
    makeGroup(refs),
    makeComponent(),
    intersectSubmenu(refs),
    { ...softenSmooth(), separator: true },
    ...curveItems(state, refs),
    zoomSelection(),
  ];
}

/** Either side of the face has a positioned or distorted texture placement (what Reset Position undoes). */
const pinned = (uv: UvMapping | undefined): boolean => uv?.kind === 'affine' || uv?.kind === 'projective';
const positioned = (f: { readonly uv: UvMapping; readonly uvBack?: UvMapping | undefined }): boolean => pinned(f.uv) || pinned(f.uvBack);

/** Whether each side of a face shows a textured material (own, else the body's), and whether either side is positioned. */
function faceHasTexture(state: DocumentState, ref: EntityRef): { front: boolean; back: boolean; positioned: boolean } {
  const none = { front: false, back: false, positioned: false };
  let c;
  try {
    c = containerAt(state, ref.path);
  } catch {
    return none;
  }
  const textured = (id: MaterialId | null | undefined): boolean => id !== null && id !== undefined && !!state.materials.get(id)?.texture;
  if (ref.kind === 'face') {
    const b = c.bodies.get(ref.id);
    const f = b?.faces.get(ref.faceId);
    if (!b || !f) return none;
    return { front: textured(f.frontMaterialId ?? b.materialId), back: textured(f.backMaterialId ?? b.materialId), positioned: positioned(f) };
  }
  if (ref.kind === 'sketchFace') {
    const f = c.sketch.faces.get(ref.id);
    if (!f) return none;
    return { front: textured(f.frontMaterialId), back: textured(f.backMaterialId), positioned: positioned(f) };
  }
  return none;
}

/**
 * `Texture ›` submenu: Position / Reset Position / Projected; only for a single face
 * with a texture on either side. Position places the front texture; Reset Position resets both sides.
 */
export function textureSubmenu(state: DocumentState, refs: readonly EntityRef[]): ContextMenuItem | null {
  const single = refs.length === 1 ? refs[0]! : null;
  if (!single || (single.kind !== 'face' && single.kind !== 'sketchFace')) return null;
  const info = faceHasTexture(state, single);
  if (!info.front && !info.back) return null;
  return {
    label: 'Texture',
    command: '',
    separator: true,
    children: [
      { label: 'Position', command: MENU_COMMANDS.texturePosition, params: { ref: single }, disabled: !info.front },
      { label: 'Reset Position', command: MENU_COMMANDS.textureReset, params: { refs: [single] }, disabled: !info.positioned },
      { label: 'Projected', command: MENU_COMMANDS.textureProjected, params: { refs: [single] }, disabled: true },
    ],
  };
}

/** Right-click menu of the Position Texture tool (fixed pins): Done, Reset, Flip ›, Rotate ›. */
export function texturePinMenu(): ContextMenuItem[] {
  return [
    { label: 'Done', command: MENU_COMMANDS.texturePinDone },
    { label: 'Reset', command: MENU_COMMANDS.texturePinReset },
    {
      label: 'Flip',
      command: '',
      separator: true,
      children: [
        { label: 'Left/Right', command: MENU_COMMANDS.texturePinFlip, params: { axis: 'leftRight' } },
        { label: 'Up/Down', command: MENU_COMMANDS.texturePinFlip, params: { axis: 'upDown' } },
      ],
    },
    {
      label: 'Rotate',
      command: '',
      children: [
        { label: '90', command: MENU_COMMANDS.texturePinRotate, params: { degrees: 90 } },
        { label: '180', command: MENU_COMMANDS.texturePinRotate, params: { degrees: 180 } },
        { label: '270', command: MENU_COMMANDS.texturePinRotate, params: { degrees: 270 } },
      ],
    },
  ];
}

function faceItems(state: DocumentState, refs: readonly EntityRef[]): ContextMenuItem[] {
  const texture = textureSubmenu(state, refs);
  return [
    entityInfo(),
    // Faces of a solid cannot be erased; `edit.delete` reports that in its message (sketch faces are removed).
    erase(),
    hideGeometry(state, refs),
    { ...selectSubmenu(state, refs), separator: true },
    makeGroup(refs),
    makeComponent(),
    intersectSubmenu(refs),
    { label: 'Reverse Faces', command: MENU_COMMANDS.reverseFaces, params: { refs }, separator: true },
    ...(texture ? [texture] : []),
    zoomSelection(),
  ];
}

function sketchItems(state: DocumentState, refs: readonly EntityRef[]): ContextMenuItem[] {
  return [entityInfo(), erase(), { ...selectSubmenu(state, refs), separator: true }, zoomSelection()];
}

function bodyItems(state: DocumentState, refs: readonly EntityRef[]): ContextMenuItem[] {
  return [
    entityInfo(),
    erase(),
    { label: 'Hide', command: MENU_COMMANDS.hideBodies, params: { refs, hidden: true } },
    makeGroup(refs),
    makeComponent(),
    flipSubmenu(refs, false),
    solidToolsSubmenu(state, refs),
    zoomSelection(),
  ];
}

function instanceItems(state: DocumentState, refs: readonly EntityRef[]): ContextMenuItem[] {
  const insts = refs.map((r) => {
    try {
      return instanceAt(state, [...r.path, r.id]);
    } catch {
      return null;
    }
  });
  const defs = insts.map((i) => (i ? state.definitions.get(i.definitionId) : undefined));
  const allHidden = insts.length > 0 && insts.every((i) => i?.hidden);
  const allLocked = insts.length > 0 && insts.every((i) => i?.locked);
  const anyComponent = defs.some((d) => d && !d.isGroup);
  const single = refs.length === 1 ? refs[0]! : null;
  const singleDef = defs[0];
  const kindLabel = single && singleDef ? (singleDef.isGroup ? 'Group' : 'Component') : 'Group';
  const items: ContextMenuItem[] = [
    entityInfo(),
    erase(),
    { label: allHidden ? 'Unhide' : 'Hide', command: MENU_COMMANDS.setHidden, params: { refs, hidden: !allHidden } },
    { label: allLocked ? 'Unlock' : 'Lock', command: MENU_COMMANDS.setLocked, params: { refs, locked: !allLocked } },
  ];
  if (single) {
    items.push({
      label: `Edit ${kindLabel}`,
      command: MENU_COMMANDS.contextEnter,
      params: { path: [...single.path, single.id] },
      disabled: allLocked,
      separator: true,
    });
  }
  items.push({ label: 'Explode', command: MENU_COMMANDS.explode, params: { refs }, separator: !single, disabled: allLocked });
  items.push({ label: 'Make Component…', command: MENU_COMMANDS.makeComponent, disabled: allLocked });
  if (anyComponent) items.push({ label: 'Make Unique', command: MENU_COMMANDS.makeUnique, params: { refs }, disabled: allLocked });
  // Change Axes on one component, Unglue on glued placements
  if (single && singleDef && !singleDef.isGroup) items.push({ label: 'Change Axes', command: MENU_COMMANDS.changeAxes, params: { ref: single }, disabled: allLocked });
  if (insts.some((i) => i?.gluedPlane)) items.push({ label: 'Unglue', command: MENU_COMMANDS.unglue, params: { refs } });
  items.push(flipSubmenu(refs, insts.some((i) => i?.locked)));
  if (single) items.push({ label: 'Rename…', command: MENU_COMMANDS.renameInstance, params: { ref: single }, separator: true });
  items.push(zoomSelection());
  return items;
}

function emptyItems(opts: ContextMenuOptions): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { label: 'Paste In Place', command: MENU_COMMANDS.pasteInPlace, disabled: !opts.canPaste },
    { label: 'Select All', command: MENU_COMMANDS.selectAll, separator: true },
    { label: 'Zoom Extents', command: MENU_COMMANDS.zoomExtents },
  ];
  if (opts.contextPath && opts.contextPath.length > 0) {
    items.push({ label: 'Exit Group', command: MENU_COMMANDS.contextExit, separator: true });
  }
  return items;
}

/**
 * Section planes: Erase, Hide, Reverse, Active Cut (checked when the plane is its container's cut, for one
 * plane), and Align View for one plane.
 */
function sectionPlaneItems(state: DocumentState, refs: readonly EntityRef[]): ContextMenuItem[] {
  const planes = refs.map((r) => ({ path: [...r.path], id: r.id }));
  const single = planes.length === 1 ? planes[0]! : null;
  let active = false;
  if (single) {
    try {
      active = containerAt(state, single.path as Id[]).activeSectionPlaneId === single.id;
    } catch {
      active = false;
    }
  }
  const items: ContextMenuItem[] = [
    entityInfo(),
    erase(),
    { label: 'Hide', command: 'sectionPlane.setHidden', params: { refs: planes, hidden: true } },
    { label: 'Reverse', command: 'sectionPlane.reverse', params: { refs: planes }, separator: true },
  ];
  if (single) {
    items.push({ label: 'Active Cut', command: 'sectionPlane.setActive', params: { ...single, active: !active }, checked: active });
    items.push({ label: 'Align View', command: 'sectionPlane.alignView', params: single });
  }
  return items;
}

/** Placed pictures: Explode into a textured face, Use as Material (one picture), and grouping. */
function imageItems(refs: readonly EntityRef[]): ContextMenuItem[] {
  const images = refs.map((r) => ({ kind: 'image', path: [...r.path], id: r.id }));
  const items: ContextMenuItem[] = [entityInfo(), erase(), { label: 'Explode', command: 'image.explode', params: { refs: images }, separator: true }];
  if (images.length === 1) items.push({ label: 'Use as Material', command: 'image.useAsMaterial', params: { refs: images } });
  return [...items, makeGroup(refs), makeComponent(), zoomSelection()];
}

function mixedItems(state: DocumentState, refs: readonly EntityRef[]): ContextMenuItem[] {
  // Edges with faces (a triple-click) can be hidden together.
  const geometry = refs.every((r) => classOf(r) === 'edge' || classOf(r) === 'face');
  const faces = refs.some((r) => classOf(r) === 'face');
  return [
    entityInfo(),
    erase(),
    ...(geometry ? [hideGeometry(state, refs)] : []),
    makeGroup(refs),
    makeComponent(),
    ...(faces ? [intersectSubmenu(refs)] : []),
    zoomSelection(),
  ];
}

/**
 * Right-click menu descriptors for a set of refs (the right-clicked entity, or the selection when
 * it contains that entity). An empty list is the empty-space menu.
 */
const TEXT_ARROW_ITEMS = [['None', 'none'], ['Dot', 'dot'], ['Closed Arrow', 'closed'], ['Open Arrow', 'open'], ['Slash', 'slash']] as const;
const TEXT_LEADER_ITEMS = [['View Based', 'view'], ['Pushpin', 'pushpin'], ['Hidden', 'none']] as const;

/** Texts: Edit Text for one, Arrow and, for leader text, Leader, with the current choice checked. */
function textItems(state: DocumentState, refs: readonly EntityRef[]): ContextMenuItem[] {
  const texts = refs.map((r) => {
    try {
      return containerAt(state, r.path).texts.get(r.id) ?? null;
    } catch {
      return null;
    }
  });
  const arrows = new Set(texts.map((t) => t?.arrow ?? 'closed'));
  const leaders = texts.filter((t) => t?.kind === 'leader');
  const leaderKinds = new Set(leaders.map((t) => t!.leader));
  const single = refs.length === 1 ? refs[0]! : null;
  const items: ContextMenuItem[] = [];
  if (single) items.push({ label: 'Edit Text', command: MENU_COMMANDS.editText, params: { ref: single } });
  items.push({
    label: 'Arrow',
    command: '',
    separator: !!single,
    children: TEXT_ARROW_ITEMS.map(([label, arrow]) => ({ label, command: MENU_COMMANDS.textArrow, params: { refs, arrow }, checked: arrows.size === 1 && arrows.has(arrow) })),
  });
  if (leaders.length) {
    items.push({
      label: 'Leader',
      command: '',
      children: TEXT_LEADER_ITEMS.map(([label, leader]) => ({ label, command: MENU_COMMANDS.textLeader, params: { refs, leader }, checked: leaderKinds.size === 1 && leaderKinds.has(leader) })),
    });
  }
  items.push({ ...erase(), separator: true });
  return items;
}

export const contextMenu = {
  itemsFor(state: DocumentState, refs: readonly EntityRef[], opts: ContextMenuOptions = {}): ContextMenuItem[] {
    if (opts.activeToolId === 'texturePosition') return texturePinMenu();
    if (refs.length === 0) return emptyItems(opts);
    const classes = new Set(refs.map(classOf));
    if (classes.size !== 1) return mixedItems(state, refs);
    switch ([...classes][0]!) {
      case 'edge':
        return edgeItems(state, refs);
      case 'face':
        return faceItems(state, refs);
      case 'sketch':
        return sketchItems(state, refs);
      case 'body':
        return bodyItems(state, refs);
      case 'instance':
        return instanceItems(state, refs);
      case 'sectionPlane':
        return sectionPlaneItems(state, refs);
      case 'text':
        return textItems(state, refs);
      case 'image':
        return imageItems(refs);
      default:
        return mixedItems(state, refs);
    }
  },
};
