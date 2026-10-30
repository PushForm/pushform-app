// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { BoundariesConfig } from '../config/schema.ts';
import { classIndex, highestAllowedClass } from './classes.ts';
import { isAtLeast } from './roles.ts';
import type { ChangeClass, Eligibility, Role } from './types.ts';

export interface EligibilityInput {
  /** Effective role of the requester in the request's scope. */
  role: Role;
  /** Estimated change class of the brief; null when the agent made no estimate. */
  estimatedClass: ChangeClass | null;
  boundaries: BoundariesConfig;
  /** Builds disabled for the host or organization: every request is `none` while off. */
  buildsDisabled?: boolean | undefined;
}

/**
 * Automatic ceiling that applies to a role: Builders use `automaticCeiling.builder`,
 * Maintainers and Admins `automaticCeiling.maintainer`; neither exceeds the highest `allowed` class.
 * Null when the role has no ceiling (User or None) or nothing is allowed.
 */
export function automaticCeiling(role: Role, boundaries: BoundariesConfig): ChangeClass | null {
  if (!isAtLeast(role, 'builder')) return null;
  const configured = isAtLeast(role, 'maintainer') ? boundaries.automaticCeiling.maintainer : boundaries.automaticCeiling.builder;
  const allowed = highestAllowedClass(boundaries);
  if (allowed === null) return null;
  return classIndex(configured) <= classIndex(allowed) ? configured : allowed;
}

/** Historical API retained for old callers; no account receives customer automation. */
export function computeEligibility(_input: EligibilityInput): Eligibility {
  return 'none'; // Customer automation retired; retained as a compatibility entry point.
}

export function eligibilityLabel(eligibility: Eligibility): `eligible:${Eligibility}` { return `eligible:${eligibility}`; }
export function parseEligibilityLabel(label: string): Eligibility | null {
  const m = /^eligible:(auto|gated|none)$/.exec(label);
  return m ? (m[1] as Eligibility) : null;
}
