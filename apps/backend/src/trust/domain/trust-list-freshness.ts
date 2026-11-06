/**
 * A trust list (LoTE, ETSI TS 119 602 §6.3.15) is current only until its
 * `NextUpdate`: "LoTE with a Next update occurring in the past shall be
 * discarded as expired". By then its operator has issued a newer list; a list
 * served after that, even with a valid signature, may be an older version
 * replayed to undo a removal or a withdrawn service. A closed list has a null
 * `NextUpdate` and all its services expired, so it is discarded as well.
 *
 * `NextUpdate` alone bounds a replay, it does not stop one: an older list
 * whose `NextUpdate` is still ahead would be accepted. Its lower
 * `LoTESequenceNumber` shows that it is older than a list already accepted
 * (see trust-list-sequence.ts), so such a list is discarded too.
 */

/** A list left out of a trust store because it is not current. */
export interface DiscardedTrustList {
    /** URL of the list, or the ID of a managed list read from storage. */
    list: string;
    /** The list's `NextUpdate` as signed, if any. */
    nextUpdate: string | null | undefined;
    /**
     * Set when the list was discarded for its `LoTESequenceNumber`, although
     * its `NextUpdate` is ahead; absent when its `NextUpdate` decided.
     */
    sequence?: {
        /** The list's `LoTESequenceNumber` as signed. */
        number: unknown;
        /**
         * The highest number accepted before from the list, which the list's
         * number is lower than; absent when the list has no usable number.
         */
        highestAccepted?: number;
        /**
         * True when `highestAccepted` is the number a managed list of this
         * instance has in storage rather than one remembered for the tenant.
         */
        stored?: boolean;
    };
}

/**
 * Whether a list with this `NextUpdate` may still be used at `now`: a
 * readable date after `now`. Missing, null (closed) or unreadable values are
 * not current.
 */
export function isTrustListCurrent(
    nextUpdate: string | null | undefined,
    now: Date,
): nextUpdate is string {
    const expiresAt = nextUpdate ? Date.parse(nextUpdate) : Number.NaN;
    return !Number.isNaN(expiresAt) && expiresAt > now.getTime();
}

/** Why one list was discarded, as operators read it. */
function discardReason({ nextUpdate, sequence }: DiscardedTrustList): string {
    if (!sequence) {
        return `NextUpdate ${JSON.stringify(nextUpdate ?? null)}`;
    }
    const number = JSON.stringify(sequence.number ?? null);
    if (sequence.highestAccepted === undefined) {
        return `LoTESequenceNumber ${number} is not a whole number from 1`;
    }
    return sequence.stored
        ? `LoTESequenceNumber ${number} is lower than ${sequence.highestAccepted} stored for this managed list`
        : `LoTESequenceNumber ${number} is lower than ${sequence.highestAccepted} accepted before`;
}

/** Discarded lists as operators read them in logs and error details. */
export function describeDiscardedTrustLists(
    discarded: DiscardedTrustList[],
): string {
    return discarded
        .map((entry) => `${entry.list} (${discardReason(entry)})`)
        .join(", ");
}

/**
 * Suffix for a "not trusted" message that may reach a wallet: says that
 * outdated lists were left out without naming them (see
 * {@link OutdatedTrustListsError} for why), so operators know to look in the
 * log. Empty when nothing was discarded.
 */
export function discardedTrustListsNote(
    discarded: DiscardedTrustList[],
): string {
    return discarded.length > 0
        ? ` (${discarded.length} outdated trust list(s) left out; the server log names them)`
        : "";
}

/**
 * Raised when every list of a trust store was discarded, so nothing is left
 * to decide trust with.
 *
 * The message leaves out the lists, their `NextUpdate` and their sequence
 * numbers: it can reach wallets as an OAuth `error_description`, the URL of a
 * managed list names an internal address, and the signed values may hold
 * characters that field must not carry. Log {@link discarded} for operators.
 */
export class OutdatedTrustListsError extends Error {
    constructor(readonly discarded: DiscardedTrustList[]) {
        super(
            "No configured trust list is current: each has no valid NextUpdate or one that has passed, no valid LoTESequenceNumber, or a lower one than a list accepted before",
        );
        this.name = "OutdatedTrustListsError";
    }
}
