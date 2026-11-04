import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { McpExecutionContext } from "@nestjs/mcp";
import {
    meetsRoleRequirement,
    ROLES_KEY,
    RoleRequirement,
} from "../auth/roles/roles.decorator.js";
import { callerOf, type McpRequest } from "./mcp-caller.js";

/**
 * The role check of `@McpSecured` for MCP tool calls, with the same rules as
 * the RolesGuard of the management endpoints. The token comes from the HTTP
 * request of the MCP endpoint, where the JWT guard put it.
 */
@Injectable()
export class McpRolesGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    canActivate(context: ExecutionContext): boolean {
        const requirement = this.reflector.getAllAndOverride<RoleRequirement>(
            ROLES_KEY,
            [context.getHandler(), context.getClass()],
        );
        // Every tool names its roles: one without is a bug, not an open tool.
        if (!requirement) {
            throw new ForbiddenException("This tool declares no roles");
        }
        const token = callerOf(
            McpExecutionContext.create(context).getContext<McpRequest>(),
        );
        if (!meetsRoleRequirement(requirement, token.roles)) {
            const which = requirement.match === "all" ? "all" : "one";
            throw new ForbiddenException(
                `This tool needs ${which} of the roles ${requirement.roles.join(", ")}`,
            );
        }
        return true;
    }
}
