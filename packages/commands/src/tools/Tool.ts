// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Ray, Vec2, Vec3 } from '@pushform/core';
import type { InferenceOptions, InferenceResult } from '@pushform/inference';
import type { CameraHost, CameraState } from '../camera/CameraHost';
import type { CommandRegistry } from '../registry/CommandRegistry';
import type { VcbValue, VcbKind } from '../vcb/parse';
import type { OverlayPrimitive } from './overlay';

export interface Modifiers {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export type { InferenceResult, InferenceOptions } from '@pushform/inference';

export interface ToolPointerEvent {
  /** CSS px relative to the viewport. */
  readonly screen: Vec2;
  readonly ray: Ray;
  /** Button that changed (down/up/click): 0 left, 1 middle, 2 right. -1 for move. */
  readonly button: number;
  /** Bitmask of pressed buttons (as in PointerEvent.buttons). */
  readonly buttons: number;
  readonly modifiers: Modifiers;
  readonly inference: InferenceResult | null;
  readonly camera: CameraState;
}

export interface ToolKeyEvent {
  readonly key: string;
  readonly code: string;
  readonly modifiers: Modifiers;
  readonly repeat: boolean;
}

export interface ToolWheelEvent {
  readonly screen: Vec2;
  readonly deltaY: number;
  readonly modifiers: Modifiers;
}

export type EntryFieldKind = 'length' | 'angle' | 'number';

/** A value the tool takes, drawn as a field in the viewport beside the geometry it sets. */
export interface EntryField {
  /** Stable id within the tool (`length`, `angle`, `width`, …); keys `onEntry` values. */
  readonly id: string;
  /** Accessible name, e.g. "Width". */
  readonly label: string;
  readonly kind: EntryFieldKind;
  /** Live value shown while the field is not being typed in. */
  readonly value: string;
  /** World point the field is centred on; beside the pointer when omitted. */
  readonly at?: Vec3 | undefined;
  /** True while a typed value is locked into the preview (`onEntryLock`). */
  readonly locked?: boolean | undefined;
}

export interface ToolStatus {
  /** Instructor / status bar text. */
  readonly instructor: string;
  /** What the tool takes as a typed value, e.g. "Length"; labels the field opened by typing. */
  readonly vcbLabel: string;
  /** Live value of the tool's single value, when it has one. */
  readonly vcbValue?: string | undefined;
  /** Value fields to draw in the viewport, in Tab order. None: typing opens one beside the pointer. */
  readonly fields?: readonly EntryField[] | undefined;
}

export interface ToolContext {
  readonly commands: CommandRegistry;
  readonly camera: CameraHost;
  /** Ask the viewport to redraw the overlay / scene. */
  requestRender(): void;
  /** Tell the shell that `status()` changed. */
  statusChanged(): void;
  /** Tell the shell that `overlay()` or the tool's preview changed outside a pointer or key event (async previews). */
  overlayChanged?(): void;
}

/**
 * Tool interface. Tools own transient interaction state and call commands for all mutations.
 * All handlers are optional except `onCancel`, `overlay` and `status`.
 */
export interface Tool {
  readonly id: string;
  readonly title: string;
  /** CSS cursor value for the viewport while the tool is active. */
  readonly cursor?: string | undefined;
  /** Which VCB value kinds the tool accepts (for validation / help). */
  readonly vcbSchema?: readonly VcbKind[] | undefined;

  activate(ctx: ToolContext): void;
  deactivate(): void;
  /** What the tool wants from inference for the next pointer event (anchor, plane, locks, filters). */
  inferenceOptions?(): InferenceOptions;
  /**
   * Called when another tool takes over without ending this one (a middle-drag orbit, or a camera
   * tool or Select chosen while this tool is active); `resume` when this tool takes over again.
   */
  suspend?(): void;
  resume?(): void;
  /**
   * Camera tools (Orbit, Pan, Zoom, Zoom Window) and Select set the active tool aside instead of
   * ending it; choosing the set-aside tool again, or Esc in the camera tool or Select, returns to it.
   */
  readonly role?: 'camera' | 'select' | undefined;
  /**
   * Whether an operation is in progress. Returning from Select continues a tool that has one and
   * restarts any other, since the selection it started from may have changed.
   */
  hasPendingWork?(): boolean;

  onPointerMove?(e: ToolPointerEvent): void;
  onPointerDown?(e: ToolPointerEvent): void;
  onPointerUp?(e: ToolPointerEvent): void;
  onClick?(e: ToolPointerEvent): void;
  onDoubleClick?(e: ToolPointerEvent): void;
  /** Return true when the key was consumed (prevents keymap/VCB handling). */
  onKeyDown?(e: ToolKeyEvent): boolean | void;
  onKeyUp?(e: ToolKeyEvent): boolean | void;
  onWheel?(e: ToolWheelEvent): boolean | void;
  onVcb?(value: VcbValue): void;
  /**
   * Apply the typed values of the tool's fields, keyed by field id; fields left out keep their live
   * value. Values whose kind the field does not take (`8s`, `[x,y,z]`) go to `onVcb` instead.
   */
  onEntry?(values: Readonly<Record<string, VcbValue>>): void;
  /** Hold (or with null, release) a typed field value in the preview while the others are set. */
  onEntryLock?(id: string, value: VcbValue | null): void;
  onCancel(): void;
  overlay(): readonly OverlayPrimitive[];
  status(): ToolStatus;
}

export const NO_MODIFIERS: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };
