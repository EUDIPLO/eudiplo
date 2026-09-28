import { VerificationProvenance } from "../../../session/domain/session-outcome.js";
import { MatchedTrustedEntity } from "../../../trust/x509-validation.service.js";

/**
 * Map a matched trusted entity to the safe, serialisable provenance surfaced on
 * a successful verification outcome. Returns `undefined` when no entity matched
 * (e.g. trust validation was skipped because no trust list is configured).
 */
export function toProvenance(
    matched: MatchedTrustedEntity | null,
): VerificationProvenance | undefined {
    if (!matched) {
        return undefined;
    }
    return {
        matchedIssuer: matched.entity.entityId ?? matched.issuanceCert.subject,
        issuanceThumbprint: matched.issuanceThumbprint,
        matchMode: matched.matchMode,
        revocationThumbprint: matched.revocationThumbprint,
    };
}
