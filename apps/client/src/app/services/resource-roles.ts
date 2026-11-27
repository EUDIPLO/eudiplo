import type { Route } from '@angular/router';
import { RoleGuard } from '../guards/roles.guard';
import type { Role } from './role-grants';

/**
 * The roles the backend checks for the configuration of a side: reading it,
 * and creating, changing or deleting it. The manage roles include the read
 * roles (`@eudiplo/config-format/role-model.js`).
 */

/** Credential configs, issuer settings, attribute providers and status lists. */
export const ISSUANCE_READ_ROLES: Role[] = ['issuance:read'];
export const ISSUANCE_WRITE_ROLES: Role[] = ['issuance:manage'];

/** Presentation configs and OIDC clients. */
export const PRESENTATION_READ_ROLES: Role[] = ['presentation:read'];
export const PRESENTATION_WRITE_ROLES: Role[] = ['presentation:manage'];

/** Trust lists, federation trust anchors, webhook endpoints and session settings, which both sides use. */
export const SHARED_READ_ROLES: Role[] = ['issuance:read', 'presentation:read'];
export const SHARED_WRITE_ROLES: Role[] = ['issuance:manage', 'presentation:manage'];

/**
 * Route settings for a page that only a caller with one of `roles` can use,
 * such as the form of a resource whose list the read roles open.
 */
export function requireRole(roles: Role | Role[]): Pick<Route, 'canActivate' | 'data'> {
  return { canActivate: [RoleGuard], data: { role: roles } };
}
