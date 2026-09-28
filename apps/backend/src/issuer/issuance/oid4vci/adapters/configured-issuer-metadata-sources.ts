import type { EncryptionService } from "../../../../crypto/encryption/encryption.service.js";
import type { CredentialsService } from "../../../configuration/credentials/credentials.service.js";
import type { IssuerMetadataSources } from "../ports/issuer-metadata-sources.js";

export class ConfiguredIssuerMetadataSources implements IssuerMetadataSources {
    constructor(
        private readonly credentials: CredentialsService,
        private readonly encryption: EncryptionService,
    ) {}

    credentialConfigurationsSupported(tenantId: string) {
        return this.credentials.getCredentialConfigurationSupported(tenantId);
    }

    credentialRequestEncryptionKey(tenantId: string) {
        return this.encryption.getEncryptionPublicKey(tenantId);
    }
}
