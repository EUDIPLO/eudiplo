import { isTrustListCurrent } from "../../../trust/domain/trust-list-freshness.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Time from issuing a managed trust list to its `NextUpdate`. */
export const TRUST_LIST_VALIDITY_MS = 30 * DAY_MS;

/** A managed list is re-issued in the last third of its validity. */
export const TRUST_LIST_RENEWAL_WINDOW_MS = TRUST_LIST_VALIDITY_MS / 3;

/** How often the renewal job looks for lists that are due. */
export const TRUST_LIST_RENEWAL_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** `NextUpdate` of a managed list issued at `issuedAt`. */
export function trustListNextUpdate(issuedAt: Date): Date {
    return new Date(issuedAt.getTime() + TRUST_LIST_VALIDITY_MS);
}

/**
 * Whether a list with this `NextUpdate` must be re-issued: inside the renewal
 * window, already expired, or without a readable `NextUpdate`, read the way
 * verifiers read it, so a list is renewed before any verifier discards it.
 */
export function isTrustListRenewalDue(
    nextUpdate: string | undefined,
    now: Date,
): boolean {
    return !isTrustListCurrent(
        nextUpdate,
        new Date(now.getTime() + TRUST_LIST_RENEWAL_WINDOW_MS),
    );
}
