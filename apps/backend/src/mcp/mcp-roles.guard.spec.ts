import {
    type ExecutionContext,
    ForbiddenException,
    UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host.js";
import { describe, expect, it } from "vitest";
import { Role } from "../auth/roles/role.enum.js";
import type { TokenPayload } from "../auth/token.decorator.js";
import { McpRolesGuard } from "./mcp-roles.guard.js";
import { McpSecured } from "./mcp-secured.decorator.js";

class Tools {
    @McpSecured([Role.IssuanceOffer, Role.SessionsRead])
    any() {}

    @McpSecured([Role.IssuanceOffer, Role.SessionsRead], { match: "all" })
    all() {}

    undeclared() {}
}

/** An MCP call of `handler`, made with the HTTP request `request`. */
function call(
    handler: keyof Tools,
    request?: { user?: Partial<TokenPayload> },
): ExecutionContext {
    const context = new ExecutionContextHost(
        [{}, { request }],
        Tools,
        Tools.prototype[handler],
    );
    context.setType("mcp");
    return context;
}

const guard = new McpRolesGuard(new Reflector());

describe("McpRolesGuard", () => {
    it("allows a token with one of the roles", () => {
        expect(
            guard.canActivate(
                call("any", { user: { roles: [Role.SessionsRead] } }),
            ),
        ).toBe(true);
    });

    it("refuses a token without the roles and names them", () => {
        expect(() =>
            guard.canActivate(
                call("any", { user: { roles: [Role.Issuances] } }),
            ),
        ).toThrow(
            new ForbiddenException(
                "This tool needs one of the roles issuance:offer, sessions:read",
            ),
        );
    });

    it("requires every role with match all", () => {
        expect(() =>
            guard.canActivate(
                call("all", { user: { roles: [Role.IssuanceOffer] } }),
            ),
        ).toThrow(
            new ForbiddenException(
                "This tool needs all of the roles issuance:offer, sessions:read",
            ),
        );
        expect(
            guard.canActivate(
                call("all", {
                    user: { roles: [Role.IssuanceOffer, Role.SessionsRead] },
                }),
            ),
        ).toBe(true);
    });

    it("refuses a tool that declares no roles", () => {
        expect(() =>
            guard.canActivate(
                call("undeclared", { user: { roles: [Role.Tenants] } }),
            ),
        ).toThrow(new ForbiddenException("This tool declares no roles"));
    });

    it("refuses a call without a verified token, as over stdio", () => {
        expect(() => guard.canActivate(call("any"))).toThrow(
            UnauthorizedException,
        );
        expect(() => guard.canActivate(call("any", {}))).toThrow(
            UnauthorizedException,
        );
    });
});
