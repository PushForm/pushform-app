// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ROLE_ORDER, type DisabledParts, type Role, type RoleGrant } from './types.ts';

/** Capabilities of after the disable switches of are applied. */
export interface Capabilities {
  /** Get help; every signed-in account has it. */
  help: boolean;
  /** Report problems and request features or changes; off when filing is disabled. */
  file: boolean;
  /** Retained for old clients; customer previews are retired. Always false. */
  feedback: boolean;
  /** Retained for old clients; customer builds are retired. Always false. */
  eligible: boolean;
  /** Maintainer and above: read every request in the scope, move states, relay comments, give verdicts. */
  triage: boolean;
  /** Admin: grant and revoke roles, set boundaries and limits, disable parts. */
  admin: boolean;
}
export const NOTHING_DISABLED: DisabledParts = { filing: false, builds: false, trials: false };

export function roleRank(role: Role): number { return ROLE_ORDER.indexOf(role); }
export function isAtLeast(role: Role, minimum: Role): boolean { return roleRank(role) >= roleRank(minimum); }
export function highestRole(roles: readonly Role[]): Role {
  return roles.reduce<Role>((best, role) => (roleRank(role) > roleRank(best) ? role : best), 'none');
}

/**
 * Effective role of an account for a scope: the highest of the default role, the global
 * grants, and the grants of the organization the request belongs to. Grants of other organizations
 * never apply; with `orgId` null only global grants count.
 */
export function effectiveRole(grants: readonly RoleGrant[], defaultRole: 'user' | 'none', orgId: string | null = null): Role {
  const applicable = grants.filter(g => g.orgId === null || (orgId !== null && g.orgId === orgId)).map(g => g.role);
  return highestRole([defaultRole, ...applicable]);
}

/**
 * Disable switches combine as a union: an organization can disable more than the host but cannot
 * enable what the host disabled.
 */
export function combineDisabled(host: DisabledParts, org: DisabledParts | null = null): DisabledParts {
  return { filing: host.filing || (org?.filing ?? false), builds: host.builds || (org?.builds ?? false), trials: host.trials || (org?.trials ?? false) };
}

/** Capability set of a role minus the disabled parts. */
export function capabilities(role: Role, disabled: DisabledParts = NOTHING_DISABLED): Capabilities {
  const user = isAtLeast(role, 'user');
  return {
    help: true,
    file: user && !disabled.filing,
    feedback: false,
    eligible: false,
    triage: isAtLeast(role, 'maintainer'),
    admin: role === 'admin',
  };
}

/**
 * Whether `actor` may grant or revoke `role` in `scopeOrgId`: a global Admin may
 * act in any scope, an organization Admin only in that organization.
 */
export function mayGrant(actorGrants: readonly RoleGrant[], scopeOrgId: string | null): boolean {
  return actorGrants.some(g => g.role === 'admin' && (g.orgId === null || (scopeOrgId !== null && g.orgId === scopeOrgId)));
}
