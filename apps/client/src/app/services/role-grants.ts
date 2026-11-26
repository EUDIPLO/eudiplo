import {
  effectiveRoles as expandRoles,
  includedRoles as rolesIncludedBy,
} from '@eudiplo/config-format/role-model.js';
import { RoleDto } from '@eudiplo/sdk-core';

/**
 * The backend's role rules for granting roles and changing clients and users
 * (`apps/backend/src/auth/roles/role-grants.ts`), used to offer only what the
 * backend will accept. The backend has the final say.
 */

export type Role = RoleDto['role'];

// A record, so the build fails when the SDK knows a role that is missing here.
const roleSet: Record<Role, true> = {
  'audit:read': true,
  'clients:manage': true,
  'credentials:status': true,
  'issuance:manage': true,
  'issuance:offer': true,
  'issuance:read': true,
  'keys:export': true,
  'keys:manage': true,
  'presentation:manage': true,
  'presentation:read': true,
  'presentation:request': true,
  'registrar:manage': true,
  'sessions:read': true,
  'tenant:admin': true,
  'tenants:manage': true,
  'users:manage': true,
};

export const roles = Object.keys(roleSet) as Role[];

/**
 * `roles` and every role they include, from the table the backend uses
 * (`@eudiplo/config-format/role-model.js`). The backend already returns these
 * from `GET /api/auth/me`; expanding again changes nothing.
 */
export const effectiveRoles: (assigned: readonly string[]) => string[] = expandRoles;

/** The roles that `role` includes besides itself, for role pickers. */
export const includedRoles: (role: string) => string[] = rolesIncludedBy;

/**
 * Roles that administer the tenant: its key material, configuration exports
 * and Config Portability.
 */
export const TENANT_ADMIN_ROLES: Role[] = ['tenant:admin', 'tenants:manage'];

/** Roles that only a caller with `tenants:manage` can grant. */
const reservedRoles: ReadonlySet<Role> = new Set<Role>(['tenants:manage', 'tenant:admin']);

/**
 * Roles a caller may grant to clients and users, as the backend checks them:
 * every role with `tenants:manage`, otherwise the roles it has, except the
 * reserved ones. `callerRoles` are the caller's effective roles from
 * `GET /api/auth/me`, which include the roles its assigned roles imply, so
 * `tenant:admin` grants every role except the reserved ones.
 */
export function grantableRoles(callerRoles: string[]): Role[] {
  const held = effectiveRoles(callerRoles);
  if (held.includes('tenants:manage')) return roles;
  return roles.filter((role) => held.includes(role) && !reservedRoles.has(role));
}

/** Explains to the caller which roles it can grant. */
export function grantHint(callerRoles: string[]): string {
  if (callerRoles.includes('tenants:manage')) return 'You can grant every role.';
  if (callerRoles.includes('tenant:admin')) {
    return 'You can grant every role except tenants:manage and tenant:admin.';
  }
  return 'You can grant only roles you have, including those your roles include, except tenants:manage and tenant:admin.';
}

/**
 * Whether a caller may change, delete or rotate the secret of a client or user
 * with `targetRoles`: it must hold or be able to grant each of them. Unlike
 * the backend, it ignores role names EUDIPLO does not know, since user lists
 * contain Keycloak's default roles; the backend has the final say.
 */
export function canManageRoles(callerRoles: string[], targetRoles: string[]): boolean {
  const grantable = grantableRoles(callerRoles);
  const held = effectiveRoles(callerRoles);
  return targetRoles.every(
    (role) =>
      !roles.includes(role as Role) || grantable.includes(role as Role) || held.includes(role)
  );
}

/** A role in the roles select of a client or user form. */
export interface RoleOption {
  role: string;
  /** Cannot be changed: a role of the edited client or user the caller neither holds nor may grant */
  locked: boolean;
}

/**
 * Role choices of a client or user form. The caller can pick every role it may
 * grant, and keep or remove the other EUDIPLO roles of the edited client or
 * user that it holds; it cannot re-add those once saved. Roles it neither
 * holds nor may grant stay selected and locked; `unmanageable` lists them,
 * since they keep the caller from changing the client or user at all.
 */
export function roleChoices(
  callerRoles: string[],
  targetRoles: string[] = []
): { options: RoleOption[]; unmanageable: string[] } {
  const grantable = grantableRoles(callerRoles);
  const kept = targetRoles.filter(
    (role) => roles.includes(role as Role) && !grantable.includes(role as Role)
  );
  return {
    options: [
      ...grantable.map((role) => ({ role, locked: false })),
      ...kept.map((role) => ({ role, locked: !effectiveRoles(callerRoles).includes(role) })),
    ],
    unmanageable: targetRoles.filter((role) => !canManageRoles(callerRoles, [role])),
  };
}
