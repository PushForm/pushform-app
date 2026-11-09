// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ExtensionError, MODEL_ENTITY_KINDS, type ToolInput, type ToolRef, type ToolSource, type ToolStamp, type ToolStopReason, type ToolView } from '@pushform/extension-protocol';
import type { ExtensionTools, ExtensionToolViewport, ExtensionToolRequest } from '@pushform/extensions';
import type { Tool, ToolContext, ToolPointerEvent, ToolKeyEvent, ToolWheelEvent, ToolStatus, ToolSettingValue, OverlayPrimitive } from '@pushform/commands';
import type { InferenceOptions } from '@pushform/inference';
import type { EdgeKey, EntityRef } from '@pushform/model';
import { asId, LENGTH_TOL, PICK_PX, v3dot, v3normalize, v3sub, type FaceLocalId, type Vec2, type LengthUnit } from '@pushform/core';
import type { AppInstance } from '../bootstrap';
import type { DocumentSession } from '../session';

/** The only bridge from active editor input to the isolated extension runtime. */
export function sessionExtensionTools(session: () => DocumentSession | null): ExtensionTools {
  let active: ExtensionViewportTool | null = null;
  return { open(request) {
    const current = session(), tab = current?.active;
    if (!current || !tab || tab.id !== request.documentId || tab.type !== 'model')
      throw new ExtensionError('unavailable', 'Interactive tools require the active model.');
    active?.finish('replaced');
    const tool = new ExtensionViewportTool(tab.app, request, () => { if (active === tool) active = null; });
    active = tool;
    tool.listen(current);
    try { tab.app.toolManager.register(tool, { command: false }); tab.app.toolManager.activate(tool.id); }
    catch (error) { tool.close('runtime.failed'); throw error; }
    return tool;
  } };
}

