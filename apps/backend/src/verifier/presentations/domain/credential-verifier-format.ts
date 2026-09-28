import type { VerificationProvenance } from "../../../session/domain/session-outcome.js";
import type { VerifierOptions } from "../../../trust/types.js";
import type { VerificationFailureType } from "../credential/verification-failure.js";
import type { DcqlClaimQuery } from "./dcql-claim-policy.js";

/** Values of the signed OID4VP request object that bind the wallet response. */
export interface SignedRequestValues {
    nonce?: string;
    client_id?: string;
    response_uri?: string;
    response_mode?: string;
    expected_origins?: string[];
    client_metadata?: {
        jwks?: { keys?: Array<Record<string, any>> };
    };
}

/**
 * Binding of an OID4VP response (classic or over the DC API) to its request.
 * Each format derives its own holder-binding inputs from it: the mdoc session
 * transcript, or the SD-JWT VC key-binding nonce and audience.
 */
export interface Oid4vpPresentationBinding {
    protocol: "openid4vp";
    sessionId: string;
    useDcApi: boolean;
    /** Nonce stored on the session (`vp_nonce`). */
    sessionNonce?: string;
    sessionClientId?: string;
    sessionResponseUri?: string;
    /** Values of the signed request object, when one was issued. */
    request?: SignedRequestValues;
}

/**
 * Binding of an ISO 18013-7 Annex C (org-iso-mdoc) response. The caller
 * builds the DCAPIHandover session transcript because it also derives the
 * HPKE info from it.
 */
interface Iso18013PresentationBinding {
    protocol: "iso-18013-7";
    /** Pre-built `SessionTranscript` of the mdoc library. */
    sessionTranscript: unknown;
}

export type PresentationBinding =
    | Oid4vpPresentationBinding
    | Iso18013PresentationBinding;

export interface CredentialVerificationContext {
    /** DCQL credential query id, used in messages and logs. */
    credentialId: string;
    binding: PresentationBinding;
    /** Trust, revocation, clock-skew and transaction-data options. */
    options: VerifierOptions;
    /** Claims requested by the DCQL credential query. */
    claims?: DcqlClaimQuery[];
    /**
     * The `claim_sets` options of the DCQL credential query. When present the
     * credential must satisfy one of them instead of all `claims`.
     */
    claimSets?: DcqlClaimQuery[][];
}

/** Why a credential failed signature, holder-binding or trust checks. */
export interface CredentialVerificationFailure {
    type?: VerificationFailureType;
    /** Verbose reason for logs and audit only. */
    reason?: string;
    /** Message reported to the caller. */
    message: string;
}

export type CredentialVerificationResult =
    | {
          verified: true;
          /** Disclosed claims handed to the relying party. */
          claims: Record<string, unknown>;
          docType?: string;
          provenance?: VerificationProvenance;
          /** Requested claims (dotted paths) that are not disclosed. Only checked without `claimSets`. */
          missingClaims: string[];
          /** Whether one of the `claimSets` options is disclosed. Set only with `claimSets`. */
          claimSetSatisfied?: boolean;
      }
    | {
          verified: false;
          failure: CredentialVerificationFailure;
          docType?: string;
      };

/**
 * Credential format verifier (SD-JWT VC, mdoc). Formats report verification
 * failures either as a `verified: false` result or by throwing; the caller
 * decides how claim results are enforced.
 */
export interface CredentialVerifierFormat {
    readonly format: string;
    verify(
        credential: string,
        context: CredentialVerificationContext,
    ): Promise<CredentialVerificationResult>;
}

export class UnsupportedCredentialVerifierFormat extends Error {
    constructor(readonly format: string) {
        super(`Unsupported credential verifier format '${format}'`);
        this.name = "UnsupportedCredentialVerifierFormat";
    }
}
