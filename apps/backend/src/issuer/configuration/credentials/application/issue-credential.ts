import type { Jwk } from "@openid4vc/oauth2";
import type { SessionData } from "../../../../session/domain/session-data.js";
import { assertClaimsMatchConfiguration } from "../domain/credential-claims-validation.js";
import type { CredentialConfigurationRepository } from "../ports/credential-configuration.repository.js";
import type { IssuerFederationContext } from "../ports/credential-generation-context.js";
import { buildClaims } from "../utils/derive.js";
import type { ClaimFieldDefinition } from "../utils/types.js";
import type { CredentialIssuerFormatRegistry } from "./credential-issuer-format-registry.js";

export class IssueCredential {
    constructor(
        private readonly configurations: Pick<
            CredentialConfigurationRepository,
            "getForTenant"
        >,
        private readonly federation: IssuerFederationContext,
        private readonly formats: CredentialIssuerFormatRegistry,
    ) {}

    /**
     * Signs one credential with the claims the caller resolved from the
     * session's claim source (see `CredentialClaimsProvider`). Without claims,
     * no dynamic source applies and the static defaults are issued.
     */
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
        const claims =
            command.preloadedClaims ??
            (buildClaims(
                configuration.fields as ClaimFieldDefinition[],
            ) as Record<string, unknown>);
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
