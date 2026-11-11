import { ExecutionContext, ForbiddenException, Type } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { Role } from "./roles/role.enum.js";
import { Secured } from "./secure.decorator.js";
import { TenantContextGuard } from "./tenant-context.guard.js";
import type { TokenPayload } from "./token.decorator.js";

@Secured([Role.Issuances])
class TenantController {
    inherited() {}

    @Secured([Role.Issuances, Role.Tenants], { tenant: "optional" })
    optional() {}
}

@Secured([Role.Issuances], { tenant: "optional" })
class InstanceController {
    inherited() {}

    @Secured([Role.Issuances])
    required() {}
}

class OpenController {
    open() {}
}

const tenant = { id: "acme" } as TokenPayload["entity"];

function allows<T>(
    controller: Type<T>,
    handler: keyof T & string,
    user: Partial<TokenPayload>,
): boolean {
    const context = {
        getHandler: () => controller.prototype[handler],
        getClass: () => controller,
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
    return new TenantContextGuard(new Reflector()).canActivate(context);
}

describe("TenantContextGuard", () => {
    it("lets a token with a tenant through", () => {
        expect(allows(TenantController, "inherited", { entity: tenant })).toBe(
            true,
        );
    });

    it.each([
        [TenantController, "inherited"],
        [InstanceController, "required"],
    ] as const)(
        "refuses a token without a tenant with 403 by default: %o %s",
        (controller, handler) => {
            expect(() =>
                allows(controller, handler as never, { roles: [] }),
            ).toThrow(
                new ForbiddenException(
                    "This endpoint requires a tenant context. Use a tenant-bound account.",
                ),
            );
        },
    );

    it.each([
        [TenantController, "optional"],
        [InstanceController, "inherited"],
        [OpenController, "open"],
    ] as const)(
        "lets a token without a tenant through where it is optional or not secured: %o %s",
        (controller, handler) => {
            expect(allows(controller, handler as never, { roles: [] })).toBe(
                true,
            );
        },
    );

    it("runs after the role check, so a missing role is reported first", () => {
        const guards = Reflect.getMetadata(GUARDS_METADATA, TenantController);

        expect(guards.at(-1)).toBe(TenantContextGuard);
    });
});
