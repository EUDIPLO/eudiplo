import { randomUUID } from "node:crypto";
import type { SessionStore } from "../../../../../session/application/session-store.js";
import type { Oid4vciSettings } from "../../oid4vci-settings.js";
import { OAuthError } from "../domain/oauth-error.js";
import {
    AUTHORIZATION_CODE_LIFETIME_SECONDS,
    buildAuthorizationResponseUrl,
} from "../domain/pushed-authorization-request.js";
import { builtInAuthorizationServerIssuer } from "./build-built-in-authorization-server-metadata.js";

/** The authorization request did not reference a pushed request. */
export class RequestUriMissing extends Error {
    constructor() {
        super("request_uri not found or not provided in the request");
        this.name = "RequestUriMissing";
    }
}

/**
 * Authorization endpoint of the built-in authorization server. Redeems a PAR
 * `request_uri` once and redirects to the client with an authorization code,
 * or with an OAuth error once the redirect_uri is known (RFC 9126 Section 4).
 *
 * Throws {@link RequestUriMissing} or an `invalid_request_uri`
 * {@link OAuthError} when no redirect is possible.
 */
export class AuthorizePushedRequest {
    constructor(
        private readonly sessions: Pick<
            SessionStore,
            "getByRequestUri" | "consumeRequestUri" | "updateForTenant"
        >,
        private readonly settings: Oid4vciSettings,
    ) {}

    async execute(
        tenantId: string,
        values: { request_uri?: string; client_id?: string },
    ): Promise<string> {
        if (!values.request_uri) {
            throw new RequestUriMissing();
        }

        const session = await this.sessions
            .getByRequestUri(tenantId, values.request_uri)
            .catch(() => {
                throw new OAuthError(
                    "invalid_request_uri",
                    "Unknown request_uri",
                );
            });

        const authQueries = session.auth_queries;
        const redirectUri = authQueries?.redirect_uri;
        if (!redirectUri) {
            throw new OAuthError(
                "invalid_request_uri",
                "request_uri has no redirect_uri bound",
            );
        }

        const iss = builtInAuthorizationServerIssuer(this.settings, tenantId);
        const redirectError = (error: string, description: string) =>
            buildAuthorizationResponseUrl(redirectUri, {
                error,
                error_description: description,
                state: authQueries.state,
                iss,
            });

        if (values.client_id !== authQueries.client_id) {
            return redirectError(
                "invalid_request",
                "client_id does not match the pushed authorization request",
            );
        }

        // Expire the request_uri on use so it cannot be redeemed twice (RFC 9126
        // Section 7.3). The conditional update lets exactly one of several
        // concurrent requests win; the others are treated as already used.
        const now = new Date();
        const redeemed =
            !!session.request_uri_expires_at &&
            (await this.sessions.consumeRequestUri(
                tenantId,
                session.id,
                session.request_uri_expires_at,
                now,
            ));
        if (!redeemed) {
            return redirectError(
                "invalid_request_uri",
                "request_uri is expired or was already used",
            );
        }

        const code = randomUUID();
        await this.sessions.updateForTenant(tenantId, session.id, {
            authorization_code: code,
            authorization_code_expires_at: new Date(
                Date.now() + AUTHORIZATION_CODE_LIFETIME_SECONDS * 1000,
            ),
        });

        return buildAuthorizationResponseUrl(redirectUri, {
            code,
            state: authQueries.state,
            iss,
        });
    }
}
