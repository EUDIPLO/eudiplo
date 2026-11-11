import type { EncryptionService } from "../../../../crypto/encryption/encryption.service.js";
import type { CredentialsService } from "../../../configuration/credentials/credentials.service.js";
import type {
    CredentialRequestEncryptionKey,
    IssuerMetadataSources,
} from "../ports/issuer-metadata-sources.js";

export class ConfiguredIssuerMetadataSources implements IssuerMetadataSources {
    constructor(
        private readonly credentials: CredentialsService,
        private readonly encryption: EncryptionService,
    ) {}

    credentialConfigurationsSupported(tenantId: string) {
        return this.credentials.getCredentialConfigurationSupported(tenantId);
    }

    async credentialRequestEncryptionKey(
        tenantId: string,
    ): Promise<CredentialRequestEncryptionKey> {
        const key = await this.encryption.getEncryptionPublicKey(tenantId);
        if (!key.kty || !key.kid) {
            throw new Error(
                `Encryption key of tenant ${tenantId} has no kty or kid`,
            );
        }
        // Requests are always decrypted with ECDH-ES, and wallets must use the
        // advertised alg. The stored alg is not used: a signing key chain
        // with usage type encrypt stores its signing alg (ES256).
        return { ...key, kty: key.kty, kid: key.kid, alg: "ECDH-ES" };
    }
}
