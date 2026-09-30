import type { ResolveExternalAuthorizationSession } from "../../../../session/application/resolve-external-authorization-session.js";
import type { SessionStore } from "../../../../session/application/session-store.js";
import type { SessionData } from "../../../../session/domain/session-data.js";
import type { AuthorizationIdentity } from "../../../configuration/credentials/domain/authorization-identity.js";
import type {
    CredentialClaimsProvider,
    CredentialClaimsResult,
} from "../../../configuration/credentials/domain/credential-claims.js";
import type { CredentialAuthorizationSources } from "../ports/credential-authorization-sources.js";
import {
    type CorrelateCredentialTokenSession,
    CredentialSessionAuthorizationDenied,
    type VerifiedCredentialToken,
} from "./correlate-credential-token-session.js";

/** Correlates already verified tokens with a tenant session and resolves its claim source. */
export class ResolveCredentialSession {
    constructor(
        private readonly correlation: Pick<
            CorrelateCredentialTokenSession,
            "execute"
        >,
        private readonly sources: Pick<
            CredentialAuthorizationSources,
            "upstreamIdentity"
        >,
        private readonly sessions: Pick<SessionStore, "getForTenant">,
        private readonly externalSessions: Pick<
            ResolveExternalAuthorizationSession,
            "execute"
        >,
        private readonly claims: CredentialClaimsProvider,
    ) {}
    async execute(
        tenantId: string,
        credentialConfigurationId: string,
        token: VerifiedCredentialToken,
    ): Promise<{
        session: SessionData;
        claimsResult?: CredentialClaimsResult;
        isExternalAsToken: boolean;
        isChainedAsToken: boolean;
    }> {
        const reference = await this.correlation.execute(tenantId, token);
        let session: SessionData;
        let identity: AuthorizationIdentity = {
            iss: token.iss,
            sub: token.sub,
            token_claims: token,
        };
        if (reference.kind === "chained") {
            session = await this.sessions.getForTenant(
                tenantId,
                reference.sessionId,
            );
            const upstream = reference.viaChainedIssuer
                ? await this.sources.upstreamIdentity(
                      tenantId,
                      reference.sessionId,
                  )
                : undefined;
            identity = upstream ?? {
                iss: token.iss,
                sub: (token.upstream_sub as string) ?? token.sub,
                token_claims: token,
            };
        } else if (reference.kind === "external") {
            session = await this.externalSessions.execute(
                tenantId,
                token.iss,
                token.sub,
                reference.authorizationServerId,
                reference.bindingClaim,
                reference.sessionId,
            );
        } else {
            session = await this.sessions.getForTenant(
                tenantId,
                reference.sessionId,
            );
            if (token.sub !== session.id)
                throw new CredentialSessionAuthorizationDenied(
                    "The access token is not associated with a valid session",
                );
        }
        const claimsResult = await this.claims.resolveClaims({
            credentialConfigurationId,
            session,
            identity,
            // Verified credentials presented to an OID4VP authorization server
            credentials: session.credentials,
            ...(reference.kind === "external" ? { requireProvider: true } : {}),
        });
        return {
            session,
            claimsResult,
            isExternalAsToken: reference.kind === "external",
            isChainedAsToken: reference.kind === "chained",
        };
    }
}
