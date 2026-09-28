import type { CredentialConfiguration } from "../domain/credential-configuration.js";
import type { CredentialConfig } from "../entities/credential.entity.js";
export function toCredentialConfiguration(
    row: CredentialConfig,
): CredentialConfiguration {
    const {
        tenant: _tenant,
        keyChain: _keyChain,
        attributeProvider: _attributeProvider,
        webhookEndpoint: _webhookEndpoint,
        ...data
    } = row;
    return { ...data } as CredentialConfiguration;
}
