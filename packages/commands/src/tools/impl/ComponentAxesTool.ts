// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ToolStatus } from '../Tool';
import { AxesTool, type PickedAxes } from './AxesTool';

/** What a component axes pick is for: Set Component Axes in the Create Component dialog, or Change Axes. */
export interface ComponentAxesRequest {
  /** Status bar text before the first click. */
  readonly instruction: string;
  readonly onPicked: (axes: PickedAxes) => void;
  readonly onCancel?: (() => void) | undefined;
}

/** The pending pick; set by whoever starts the tool (`component.changeAxesPick`, the Create Component dialog). */
export const componentAxesPick: { request: ComponentAxesRequest | null } = { request: null };

/**
 * Picks component axes as the Axes tool does, then hands them to the pending request and returns to Select. Escape,
 * or switching tools, cancels the request.
 */
export class ComponentAxesTool extends AxesTool {
  override readonly id = 'componentAxes';
  override readonly title = 'Component Axes';

  protected override apply(axes: PickedAxes): void {
    const request = componentAxesPick.request;
    componentAxesPick.request = null;
    this.ctx?.commands.execute('tool.select');
    request?.onPicked(axes);
  }

  override onCancel(): void {
    this.ctx?.commands.execute('tool.select');
  }

  override deactivate(): void {
    const request = componentAxesPick.request;
    componentAxesPick.request = null;
    super.deactivate();
    request?.onCancel?.();
  }

  override status(): ToolStatus {
    const base = super.status();
    return this.origin === null && componentAxesPick.request ? { ...base, instructor: `${componentAxesPick.request.instruction} ${base.instructor}` } : base;
  }
}
