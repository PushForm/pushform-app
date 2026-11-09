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
  /** World point the field is anchored on; beside the pointer when omitted. */
  readonly at?: Vec3 | undefined;
  /**
   * World direction, away from the geometry, in which the field is drawn clear of `at`: the field
   * sits wholly on that side of the point instead of centred on it, so it does not cover the
   * geometry or its dimension line. Its length only needs to show on screen. Centred when omitted.
   */
  readonly away?: Vec3 | undefined;
  /** True while a typed value is locked into the preview (`onEntryLock`). */
  readonly locked?: boolean | undefined;
}

/** Display priority of a bar control: lower numbers stay visible longest as the bar narrows. */
export type ToolSettingPriority = 1 | 2 | 3;

/** One option of a `choice` setting. */
export interface ToolSettingOption {
  readonly value: string;
  readonly label: string;
  /** Icon name, shown instead of the label where the bar has room (`display: 'icons'`). */
  readonly icon?: string | undefined;
  /** Disabled options stay visible; `reason` says why. */
  readonly disabled?: boolean | undefined;
  readonly reason?: string | undefined;
}

/**
 * A control in the tool options bar: a tool setting (shapes every operation until changed) or a
 * mode toggle (changes what the next operation produces). Operation values are `EntryField`s and
 * never appear here; held keys are `ToolStatus.held`.
 */
export type ToolSetting =
  | {
      readonly kind: 'choice';
      readonly id: string;
      readonly label: string;
      readonly value: string;
      readonly options: readonly ToolSettingOption[];
      /** Icon row (collapses to a list when the bar is narrow), buttons, or a list. Buttons by default. */
      readonly display?: 'icons' | 'buttons' | 'menu' | undefined;
      /** Modifier tap that cycles or toggles this choice, printed on it. */
      readonly key?: ToolSettingKey | undefined;
      readonly priority?: ToolSettingPriority | undefined;
    }
  | {
      readonly kind: 'quantity';
      readonly id: string;
      readonly label: string;
      /** Current value, formatted in the document's units (empty when unset). */
      readonly value: string;
      /** How typed text is read: a length or angle in the field's units, or a whole count. */
      readonly quantity: 'length' | 'angle' | 'count';
      readonly disabled?: boolean | undefined;
      readonly priority?: ToolSettingPriority | undefined;
    }
  | {
      readonly kind: 'toggle';
      readonly id: string;
      readonly label: string;
      readonly on: boolean;
      readonly key?: ToolSettingKey | undefined;
      readonly priority?: ToolSettingPriority | undefined;
    }
  | {
      readonly kind: 'action';
      readonly id: string;
      readonly label: string;
      readonly primary?: boolean | undefined;
      readonly disabled?: boolean | undefined;
      readonly priority?: ToolSettingPriority | undefined;
    }
  | {
      /** A short read-only note at the bar's end, such as why some options are disabled. */
      readonly kind: 'note';
      readonly id: string;
      readonly text: string;
      readonly priority?: ToolSettingPriority | undefined;
    };

/** The tapped modifier that toggles a setting: primary is the Ctrl tap, secondary the Alt tap. */
export type ToolSettingKey = 'primary' | 'secondary';

/** What a bar control sends the tool: a choice's value, a toggle's new state, a parsed quantity, or nothing for an action. */
export type ToolSettingValue = string | boolean | VcbValue | undefined;

export interface ToolStatus {
  /** Instructor / status bar text. */
  readonly instructor: string;
  /** What the tool takes as a typed value, e.g. "Length"; labels the field opened by typing. */
  readonly vcbLabel: string;
  /** Live value of the tool's single value, when it has one. */
  readonly vcbValue?: string | undefined;
  /** Value fields to draw in the viewport, in Tab order. None: typing opens one beside the pointer. */
  readonly fields?: readonly EntryField[] | undefined;
  /** Tool settings and mode toggles for the tool options bar (`onSetting`). None: no bar. */
  readonly settings?: readonly ToolSetting[] | undefined;
  /**
   * Whether the tool is placing a point (between the clicks of a click-move-click operation), so the
   * bar lets the pointer through. Defaults to `hasPendingWork()`; tools that gather picks while
   * their bar stays usable (edge picking) report false.
   */
  readonly placing?: boolean | undefined;
  /**
   * Held-key constraints and keyed modes in force now, each named for a tag beside the value
   * fields, such as "On red axis" or "Square · Shift". Hint text never carries them.
   */
  readonly held?: readonly string[] | undefined;
  /**
   * The bar shows the operation the tool just committed ("✓ Tool applied"): its controls show the
   * values that operation used, and changing one redoes it (`adjustLast`). Set by the ToolManager.
   */
  readonly applied?: boolean | undefined;
}

export interface ToolContext {
  readonly commands: CommandRegistry;
  readonly camera: CameraHost;
  /** Ask the viewport to redraw the overlay / scene. */
  requestRender(): void;
  /** Tell the shell that `status()` changed. */
  statusChanged(): void;
  /**
   * Tell the shell the tool just committed an operation it can adjust from the bar (`adjustLast`),
   * now on top of the undo stack.
   */
  committed?(): void;
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
  /**
   * Return true when the key was consumed (prevents keymap/VCB handling). Ctrl and Alt arrive only
   * as taps: once, when released with no other key, click or wheel since they were
   * pressed. Held Ctrl and Alt are read from `modifiers` instead.
   */
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
  /** A control of `status().settings` was changed (or, for an action, clicked). */
  onSetting?(id: string, value: ToolSettingValue): void;
  /**
   * While the bar shows the operation just committed, setting `id` was changed (`onSetting` has
   * already run): redo that operation with the new value as one undo step, calling
   * `ToolContext.committed` again when done. False when the setting does not change it.
   */
  adjustLast?(id: string, value: ToolSettingValue): boolean;
  onCancel(): void;
  overlay(): readonly OverlayPrimitive[];
  status(): ToolStatus;
}

export const NO_MODIFIERS: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };
