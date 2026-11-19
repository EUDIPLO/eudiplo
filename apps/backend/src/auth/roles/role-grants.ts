import { ForbiddenException } from "@nestjs/common";
import { allRoles, Role } from "./role.enum.js";

/** Roles that only a caller with `tenants:manage` can grant. */
const reservedRoles: ReadonlySet<Role> = new Set([
    Role.Tenants,
    Role.TenantAdmin,
]);

/** OpenAPI description of the 403 for a role the caller may not grant. */
export const GRANT_DENIED_DESCRIPTION =
    "The caller may not grant one of the requested roles";

/** OpenAPI description of the 403 for a create that takes over a client with more roles. */
export const TAKEOVER_DENIED_DESCRIPTION =
    "An existing client of the tenant with this ID, whose roles the create would replace, has a role the caller neither holds nor may grant";

/** OpenAPI description of the 403 for a client or user with more roles. */
export function manageDeniedDescription(target: "client" | "user"): string {
    return `The ${target} has a role the caller neither holds nor may grant`;
}

/**
 * Roles a caller may grant to a client or user: every role with
 * `tenants:manage`; with `tenant:admin` every role except `tenants:manage`
 * and `tenant:admin`, as for a configuration bundle; otherwise only the roles
 * it holds itself, except those two.
 */
export function grantableRoles(callerRoles: readonly string[]): Set<Role> {
    if (callerRoles.includes(Role.Tenants)) return new Set(allRoles);
    const source = callerRoles.includes(Role.TenantAdmin)
        ? allRoles
        : allRoles.filter((role) => callerRoles.includes(role));
    return new Set(source.filter((role) => !reservedRoles.has(role)));
}

/**
 * Refuses to grant `roles` if the caller may not grant one of them.
 */
export function assertMayGrantRoles(
    callerRoles: readonly string[],
    roles: readonly string[],
): void {
    const grantable = grantableRoles(callerRoles);
    const denied = roles.filter((role) => !grantable.has(role as Role));
    if (denied.length > 0) {
        throw new ForbiddenException(
            `Cannot grant ${denied.join(", ")}: you can only grant roles you hold, and only tenants:manage grants tenants:manage or tenant:admin`,
        );
    }
}

/**
 * Refuses to replace `currentRoles` with `nextRoles` if the caller may not
 * grant one of the roles that are added. Roles the target keeps need no
 * grant, since the caller already passed `assertMayManageRoles` for them.
 */
export function assertMayChangeRoles(
    callerRoles: readonly string[],
    currentRoles: readonly string[],
    nextRoles: readonly string[],
): void {
    assertMayGrantRoles(
        callerRoles,
        nextRoles.filter((role) => !currentRoles.includes(role)),
    );
}

/**
 * Refuses to change, delete or rotate the secret of a client or user that has
 * a role the caller neither holds nor may grant, so that no caller can take
 * over an account with more rights than its own. Role names EUDIPLO does not
 * know, such as Keycloak client roles, count as roles the caller lacks unless
 * it holds them.
 */
export function assertMayManageRoles(
    callerRoles: readonly string[],
    targetRoles: readonly string[],
    target: string,
): void {
    const grantable = grantableRoles(callerRoles);
    const denied = targetRoles.filter(
        (role) => !grantable.has(role as Role) && !callerRoles.includes(role),
    );
    if (denied.length > 0) {
        throw new ForbiddenException(
            `Cannot manage ${target}: it has ${denied.join(", ")}, which you neither hold nor may grant`,
        );
    }
}
