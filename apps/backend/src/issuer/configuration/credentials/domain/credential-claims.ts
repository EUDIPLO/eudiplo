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
    | "provider_required"
    /** A dynamic source answered without claims for the configuration. */
    | "claims_missing";

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
    /**
     * Resolves the claims of the one source that applies. Resolves undefined
     * only when no dynamic source applies; the static defaults are issued then.
     * @throws CredentialClaimsResolutionError
     */
    resolveClaims(
        request: CredentialClaimsRequest,
    ): Promise<CredentialClaimsResult | undefined>;
}

export const CREDENTIAL_CLAIMS_PROVIDER = Symbol("CREDENTIAL_CLAIMS_PROVIDER");
