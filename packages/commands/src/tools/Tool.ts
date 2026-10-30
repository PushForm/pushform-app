// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Ray, Vec2 } from '@pushform/core';
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

export interface ToolStatus {
  /** Instructor / status bar text. */
  readonly instructor: string;
  /** Measurements box label, e.g. "Length". */
  readonly vcbLabel: string;
  /** Live value shown in the Measurements box while not typing. */
  readonly vcbValue?: string | undefined;
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
  /** Called when a temporary tool (middle-drag orbit) takes over; `resume` when it ends. */
  suspend?(): void;
  resume?(): void;

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
  onCancel(): void;
  overlay(): readonly OverlayPrimitive[];
  status(): ToolStatus;
}

export const NO_MODIFIERS: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };
