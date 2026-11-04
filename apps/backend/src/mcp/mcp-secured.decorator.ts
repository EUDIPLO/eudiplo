import { applyDecorators, UseGuards } from "@nestjs/common";
import type { Role } from "../auth/roles/role.enum.js";
import { RoleMatch, Roles } from "../auth/roles/roles.decorator.js";
import { McpRolesGuard } from "./mcp-roles.guard.js";

/**
 * Requires `roles` for an MCP tool, as `@Secured` does for a management
 * endpoint: one of them by default, all of them with `match: "all"`.
 */
export function McpSecured(
    roles: Role[],
    { match = "any" }: { match?: RoleMatch } = {},
) {
    return applyDecorators(Roles(roles, match), UseGuards(McpRolesGuard));
}
