import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { McpContext } from "@nestjs/mcp";
import type { TokenPayload } from "../auth/token.decorator.js";

/** The HTTP request of an MCP call, after the endpoint's JWT guard. */
export interface McpRequest {
    user?: TokenPayload;
}

/**
 * The verified access token of an MCP call. The JWT guard of the endpoint
 * sets it, as for every management endpoint.
 */
export function callerOf(
    context: Pick<McpContext<McpRequest>, "request">,
): TokenPayload {
    const token = context.request?.user;
    // Only the HTTP endpoint behind the JWT guard serves the tools.
    if (!token) {
        throw new UnauthorizedException();
    }
    return token;
}

/** The caller's tenant. Tokens of the root client have none. */
export function tenantOf(token: TokenPayload): string {
    const tenantId = token.entity?.id;
    if (!tenantId) {
        throw new ForbiddenException(
            "This tool reads the data of a tenant, and the access token belongs to no tenant",
        );
    }
    return tenantId;
}
