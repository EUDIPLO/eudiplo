import type { SessionRepository } from "../ports/session.repository.js";

export class ExternalSessionBindingError extends Error {}

export class ResolveExternalAuthorizationSession {
    constructor(
        private readonly sessions: Pick<
            SessionRepository,
            "bindExternalAuthorization"
        >,
    ) {}

    async execute(
        tenantId: string,
        externalIssuer: string,
        externalSubject: string,
        authorizationServerId?: string,
        bindingClaim?: string,
        bindingValue?: string,
    ) {
        if (!authorizationServerId || !bindingClaim || !bindingValue) {
            throw new ExternalSessionBindingError(
                "External authorization-server session resolution requires the authorization server id, the configured claim name, and the session-correlation value",
            );
        }
        const session = await this.sessions.bindExternalAuthorization({
            tenantId,
            externalIssuer,
            externalSubject,
            authorizationServerId,
            sessionId: bindingValue,
        });
        if (!session)
            throw new ExternalSessionBindingError(
                `No existing issuance session found for external AS token for tenant ${tenantId}, auth server ${authorizationServerId}, claim ${bindingClaim}, value ${bindingValue}`,
            );
        return session;
    }
}
