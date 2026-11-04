import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { ClientData } from "./client/domain/client-data.js";
import { Role } from "./roles/role.enum.js";
import type { TenantData } from "./tenant/domain/tenant-data.js";

/**
 * Token decorator
 */
export const Token = createParamDecorator(
    (data: unknown, ctx: ExecutionContext) => {
        const request = ctx.switchToHttp().getRequest();
        return request.user as TokenPayload; // Access the token payload on the request object
    },
);

/**
 * Values of the user token
 */
export interface TokenPayload {
    /**
     * Tenant entity
     */
    entity?: TenantData;

    /**
     * Role for the user
     */
    roles: Role[];

    /**
     * Stored client the token was issued to, with its resource-level
     * restrictions. Always set for tokens of the built-in server; with
     * Keycloak only for clients EUDIPLO created.
     */
    client?: ClientData;

    /**
     * Token subject claim.
     */
    subject?: string;

    /**
     * Authorized party / OAuth client identifier when present.
     */
    authorizedParty?: string;
}

/**
 * The OAuth client a token was issued to: the stored client, otherwise the
 * authorized party of a Keycloak token.
 */
export function clientIdOf(token: TokenPayload): string | undefined {
    return token.client?.clientId || token.authorizedParty || undefined;
}

export interface InternalTokenPayload extends TokenPayload {
    /**
     * Tenant ID
     */
    tenant_id: string;

    /**
     * Client ID (subject of the token)
     */
    sub?: string;

    /** Issued at, in seconds since the epoch. */
    iat?: number;

    /** Expiry, in seconds since the epoch. */
    exp?: number;

    /**
     * The client's `tokensValidAfter` in milliseconds since the epoch, read
     * together with the secret when the token was issued. Absent for clients
     * from before 10.0, which have none.
     */
    credentials_at?: number;
}
