import type { SessionData } from "../../../../session/domain/session-data.js";
import type { AuthorizationIdentity } from "./authorization-identity.js";

export interface CredentialClaimsRequest {
    credentialConfigurationId: string;
    session: SessionData;
    identity?: AuthorizationIdentity;
    credentials?: unknown[];
    requireProvider?: boolean;
}

export interface CredentialClaimsResult {
    claims?: Record<string, unknown>;
    deferred: boolean;
    interval?: number;
}

export type CredentialClaimsResolutionErrorCode =
    | "credential_configuration_not_found"
    | "attribute_provider_not_found"
    | "provider_required";

export class CredentialClaimsResolutionError extends Error {
    constructor(
        readonly code: CredentialClaimsResolutionErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "CredentialClaimsResolutionError";
    }
}

export interface CredentialClaimsProvider {
    resolveClaims(
        request: CredentialClaimsRequest,
    ): Promise<CredentialClaimsResult | undefined>;
}

export const CREDENTIAL_CLAIMS_PROVIDER = Symbol("CREDENTIAL_CLAIMS_PROVIDER");