class ExtensionViewportTool implements Tool, ExtensionToolViewport {
  readonly id: string;
  readonly title: string;
  private ctx: ToolContext | null = null;
  private view: ToolView | null = null;
  private contextVersion = 0;
  private cameraVersion = 0;
  private invalidated = false;
  private closed = false;
  private readonly off: (() => void)[] = [];
  constructor(private readonly app: AppInstance, private readonly request: ExtensionToolRequest, private readonly released: () => void) {
    this.id = request.id; this.title = request.title;
  }
  get cursor(): string { return this.view?.cursor ?? 'crosshair'; }
  get vcbSchema() { return this.view?.measurement?.kinds ?? []; }
  activate(ctx: ToolContext): void { this.ctx = ctx; }
  deactivate(): void { this.finish('replaced'); }
  suspend(): void { this.input({ kind: 'suspend', data: {} }); }
  resume(): void { this.input({ kind: 'resume', data: {} }); }
  hasPendingWork(): boolean { return this.view?.pending ?? false; }
  onCancel(): void { this.finish('cancelled'); }
  listen(session: DocumentSession): void {
    this.off.push(
      this.app.document.events.on('contextChanged', () => { this.contextVersion++; this.resync(); }),
      this.app.document.doc.events.on('change', () => this.resync()),
      this.app.viewport.events.on('cameraChanged', () => { this.cameraVersion++; this.resync(); }),
      this.app.viewport.events.on('resize', () => { this.cameraVersion++; this.resync(); }),
      session.subscribe(() => { if (session.activeId !== this.request.documentId) this.finish('replaced'); }),
    );
  }
  stamp(): ToolStamp { return { revision: this.app.document.doc.version, contextVersion: this.contextVersion, cameraVersion: this.cameraVersion, context: [...this.app.document.context.path] }; }
  present(view: ToolView | null): void {
    if (this.closed) return;
    this.view = view; this.invalidated = false; this.refresh();
  }
  close(_reason: ToolStopReason): void {
    if (this.closed) return;
    this.closed = true; this.view = null;
    for (const off of this.off.splice(0)) off();
    this.released(); this.app.toolManager.unregister(this.id);
    this.refresh();
    if (_reason === 'unresponsive' || _reason === 'limit.exceeded') this.app.store.getState().setNotice(`${this.title} stopped ${_reason === 'unresponsive' ? 'responding' : 'because its input queue filled'}. Start the tool again to retry.`);
  }
  finish(reason: ToolStopReason): void { if (!this.closed) { this.request.ended(reason); this.close(reason); } }
  status(): ToolStatus { return { instructor: this.view?.instructor ?? `Starting ${this.title}...`, vcbLabel: this.view?.measurement?.label ?? '',
    vcbValue: this.view?.measurement?.value, fields: this.view?.fields ?? [], placing: false, settings: (this.view?.choices ?? []).map(choice => ({ ...choice, kind: 'choice' as const, display: 'menu' as const })) }; }
  overlay(): readonly OverlayPrimitive[] {
    if (this.invalidated) return [];
    return (this.view?.overlay ?? []).map(primitive => {
      if (primitive.kind === 'screenRect') return { ...primitive, a: this.pixels(primitive.a), b: this.pixels(primitive.b) };
      if (primitive.kind === 'screenPolyline') return { ...primitive, points: primitive.points.map(point => this.pixels(point)) };
      if (primitive.kind === 'cursorHint' && primitive.screen) return { ...primitive, screen: this.pixels(primitive.screen) };
      return primitive;
    });
  }
  inferenceOptions(): InferenceOptions {
    const inference = this.view?.inference;
    if (!inference) return {};
    const { plane, ignore, ...options } = inference;
    return { ...options, plane: plane ? { n: plane.normal, d: plane.offset } : undefined,
      ignore: ignore?.map(nativeRef) };
  }
  onPointerMove(event: ToolPointerEvent): void { this.pointer('pointerMove', event); }
  onPointerDown(event: ToolPointerEvent): void { this.pointer('pointerDown', event); }
  onPointerUp(event: ToolPointerEvent): void { this.pointer('pointerUp', event); }
  onClick(event: ToolPointerEvent): void { this.pointer('click', event); }
  onDoubleClick(event: ToolPointerEvent): void { this.pointer('doubleClick', event); }
  onKeyDown(event: ToolKeyEvent): boolean { this.input({ kind: 'keyDown', data: event }); return this.consumes(event); }
  onKeyUp(event: ToolKeyEvent): boolean { this.input({ kind: 'keyUp', data: event }); return this.consumes(event); }
  onWheel(event: ToolWheelEvent): void { this.input({ kind: 'wheel', data: { ...event, screen: this.normalized(event.screen) } }); }
  onRawVcb(text: string, defaultUnit: LengthUnit): void { this.input({ kind: 'measurement', data: { text, defaultUnit } }); }
  onRawEntry(values: Readonly<Record<string, string>>, defaultUnit: LengthUnit): void {
    this.input({ kind: 'entry', data: { values: Object.entries(values).map(([id, text]) => ({ id, text, defaultUnit })) } });
  }
  onRawEntryLock(id: string, text: string | null, defaultUnit: LengthUnit): void { this.input({ kind: 'entryLock', data: { id, value: text === null ? null : { text, defaultUnit } } }); }
  onSetting(id: string, value: ToolSettingValue): void { if (typeof value === 'string') this.input({ kind: 'choice', data: { id, value } }); }
  private pointer(kind: Extract<ToolInput, { kind: 'pointerMove' | 'pointerDown' | 'pointerUp' | 'click' | 'doubleClick' }>['kind'], event: ToolPointerEvent): void {
    const inference = event.inference;
    if (!inference) return; // The host has not resolved a usable model point yet.
    const snap = inference.primary, hit = inference.hit, hitRef = hit && portableRef(hit.ref), snapRef = snap.ref && portableRef(snap.ref);
    const selectable = hit?.selectable && portableRef(hit.selectable);
    const camera = event.camera;
    const depth = Math.max(LENGTH_TOL, v3dot(v3sub(inference.point, camera.eye), v3normalize(v3sub(camera.target, camera.eye))));
    const height = camera.projection === 'parallel' ? camera.orthoHeight : 2 * depth * Math.tan(camera.fov * Math.PI / 360);
    const pickRadius = Math.min(1e12, height * PICK_PX.vertex / Math.max(1, this.app.viewport.camera.viewportSize().height));
    this.input({ kind, data: { screen: this.normalized(event.screen), ray: { origin: [...event.ray.origin], direction: [...event.ray.dir] }, button: event.button, buttons: event.buttons,
      modifiers: event.modifiers, point: [...inference.point], pickRadius, snap: { kind: snap.kind, point: [...snap.point], ...(snapRef ? { ref: snapRef } : {}), ...(snap.dir ? { direction: [...snap.dir] } : {}), ...(snap.plane ? { plane: { normal: [...snap.plane.n], offset: snap.plane.d } } : {}) },
      hit: hit && hitRef ? { ref: hitRef, point: [...hit.point], ...(hit.normal ? { normal: [...hit.normal] } : {}), ...(selectable ? { selectable } : {}) } : null,
      camera: { eye: [...camera.eye], target: [...camera.target], up: [...camera.up], projection: camera.projection, fovDeg: camera.fov, viewHeight: camera.orthoHeight } } });
  }
  private input(input: ToolSource): void { if (!this.closed) this.request.input(input); }
  private consumes(event: ToolKeyEvent): boolean { return !event.modifiers.ctrl && !event.modifiers.meta && !event.modifiers.alt && (this.view?.keys as readonly string[] | undefined)?.includes(event.key) === true; }
  private resync(): void { this.invalidated = true; this.ctx?.overlayChanged?.(); this.input({ kind: 'resync', data: {} }); }
  private refresh(): void { this.ctx?.statusChanged(); this.ctx?.overlayChanged?.(); this.ctx?.requestRender(); }
  private normalized(point: Vec2): [number, number] {
    const { width, height } = this.app.viewport.camera.viewportSize();
    return [Math.max(-32, Math.min(32, point[0] / Math.max(1, width))), Math.max(-32, Math.min(32, point[1] / Math.max(1, height)))];
  }
  private pixels(point: readonly [number, number]): [number, number] { const size = this.app.viewport.camera.viewportSize(); return [point[0] * size.width, point[1] * size.height]; }
}

function nativeRef(ref: ToolRef): EntityRef {
  const common = { id: asId(ref.id), path: ref.path.map(asId) };
  if (ref.kind === 'face') return { ...common, kind: 'face', faceId: ref.faceId as FaceLocalId, region: null };
  if (ref.kind === 'edge') return { ...common, kind: 'edge', edgeKey: ref.edgeKey as EdgeKey };
  return { ...common, kind: ref.kind } as EntityRef;
}

function portableRef(ref: EntityRef): ToolRef | null {
  if (!(MODEL_ENTITY_KINDS as readonly string[]).includes(ref.kind)) return null;
  const common = { id: ref.id, path: [...ref.path] };
  if (ref.kind === 'face') return { ...common, kind: 'face', faceId: ref.faceId };
  if (ref.kind === 'edge') return { ...common, kind: 'edge', edgeKey: ref.edgeKey };
  return { ...common, kind: ref.kind as Exclude<(typeof MODEL_ENTITY_KINDS)[number], 'face' | 'edge'> };
}
