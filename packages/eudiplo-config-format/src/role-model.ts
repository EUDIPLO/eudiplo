/**
 * How EUDIPLO roles include each other. The backend expands the roles of every
 * token with `effectiveRoles` before any role check, and the Web Client uses
 * the same table to show what a role includes.
 */

/** Roles that each role includes directly; `effectiveRoles` follows them transitively. */
export const IMPLIED_ROLES: Readonly<Record<string, readonly string[]>> = {
    "tenants:manage": ["tenant:admin"],
    "tenant:admin": [
        "issuance:manage",
        "presentation:manage",
        "clients:manage",
        "users:manage",
        "registrar:manage",
        "audit:read",
        "sessions:read",
        "keys:export",
    ],
    "issuance:manage": ["issuance:offer", "credentials:status"],
    "issuance:offer": ["issuance:read"],
    "issuance:read": [],
    "presentation:manage": ["presentation:request"],
    "presentation:request": ["presentation:read"],
    "presentation:read": [],
    "keys:export": ["keys:manage"],
    "keys:manage": [],
    "clients:manage": [],
    "users:manage": [],
    "registrar:manage": [],
    "audit:read": [],
    "sessions:read": [],
    "credentials:status": [],
};

/**
 * `roles` and every role they include, also transitively. Names that are no
 * EUDIPLO role, such as Keycloak's `default-roles-<realm>`, are kept as they
 * are. Expanding an expanded list changes nothing.
 */
export function effectiveRoles(roles: readonly string[]): string[] {
    const result = new Set<string>();
    const pending = [...roles];
    while (pending.length > 0) {
        const role = pending.pop() as string;
        if (result.has(role)) continue;
        result.add(role);
        // Own keys only: a token may name any role, "constructor" included.
        if (Object.hasOwn(IMPLIED_ROLES, role)) {
            pending.push(...IMPLIED_ROLES[role]);
        }
    }
    return [...result];
}

/** The roles that `role` includes besides itself. */
export function includedRoles(role: string): string[] {
    return effectiveRoles([role]).filter((included) => included !== role);
}
