import type { ResolveExternalAuthorizationSession } from "../../../../session/application/resolve-external-authorization-session.js";
import type { SessionStore } from "../../../../session/application/session-store.js";
import type { SessionData } from "../../../../session/domain/session-data.js";
import type { AuthorizationIdentity } from "../../../configuration/credentials/domain/authorization-identity.js";
import type {
    CredentialClaimsProvider,
    CredentialClaimsResult,
} from "../../../configuration/credentials/domain/credential-claims.js";
import type { CredentialAuthorizationSources } from "../ports/credential-authorization-sources.js";
import { ClassifyAuthorizationServerToken } from "./classify-authorization-server-token.js";

export class CredentialSessionAuthorizationDenied extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CredentialSessionAuthorizationDenied";
    }
}
export interface VerifiedCredentialToken extends Record<string, unknown> {
    iss: string;
    sub: string;
}

/** Correlates already verified tokens with a tenant session and resolves its claim source. */
export class ResolveCredentialSession {
    constructor(
        private readonly sources: CredentialAuthorizationSources,
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
        const issuers = await this.sources.tokenIssuers(tenantId);
        const kind = new ClassifyAuthorizationServerToken().execute({
            ...issuers,
            tokenIssuer: token.iss,
        });
        let session: SessionData;
        let identity: AuthorizationIdentity = {
            iss: token.iss,
            sub: token.sub,
            token_claims: token,
        };
        if (kind === "chained") {
            const issuerState = token.issuer_state as string | undefined;
            if (!issuerState)
                throw new CredentialSessionAuthorizationDenied(
                    "Chained AS token is missing issuer_state claim",
                );
            session = await this.sessions.getForTenant(tenantId, issuerState);
            const upstream =
                token.iss === issuers.chainedIssuer
                    ? await this.sources.upstreamIdentity(issuerState)
                    : undefined;
            identity = upstream ?? {
                iss: token.iss,
                sub: (token.upstream_sub as string) ?? token.sub,
                token_claims: token,
            };
        } else if (kind === "external") {
            const server = await this.sources.externalServer(
                tenantId,
                token.iss,
            );
            if (!server.advertised)
                throw new CredentialSessionAuthorizationDenied(
                    `Token issuer '${token.iss}' is not a configured authorization server`,
                );
            if (!server.configuration)
                throw new CredentialSessionAuthorizationDenied(
                    `Token issuer '${token.iss}' is not a configured external authorization server`,
                );
            const bindingClaim = server.configuration.bindingClaim;
            const bindingValue = token[bindingClaim ?? ""] as
                | string
                | undefined;
            if (!bindingClaim || !bindingValue)
                throw new CredentialSessionAuthorizationDenied(
                    `External authorization server '${token.iss}' is missing the configured session-binding claim '${bindingClaim ?? "<unset>"}'`,
                );
            session = await this.externalSessions.execute(
                tenantId,
                token.iss,
                token.sub,
                server.configuration.id,
                bindingClaim,
                bindingValue,
            );
        } else {
            session = await this.sessions.getForTenant(tenantId, token.sub);
            if (token.sub !== session.id)
                throw new CredentialSessionAuthorizationDenied(
                    "The access token is not associated with a valid session",
                );
        }
        const claimsResult = await this.claims.resolveClaims({
            credentialConfigurationId,
            session,
            identity,
            ...(kind === "external" ? { requireProvider: true } : {}),
        });
        return {
            session,
            claimsResult,
            isExternalAsToken: kind === "external",
            isChainedAsToken: kind === "chained",
        };
    }
}
