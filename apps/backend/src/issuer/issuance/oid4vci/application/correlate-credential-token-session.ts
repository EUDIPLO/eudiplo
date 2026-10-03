import { SessionNotFound } from "../../../../session/application/session-errors.js";
import type { SessionStore } from "../../../../session/application/session-store.js";
import type { SessionData } from "../../../../session/domain/session-data.js";
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

/** The session an access token claims to belong to, and how it was derived. */
export type CredentialTokenSessionReference =
    | { kind: "local"; sessionId: string }
    | {
          kind: "chained";
          sessionId: string;
          /** The token was issued by the tenant's legacy chained AS. */
          viaChainedIssuer: boolean;
      }
    | {
          kind: "external";
          sessionId: string;
          authorizationServerId: string;
          bindingClaim: string;
      };

/**
 * Correlates an already verified access token with the tenant session it was
 * issued for, without resolving claims or binding external identities:
 * local tokens carry the session id in `sub`, chained tokens in
 * `issuer_state`, and external tokens in the configured binding claim.
 */
export class CorrelateCredentialTokenSession {
    constructor(
        private readonly sources: Pick<
            CredentialAuthorizationSources,
            "tokenIssuers" | "externalServer"
        >,
        private readonly sessions: Pick<SessionStore, "getForTenant">,
    ) {}

    /** @throws CredentialSessionAuthorizationDenied when the token names no session. */
    async execute(
        tenantId: string,
        token: VerifiedCredentialToken,
    ): Promise<CredentialTokenSessionReference> {
        const issuers = await this.sources.tokenIssuers(tenantId);
        const kind = new ClassifyAuthorizationServerToken().execute({
            ...issuers,
            tokenIssuer: token.iss,
        });
        if (kind === "chained") {
            const issuerState = token.issuer_state as string | undefined;
            if (!issuerState)
                throw new CredentialSessionAuthorizationDenied(
                    "Chained AS token is missing issuer_state claim",
                );
            return {
                kind,
                sessionId: issuerState,
                viaChainedIssuer: token.iss === issuers.chainedIssuer,
            };
        }
        if (kind === "external") {
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
            return {
                kind,
                sessionId: bindingValue,
                authorizationServerId: server.configuration.id,
                bindingClaim,
            };
        }
        return { kind, sessionId: token.sub };
    }

    /**
     * Loads the tenant session the token belongs to, for requests made after
     * the credential was issued. External tokens must match the identity
     * already bound to that session; nothing is re-bound, so this also works
     * after the session is no longer active.
     * @throws CredentialSessionAuthorizationDenied when the token names no session or is not bound to it.
     * @throws SessionNotFound when the named session does not exist in the tenant.
     */
    async resolveSession(
        tenantId: string,
        token: VerifiedCredentialToken,
    ): Promise<SessionData> {
        const reference = await this.execute(tenantId, token);
        const session = await this.sessions.getForTenant(
            tenantId,
            reference.sessionId,
        );
        if (!isBoundTo(reference, token, session))
            throw new CredentialSessionAuthorizationDenied(
                "The access token is not associated with a valid session",
            );
        return session;
    }

    /**
     * Whether the token belongs to the given session of the tenant, with the
     * same rules as {@link resolveSession}.
     */
    async belongsToSession(
        tenantId: string,
        token: VerifiedCredentialToken,
        sessionId: string,
    ): Promise<boolean> {
        let reference: CredentialTokenSessionReference;
        try {
            reference = await this.execute(tenantId, token);
        } catch (error) {
            if (error instanceof CredentialSessionAuthorizationDenied)
                return false;
            throw error;
        }
        if (reference.sessionId !== sessionId) return false;
        if (reference.kind !== "external") return true;
        try {
            const session = await this.sessions.getForTenant(
                tenantId,
                sessionId,
            );
            return isBoundTo(reference, token, session);
        } catch (error) {
            if (error instanceof SessionNotFound) return false;
            throw error;
        }
    }
}

/** External tokens must carry the identity bound to the session. */
function isBoundTo(
    reference: CredentialTokenSessionReference,
    token: VerifiedCredentialToken,
    session: SessionData,
): boolean {
    if (session.id !== reference.sessionId) return false;
    if (reference.kind !== "external") return true;
    return (
        session.authorizationServerId === reference.authorizationServerId &&
        session.externalIssuer === token.iss &&
        session.externalSubject === token.sub
    );
}
