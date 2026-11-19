import type { Role } from '../services/role-grants';

/** Roles that may open and manage webhook endpoints; either one is enough. */
export const WEBHOOK_ENDPOINT_ROLES: Role[] = ['issuance:manage', 'presentation:manage'];
