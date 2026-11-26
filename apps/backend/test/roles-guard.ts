import type { ExecutionContext, Type } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { effectiveRoles, type Role } from "../src/auth/roles/role.enum.js";
import { RolesGuard } from "../src/auth/roles/roles.guard.js";

/**
 * Runs the role check that `@Secured` applies to a controller handler, with
 * the roles that `roles` imply, as `JwtStrategy` passes them on.
 */
export function rolesAllow<T>(
    controller: Type<T>,
    handler: keyof T & string,
    roles: Role[],
): boolean {
    const context = {
        getHandler: () => controller.prototype[handler],
        getClass: () => controller,
        switchToHttp: () => ({
            getRequest: () => ({
                user: { roles: effectiveRoles(roles) },
            }),
        }),
    } as unknown as ExecutionContext;
    return new RolesGuard(new Reflector()).canActivate(context);
}
