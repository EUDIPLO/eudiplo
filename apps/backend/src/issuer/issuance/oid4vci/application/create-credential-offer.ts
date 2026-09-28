import type { CreateSession } from "../../../../session/application/create-session.js";
import type { UpdateSessionForTenant } from "../../../../session/application/update-session-for-tenant.js";
import type { SessionOfferRequest } from "../../../../session/domain/session-data.js";
import type { CredentialOfferProtocol } from "../ports/credential-offer-protocol.js";
import { BuildCredentialOfferGrants } from "./build-credential-offer-grants.js";

export class CreateCredentialOffer {
    constructor(
        private readonly sessions: Pick<CreateSession, "execute">,
        private readonly update: Pick<UpdateSessionForTenant, "execute">,
        private readonly protocol: CredentialOfferProtocol,
        private readonly newId: () => string,
    ) {}
    async execute(
        tenantId: string,
        request: SessionOfferRequest,
    ): Promise<{ session: string; uri: string }> {
        const id = this.newId();
        const selection = await this.protocol.selectAuthorizationServer(
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
        const session = await this.sessions.execute({
            id,
            tenantId,
            credentialPayload: request,
            authorization_code: authorizationCode,
            webhookEndpointId: request.webhookEndpointId,
            authorizationServerId: selection.sessionServerId,
        });
        const offer = await this.protocol.encode(
            session,
            request.credentialConfigurationIds,
            grants,
        );
        await this.update.execute(tenantId, id, {
            offer: offer.object,
            offerUrl: offer.uri,
        });
        return { session: session.id, uri: offer.uri };
    }
}
