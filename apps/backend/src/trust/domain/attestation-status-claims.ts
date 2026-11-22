import type { StatusListReference } from "@owf/token-status-list";
import {
    isJsonObject,
    MalformedStatusReferenceError,
    parseStatusListReference,
} from "./status-list-reference.js";

/** A wallet attestation (WIA) or a key attestation (KA). */
export type AttestationKind = "wallet" | "key";

/**
 * The claim that carries the status of an attestation in TS3 (EUDI Wallet
 * Unit Attestations) 1.5 and later: `client_status` in a wallet instance
 * attestation (section 2.3.1), `key_storage_status` in a key attestation
 * (section 2.3.2). Each is an object with `status`, a status reference as
 * the top-level `status` claim of OpenID4VCI 1.0 Appendix D.1 and E, and
 * `exp`, the end of the period the wallet provider maintains that status.
 */
const TS3_STATUS_CLAIM = {
    wallet: "client_status",
    key: "key_storage_status",
} as const satisfies Record<AttestationKind, string>;

/**
 * The `status_list` reference of an attestation's TS3 status claim
 * (`client_status.status` or `key_storage_status.status`).
 *
 * @returns The reference, or undefined when the claim is absent, has no
 * `status`, or its `status` names another mechanism
 * @throws MalformedStatusReferenceError if the claim is not a JSON object or
 * its `status` is malformed
 */
function parseTs3StatusReference(
    payload: Record<string, unknown>,
    kind: AttestationKind,
): StatusListReference | undefined {
    const claim = TS3_STATUS_CLAIM[kind];
    const value = payload[claim];
    if (value === undefined) {
        return undefined;
    }
    if (!isJsonObject(value)) {
        throw new MalformedStatusReferenceError(
            `The ${claim} claim is not a JSON object`,
        );
    }
    try {
        return parseStatusListReference(value.status);
    } catch (error) {
        if (!(error instanceof MalformedStatusReferenceError)) throw error;
        throw new MalformedStatusReferenceError(
            `${claim}.status: ${error.message}`,
        );
    }
}

/**
 * The status list entries an attestation names, to be checked at issuance.
 *
 * An attestation in the TS3 1.5 format names its entry in `client_status`
 * (wallet attestation) or `key_storage_status` (key attestation); one in the
 * format of OpenID4VCI 1.0 Appendix D.1 and E, and TS3 1.4.1, in the
 * top-level `status` claim. When an attestation has both, both entries are
 * checked: the top-level claim is the status of the attestation token itself
 * (OpenID4VCI), the TS3 claim that of the wallet instance or of its key
 * storage, and either being revoked means the attestation must not be
 * accepted. The TS3 entry comes first: it is the one that stays meaningful
 * after the short-lived token has expired, so it is the one revocation
 * chaining follows. Two claims that name the same entry give it once.
 *
 * @param payload The attestation's JWT payload
 * @param options.skipMalformed Leave out a malformed claim instead of
 * throwing, for a status check that is disabled
 * @throws MalformedStatusReferenceError if a claim is malformed and
 * `skipMalformed` is not set
 */
export function attestationStatusReferences(
    payload: Record<string, unknown>,
    kind: AttestationKind,
    options: { skipMalformed?: boolean } = {},
): StatusListReference[] {
    const read = (parse: () => StatusListReference | undefined) => {
        try {
            return parse();
        } catch (error) {
            if (
                options.skipMalformed &&
                error instanceof MalformedStatusReferenceError
            ) {
                return undefined;
            }
            throw error;
        }
    };
    const ts3 = read(() => parseTs3StatusReference(payload, kind));
    const topLevel = read(() => parseStatusListReference(payload.status));
    const references: StatusListReference[] = [];
    for (const reference of [ts3, topLevel]) {
        if (
            reference &&
            !references.some(
                (known) =>
                    known.uri === reference.uri && known.idx === reference.idx,
            )
        ) {
            references.push(reference);
        }
    }
    return references;
}
