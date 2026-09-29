import type { Jwk } from "@openid4vc/oauth2";
import type { SessionData } from "../../../../session/domain/session-data.js";
import type { AttributeProviderRepository } from "../../attribute-provider/ports/attribute-provider.repository.js";
import { assertClaimsMatchConfiguration } from "../domain/credential-claims-validation.js";
import type { CredentialConfigurationRepository } from "../ports/credential-configuration.repository.js";
import type {
    IssuerFederationContext,
    SessionCredentialClaims,
} from "../ports/credential-generation-context.js";
import { buildClaims } from "../utils/derive.js";
import type { ClaimFieldDefinition } from "../utils/types.js";
import type { CredentialIssuerFormatRegistry } from "./credential-issuer-format-registry.js";

export class IssueCredential {
    constructor(
        private readonly configurations: Pick<
            CredentialConfigurationRepository,
            "getForTenant"
        >,
        private readonly attributeProviders: Pick<
            AttributeProviderRepository,
            "findForTenant"
        >,
        private readonly claims: SessionCredentialClaims,
        private readonly federation: IssuerFederationContext,
        private readonly formats: CredentialIssuerFormatRegistry,
    ) {}

    async execute(command: {
        credentialConfigurationId: string;
        holderKey: Jwk;
        session: SessionData;
        preloadedClaims?: Record<string, unknown>;
        issuanceSetId?: string;
    }): Promise<string> {
        const { credentialConfigurationId, session } = command;
        const configuration = await this.configurations.getForTenant(
            session.tenantId,
            credentialConfigurationId,
        );
        let claims = buildClaims(
            configuration.fields as ClaimFieldDefinition[],
        ) as Record<string, unknown>;
        if (command.preloadedClaims) {
            claims = command.preloadedClaims;
        } else {
            const source =
                session.credentialPayload?.credentialClaims?.[
                    credentialConfigurationId
                ];
            if (source?.type === "inline") {
                claims = source.claims;
            } else {
                let webhook =
                    source?.type === "webhook" ? source.webhook : undefined;
                if (!webhook && configuration.attributeProviderId) {
                    const provider =
                        await this.attributeProviders.findForTenant(
                            session.tenantId,
                            configuration.attributeProviderId,
                        );
                    if (provider)
                        webhook = { url: provider.url, auth: provider.auth };
                }
                if (webhook) {
                    claims =
                        (await this.claims.resolve(
                            webhook,
                            session,
                            credentialConfigurationId,
                        )) ?? claims;
                }
            }
        }
        // Final claims from every source must match the configuration before signing.
        assertClaimsMatchConfiguration(configuration, claims);
        // Existing direct-generation behavior tolerates unavailable issuance settings.
        const federationEntityId = await this.federation
            .entityIdForTenant(session.tenantId)
            .catch(() => undefined);
        return this.formats.resolve(configuration.config.format).issue({
            credentialConfiguration: configuration,
            holderKey: command.holderKey,
            session,
            claims,
            federationEntityId,
            issuanceSetId: command.issuanceSetId,
        });
    }
}
