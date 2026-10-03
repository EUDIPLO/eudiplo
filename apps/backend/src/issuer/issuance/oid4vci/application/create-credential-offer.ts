import type { CreateSession } from "../../../../session/application/create-session.js";
import type { SessionStore } from "../../../../session/application/session-store.js";
import type { SessionOfferRequest } from "../../../../session/domain/session-data.js";
import type { IssuanceConfigRepository } from "../../../configuration/issuance/ports/issuance-config.repository.js";
import type { CredentialOfferProtocol } from "../ports/credential-offer-protocol.js";
import { BuildCredentialOfferGrants } from "./build-credential-offer-grants.js";
import type { SelectAuthorizationServer } from "./select-authorization-server.js";

export class CreateCredentialOffer {
    constructor(
        private readonly sessions: Pick<CreateSession, "execute">,
        private readonly update: Pick<SessionStore, "updateForTenant">,
        private readonly authorizationServers: Pick<
            SelectAuthorizationServer,
            "execute"
        >,
        private readonly protocol: CredentialOfferProtocol,
        private readonly newId: () => string,
        private readonly issuanceConfigs: Pick<
            IssuanceConfigRepository,
            "getForTenant"
        >,
    ) {}
    async execute(
        tenantId: string,
        request: SessionOfferRequest,
    ): Promise<{ session: string; uri: string }> {
        const id = this.newId();
        const selection = await this.authorizationServers.execute(
            tenantId,
            request.authorization_server,
        );
        const authorizationCode =
            request.flow === "pre_authorized_code" ? this.newId() : undefined;
        const grants = new BuildCredentialOfferGrants().execute({
            flow: request.flow,
            issuerState: id,
            authorizationCode,
            txCode: request.tx_code,
            txCodeDescription: request.tx_code_description,
            authorizationServer: selection.issuer,
        });
        await Promise.all(
            Object.entries(request.credentialClaims ?? {}).map(
                ([configurationId, source]) =>
                    source.type === "inline"
                        ? this.protocol.validateClaims(
                              tenantId,
                              configurationId,
                              source.claims,
                          )
                        : Promise.resolve(),
            ),
        );
        // The request overrides the configured lifetime; without both the
        // offer does not expire (only the session retention removes it).
        const lifetimeSeconds =
            request.offerLifetimeSeconds ??
            (await this.issuanceConfigs.getForTenant(tenantId))
                .offerLifetimeSeconds;
        const session = await this.sessions.execute({
            id,
            tenantId,
            credentialPayload: request,
            authorization_code: authorizationCode,
            webhookEndpointId: request.webhookEndpointId,
            authorizationServerId: selection.sessionServerId,
            ...(lifetimeSeconds
                ? {
                      expiresAt: new Date(Date.now() + lifetimeSeconds * 1000),
                  }
                : {}),
        });
        const offer = await this.protocol.encode(
            session,
            request.credentialConfigurationIds,
            grants,
        );
        await this.update.updateForTenant(tenantId, id, {
            offer: offer.object,
            offerUrl: offer.uri,
        });
        return { session: session.id, uri: offer.uri };
    }
}
