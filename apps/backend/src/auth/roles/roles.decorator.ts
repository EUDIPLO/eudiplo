import { SetMetadata } from "@nestjs/common";
import { Role } from "./role.enum.js";

export const ROLES_KEY = "roles";

/** `any`: one of the roles is enough. `all`: the token needs every role. */
export type RoleMatch = "any" | "all";

/** Role check of a handler or controller, read by the RolesGuard. */
export interface RoleRequirement {
    roles: Role[];
    match: RoleMatch;
}

export const Roles = (roles: Role[], match: RoleMatch) =>
    SetMetadata(ROLES_KEY, { roles, match } satisfies RoleRequirement);

/**
 * Whether `roles` meet `requirement`. An empty list denies in both modes;
 * `[].every()` alone would allow.
 */
export function meetsRoleRequirement(
    requirement: RoleRequirement,
    roles: readonly Role[] | undefined,
): boolean {
    const granted = (role: Role) => roles?.includes(role) ?? false;
    return requirement.match === "all"
        ? requirement.roles.length > 0 && requirement.roles.every(granted)
        : requirement.roles.some(granted);
}
