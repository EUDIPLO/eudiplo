import type { WebhookConfiguration } from "../../../../webhook/domain/webhook-configuration.js";
import type {
    CredentialClaimsRequest,
    CredentialClaimsResult,
} from "../domain/credential-claims.js";

export const REMOTE_CREDENTIAL_CLAIMS = Symbol("REMOTE_CREDENTIAL_CLAIMS");

export interface RemoteCredentialClaimsRequest {
    webhook: WebhookConfiguration;
    session: string;
    credentialConfigurationId: string;
    identity?: CredentialClaimsRequest["identity"];
    credentials?: unknown[];
}

/** Fetch credential claims from the selected remote source. */
export interface RemoteCredentialClaims {
    fetchClaims(
        request: RemoteCredentialClaimsRequest,
    ): Promise<CredentialClaimsResult>;
}
