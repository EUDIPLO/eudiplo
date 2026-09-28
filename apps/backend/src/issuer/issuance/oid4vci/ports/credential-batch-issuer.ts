import type { Jwk } from "@openid4vc/oauth2";
import type { SessionData } from "../../../../session/domain/session-data.js";

export const CREDENTIAL_BATCH_ISSUER = Symbol("CREDENTIAL_BATCH_ISSUER");

export interface CredentialBatchIssuer {
    issue(
        credentialConfigurationId: string,
        holderKey: Jwk,
        session: SessionData,
        claims?: Record<string, unknown>,
        issuanceSetId?: string,
    ): Promise<string>;
}
