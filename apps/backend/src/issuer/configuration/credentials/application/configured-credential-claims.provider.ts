import type { WebhookConfiguration } from "../../../../webhook/domain/webhook-configuration.js";
import type { AttributeProviderRepository } from "../../attribute-provider/ports/attribute-provider.repository.js";
import type {
    CredentialClaimsProvider,
    CredentialClaimsRequest,
    CredentialClaimsResult,
} from "../domain/credential-claims.js";
import { CredentialClaimsResolutionError } from "../domain/credential-claims.js";
import type { CredentialConfigurationRepository } from "../ports/credential-configuration.repository.js";
import type { RemoteCredentialClaims } from "../ports/remote-credential-claims.js";

export class ConfiguredCredentialClaimsProvider
    implements CredentialClaimsProvider
{
    constructor(
        private readonly credentialConfigs: Pick<
            CredentialConfigurationRepository,
            "findForTenant"
        >,
        private readonly attributeProviders: Pick<
            AttributeProviderRepository,
            "findForTenant"
        >,
        private readonly remoteClaims: RemoteCredentialClaims,
    ) {}

    async resolveClaims({
        credentialConfigurationId,
        session,
        identity,
        credentials,
        requireProvider,
    }: CredentialClaimsRequest): Promise<CredentialClaimsResult | undefined> {
        const source =
            session.credentialPayload?.credentialClaims?.[
                credentialConfigurationId
            ];

        if (source?.type === "inline") {
            return { deferred: false, claims: source.claims };
        }

        let webhook: WebhookConfiguration | undefined;
        if (source?.type === "webhook") {
            webhook = source.webhook;
        } else if (source?.type === "attributeProvider") {
            webhook = await this.resolveAttributeProvider(
                source.attributeProviderId,
                session.tenantId,
            );
        } else {
            const config = await this.credentialConfigs.findForTenant(
                session.tenantId,
                credentialConfigurationId,
            );
            if (!config) {
                throw new CredentialClaimsResolutionError(
                    "credential_configuration_not_found",
                    `Credential configuration '${credentialConfigurationId}' not found`,
                );
            }
            if (config.attributeProviderId) {
                webhook = await this.resolveAttributeProvider(
                    config.attributeProviderId,
                    session.tenantId,
                );
            }
        }

        if (!webhook) {
            if (requireProvider) {
                throw new CredentialClaimsResolutionError(
                    "provider_required",
                    `Authorization code flow requires an attribute provider to be configured on credential '${credentialConfigurationId}' ` +
                        `or provided at offer time.`,
                );
            }
            return undefined;
        }

        return this.remoteClaims.fetchClaims({
            webhook,
            session: session.id,
            ...(session.reference ? { reference: session.reference } : {}),
            credentialConfigurationId,
            identity,
            credentials,
        });
    }

    private async resolveAttributeProvider(
        id: string,
        tenantId: string,
    ): Promise<WebhookConfiguration> {
        const provider = await this.attributeProviders.findForTenant(
            tenantId,
            id,
        );
        if (!provider) {
            throw new CredentialClaimsResolutionError(
                "attribute_provider_not_found",
                `Attribute provider '${id}' not found`,
            );
        }
        return { url: provider.url, auth: provider.auth };
    }
}
