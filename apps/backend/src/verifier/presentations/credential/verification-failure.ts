/**
 * Shared verification-failure taxonomy.
 *
 * The failure classification originates in {@link CredentialChainValidationService.validateChain}
 * (`ChainValidationResult.error`) and is therefore common to every credential
 * format — mDOC (ISO 18013-5) and SD-JWT-VC alike — and to every trust-list
 * format (LoTE JSON and ETSI TS 119 612 XML). The list/credential format only
 * matters at the load/parse boundary; the trust decision runs on the normalized
 * trust store. Keep this module free of format-specific imports.
 */

/**
 * Machine-readable classification of why a credential verification failed.
 * Surfaced as the `error` code so relying parties can branch on it without
 * parsing prose.
 */
export type VerificationFailureType =
    | "signature_invalid"
    | "no_trust_chain_to_root"
    | "trust_chain_not_trusted"
    | "trust_list_unavailable"
    | "certificate_expired"
    | "x5c_missing"
    | "verification_error";

/**
 * Map a {@link ChainValidationResult.error} code to a stable failure type.
 * Unknown/absent codes fall back to the generic `verification_error`.
 */
export function mapChainErrorToFailureType(
    errorCode?: string,
): VerificationFailureType {
    switch (errorCode) {
        case "x5c_required":
            return "x5c_missing";
        case "chain_build_failed":
            return "no_trust_chain_to_root";
        case "no_trusted_entity_match":
            return "trust_chain_not_trusted";
        case "trust_list_unavailable":
            return "trust_list_unavailable";
        case "certificate_expired":
            return "certificate_expired";
        default:
            return "verification_error";
    }
}

/**
 * Short, user-facing message for a failure type. Intended for the DC API /
 * `direct_post` response and `session.errorReason` — safe to show in a UI. The
 * verbose reason (certificate subjects, thumbprints, configured lists) stays in
 * logs/audit only.
 */
export function shortVerificationMessage(
    failureType?: VerificationFailureType,
): string {
    switch (failureType) {
        case "signature_invalid":
            return "The credential signature is invalid.";
        case "no_trust_chain_to_root":
            return "The credential issuer does not chain to a trusted root.";
        case "trust_chain_not_trusted":
            return "The credential issuer is not in the trusted list.";
        case "trust_list_unavailable":
            return "The trusted list could not be loaded, so the credential could not be validated.";
        case "certificate_expired":
            return "The credential issuer certificate is expired or not yet valid.";
        case "x5c_missing":
            return "The credential is missing its issuer certificate chain.";
        default:
            return "The credential could not be verified.";
    }
}

/** Caller-facing view of a verification failure, shared by all presentation flows. */
interface VerificationFailureDetails {
    /** Stable code for `failureCode` and the outcome's `error` fields. */
    code: VerificationFailureType;
    /** Short message, safe to show in a UI. */
    message: string;
    /** Verbose reason for logs/audit only. */
    verbose?: string;
}

/**
 * Structured code and short message of a verification failure. An unknown
 * failure type falls back to the generic `verification_error`.
 */
export function verificationFailureDetails(
    failureType?: VerificationFailureType,
    verboseReason?: string,
): VerificationFailureDetails {
    return {
        code: failureType ?? "verification_error",
        message: shortVerificationMessage(failureType),
        verbose: verboseReason,
    };
}
