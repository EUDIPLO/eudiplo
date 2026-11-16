import { TooManyTrustListCertificatesError } from "../domain/trust-list-certificate-limit.js";
import type { DiscardedTrustList } from "../domain/trust-list-freshness.js";
import {
    TrustFetchStatusError,
    TrustListFetchError,
    TrustListVerificationError,
} from "../domain/trust-list-load-errors.js";
import type { TrustListFetchOutcome } from "../ports/trust-list-fetch-statuses.js";

/** The outcome of a list discarded for its `NextUpdate` or sequence number. */
export function discardOutcome(
    discarded: DiscardedTrustList,
): TrustListFetchOutcome {
    if (!discarded.sequence) return "outdated";
    return discarded.sequence.highestAccepted === undefined
        ? "invalidSequenceNumber"
        : "superseded";
}

/**
 * Why a list could not be loaded, for the tenant's operators: fixed texts,
 * the HTTP status, the verifier's message or the certificate count.
 * Network errors are not described: their messages can tell whether a host
 * name resolves or an address answers behind the outbound URL policy, which
 * the server log keeps for the instance operator.
 */
export function failureReason(error: unknown): {
    outcome: TrustListFetchOutcome;
    reason: string;
} {
    if (error instanceof TooManyTrustListCertificatesError) {
        return { outcome: "tooManyCertificates", reason: error.message };
    }
    if (error instanceof TrustListFetchError) {
        return {
            outcome: "failed",
            reason:
                error.cause instanceof TrustFetchStatusError
                    ? `The list URL answered with HTTP status ${error.cause.status}`
                    : "The list could not be fetched; the server log has the details",
        };
    }
    if (error instanceof TrustListVerificationError) {
        return {
            outcome: "failed",
            reason: `The signature could not be verified: ${error.detail}`,
        };
    }
    return {
        outcome: "failed",
        reason: "The list could not be read as a signed LoTE; the server log has the details",
    };
}
