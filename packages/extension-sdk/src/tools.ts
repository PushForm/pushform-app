// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors
import type { CallOptions } from './context.ts';
import type { ModelBatch, ModelBatchResult, ModelCameraSummary, ModelEntityKind, ModelRef, ModelVec3 } from './model.ts';
import type { ModelMetadataBatchInput } from './metadata.ts';

/** Tool coordinates are world meters, Z up. Screen points are viewport fractions; label offsets are CSS pixels. */
export type ToolScreenPoint = [number, number];
export type ToolPlane = { normal: ModelVec3; offset: number };
export type ToolValueKind = 'empty' | 'length' | 'angle' | 'slope' | 'array' | 'absolute' | 'relative' | 'list' | 'segments' | 'radius' | 'circumscribed';
export type ToolPrimitive =
  | { kind: 'point'; position: ModelVec3; color: string; shape: 'square' | 'circle' | 'diamond' | 'cross' | 'x'; size?: number }
  | { kind: 'polyline'; points: ModelVec3[]; color: string; width?: number; closed?: boolean; dashed?: boolean }
  | { kind: 'polygon'; points: ModelVec3[]; holes?: ModelVec3[][]; color: string; opacity?: number }
  | { kind: 'label'; position: ModelVec3; text: string; color?: string; offset?: ToolScreenPoint }
  | { kind: 'cursorHint'; text: string; screen?: ToolScreenPoint }
  | { kind: 'screenRect'; a: ToolScreenPoint; b: ToolScreenPoint; color: string; dashed?: boolean }
  | { kind: 'screenPolyline'; points: ToolScreenPoint[]; color: string; dashed?: boolean; closed?: boolean }
  | { kind: 'circle'; center: ModelVec3; normal: ModelVec3; radius: number; color: string; dashed?: boolean; ticks?: number; width?: number }
  | { kind: 'box'; min: ModelVec3; max: ModelVec3; color: string; dashed?: boolean; width?: number };

/** A complete replacement of a transient presentation; never modifies model geometry. */
export interface ToolView {
  instructor: string;
  cursor?: 'default' | 'crosshair' | 'pointer' | 'not-allowed' | 'move' | 'grab' | 'grabbing';
  pending?: boolean;
  /** Tool-specific keys to consume. Escape, Space, navigation and system/keymap shortcuts stay host-owned. */
  keys?: ('Enter' | 'Tab' | 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Backspace' | 'Delete')[];
  measurement?: { label: string; value?: string; kinds: ToolValueKind[] };
  fields?: { id: string; label: string; kind: 'length' | 'angle' | 'number' | 'text'; placement?: 'viewport' | 'options'; value: string; at?: ModelVec3; away?: ModelVec3; locked?: boolean }[];
  choices?: { id: string; label: string; value: string; options: { value: string; label: string }[] }[];
  overlay?: ToolPrimitive[];
  inference?: { anchor?: ModelVec3; plane?: ToolPlane; lockAxis?: 'x' | 'y' | 'z' | null; pickOnly?: boolean; snapping?: 'all' | 'none' | 'directional'; kinds?: ModelEntityKind[]; ignore?: ModelRef[] };
}
export type ToolModifiers = { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
export type ToolEntry = { text: string; defaultUnit: 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'yd' };
export type ToolSnapKind = 'endpoint' | 'midpoint' | 'onEdge' | 'intersection' | 'center' | 'onFace' | 'onPlane' | 'origin' | 'guide' | 'onAxis' | 'fromPoint' | 'perpendicular' | 'parallel' | 'tangent' | 'extension' | 'free';
export interface ToolPointer {
  screen: ToolScreenPoint;
  ray: { origin: ModelVec3; direction: ModelVec3 };
  button: number;
  buttons: number;
  modifiers: ToolModifiers;
  point: ModelVec3;
  /** Host vertex-picking radius in world meters at the resolved point's view depth. */
  pickRadius?: number;
  snap: { kind: ToolSnapKind; point: ModelVec3; ref?: ModelRef; direction?: ModelVec3; plane?: ToolPlane };
  hit: { ref: ModelRef; point: ModelVec3; normal?: ModelVec3; selectable?: ModelRef } | null;
  camera: ModelCameraSummary;
}
export type ToolSource =
  | { kind: 'activate' | 'cancel' | 'suspend' | 'resume' | 'resync'; data: Record<string, never> }
  | { kind: 'pointerMove' | 'pointerDown' | 'pointerUp' | 'click' | 'doubleClick'; data: ToolPointer }
  | { kind: 'keyDown' | 'keyUp'; data: { key: string; code: string; repeat: boolean; modifiers: ToolModifiers } }
  | { kind: 'wheel'; data: { screen: ToolScreenPoint; deltaY: number; modifiers: ToolModifiers } }
  | { kind: 'measurement'; data: ToolEntry }
  | { kind: 'entry'; data: { values: ({ id: string } & ToolEntry)[] } }
  | { kind: 'entryLock'; data: { id: string; value: ToolEntry | null } }
  | { kind: 'choice'; data: { id: string; value: string } };
export type ToolInput = ToolSource & { session: string; sequence: number; revision: number; contextVersion: number; cameraVersion: number; context: number[] };
export type ToolStopReason = 'ended' | 'cancelled' | 'replaced' | 'disabled' | 'document.closed' | 'runtime.failed' | 'limit.exceeded' | 'unresponsive';

/** Available with tool.interaction. Only the host can activate a declared model.tool contribution. */
export interface ToolsService {
  /** One undoable edit of the tool's captured document/context. Also needs model.write. Cancels with the tool. */
  apply(input: { session: string; sequence: number; amendPrevious?: boolean; batch: ModelBatch & { metadata?: ModelMetadataBatchInput } }, options?: CallOptions): Promise<ModelBatchResult>;
  /** Acknowledge this input and replace the presentation atomically. Stale responses fail without changing it. */
  present(input: { session: string; sequence: number; view: ToolView }, options?: CallOptions): Promise<null>;
  /** Acknowledge an input that needs no presentation change, including a refused stale presentation. */
  ack(input: { session: string; sequence: number }, options?: CallOptions): Promise<null>;
  end(input: { session: string }, options?: CallOptions): Promise<null>;
  /** Active-tool input only. Acknowledge each input; pointer moves may be coalesced while waiting. */
  onEvent(handler: (input: ToolInput) => void): () => void;
  /** Stop pending async work for this session. Late responses cannot restore an ended tool. */
  onEnd(handler: (event: { session: string; reason: ToolStopReason }) => void): () => void;
}
