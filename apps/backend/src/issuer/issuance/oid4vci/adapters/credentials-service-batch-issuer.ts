import type { Jwk } from "@openid4vc/oauth2";
import type { SessionData } from "../../../../session/domain/session-data.js";
import { CredentialsService } from "../../../configuration/credentials/credentials.service.js";
import type { CredentialBatchIssuer } from "../ports/credential-batch-issuer.js";

export class CredentialsServiceBatchIssuer implements CredentialBatchIssuer {
    constructor(private readonly credentials: CredentialsService) {}

    issue(
        credentialConfigurationId: string,
        holderKey: Jwk,
        session: SessionData,
        claims?: Record<string, unknown>,
        issuanceSetId?: string,
    ): Promise<string> {
        return this.credentials.getCredential(
            credentialConfigurationId,
            holderKey,
            session,
            claims,
            issuanceSetId,
        );
    }
}
