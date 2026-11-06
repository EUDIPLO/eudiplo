/**
 * A trust list (LoTE) carries a `LoTESequenceNumber` (ETSI TS 119 602
 * §6.3.2): it starts at 1, grows with each list its operator issues and never
 * goes back to a lower value. A validly signed list numbered lower than one
 * already accepted from the same source is an older version, possibly
 * replayed to undo a removal or a withdrawn service before its `NextUpdate`
 * has passed (the `NextUpdate` check in trust-list-freshness.ts only bounds
 * such a replay), so it is discarded.
 */

/** Whether a signed `LoTESequenceNumber` is usable: a whole number from 1. */
export function isTrustListSequenceNumber(value: unknown): value is number {
    return (
        typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    );
}

/**
 * Whether a list numbered `sequenceNumber` is older than the newest list
 * accepted before from the same source, whose number is `highestAccepted`.
 * A list with the same number is the same list and still accepted.
 */
export function isSupersededTrustList(
    sequenceNumber: number,
    highestAccepted: number | undefined,
): boolean {
    return highestAccepted !== undefined && sequenceNumber < highestAccepted;
}
