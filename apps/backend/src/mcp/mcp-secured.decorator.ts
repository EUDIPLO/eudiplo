import { applyDecorators, Injectable, UseGuards } from "@nestjs/common";
import type { Role } from "../auth/roles/role.enum.js";
import { RoleMatch, Roles } from "../auth/roles/roles.decorator.js";
import { McpRolesGuard } from "./mcp-roles.guard.js";

/**
 * A provider of MCP tools. Every call of its tools runs the role check, so a
 * tool without `@McpSecured` is refused instead of open.
 */
export function McpTools(): ClassDecorator {
    return applyDecorators(Injectable(), UseGuards(McpRolesGuard));
}

/**
 * The roles an MCP tool needs, as `@Secured` for a management endpoint: one
 * of them by default, all of them with `match: "all"`. The tool's class must
 * be an `@McpTools()` provider.
 */
export function McpSecured(
    roles: Role[],
    { match = "any" }: { match?: RoleMatch } = {},
) {
    return Roles(roles, match);
}
