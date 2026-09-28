import { Inject, Injectable } from "@nestjs/common";
import type { AuthorizationServerMetadata } from "@openid4vc/oauth2";
import { v4 } from "uuid";
import {
    OID4VCI_SETTINGS,
    type Oid4vciSettings,
} from "../../oid4vci-settings.js";
import {
    CREDENTIAL_NONCE_REPOSITORY,
    type CredentialNonceRepository,
} from "../../ports/credential-nonce.repository.js";
import {
    BuildBuiltInAuthorizationServerMetadata,
    builtInAuthorizationServerIssuer,
} from "../application/build-built-in-authorization-server-metadata.js";

/** Client attestation challenges are valid for ten minutes. */
const ATTESTATION_CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;

/**
 * Facade of the tenant's built-in authorization server for the issuer
 * metadata, well-known and credential endpoints. The authorization, PAR and
 * token endpoints are use cases in `../application`.
 */
@Injectable()
export class AuthorizeService {
    constructor(
        @Inject(OID4VCI_SETTINGS) private readonly settings: Oid4vciSettings,
        private readonly buildMetadata: BuildBuiltInAuthorizationServerMetadata,
        @Inject(CREDENTIAL_NONCE_REPOSITORY)
        private readonly nonceRepository: CredentialNonceRepository,
    ) {}

    getAuthzIssuer(tenantId: string): string {
        return builtInAuthorizationServerIssuer(this.settings, tenantId);
    }

    authzMetadata(tenantId: string): Promise<AuthorizationServerMetadata> {
        return this.buildMetadata.execute(tenantId);
    }

    /**
     * Client Attestation Challenge Endpoint.
     * Generates and stores a nonce for use in the Client Attestation PoP JWT.
     * @see OAuth2-ATCA07-8
     */
    async challengeRequest(
        tenantId: string,
    ): Promise<{ attestation_challenge: string }> {
        const nonce = v4();
        await this.nonceRepository.save({
            nonce,
            tenantId,
            expiresAt: new Date(Date.now() + ATTESTATION_CHALLENGE_LIFETIME_MS),
        });
        return { attestation_challenge: nonce };
    }
}
