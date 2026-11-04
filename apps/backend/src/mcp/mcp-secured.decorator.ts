import {
    applyDecorators,
    Injectable,
    UseFilters,
    UseGuards,
} from "@nestjs/common";
import type { Role } from "../auth/roles/role.enum.js";
import { RoleMatch, Roles } from "../auth/roles/roles.decorator.js";
import { McpErrorFilter } from "./mcp-error.filter.js";
import { McpRolesGuard } from "./mcp-roles.guard.js";

/**
 * A provider of MCP tools. Every call of its tools runs the role check, so a
 * tool without `@McpSecured` is refused instead of open, and its application
 * errors are mapped as for the management API.
 */
export function McpTools(): ClassDecorator {
    return applyDecorators(
        Injectable(),
        UseGuards(McpRolesGuard),
        UseFilters(new McpErrorFilter()),
    );
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
