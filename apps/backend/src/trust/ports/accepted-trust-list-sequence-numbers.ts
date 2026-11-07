/**
 * The highest `LoTESequenceNumber` accepted per tenant and trust list URL.
 * Shared by all instances of the backend and kept across restarts, so a list
 * older than one any instance accepted is discarded everywhere.
 */
export interface AcceptedTrustListSequenceNumbers {
    /** The highest number accepted from the list, if any. */
    highest(tenantId: string, url: string): Promise<number | undefined>;
    /**
     * Raise the number remembered for the list to `sequenceNumber`. A higher
     * number recorded meanwhile, for example by another instance, is kept.
     */
    record(
        tenantId: string,
        url: string,
        sequenceNumber: number,
    ): Promise<void>;
    /** Forget every number remembered for the tenant's lists. */
    forgetTenant(tenantId: string): Promise<void>;
}

export const ACCEPTED_TRUST_LIST_SEQUENCE_NUMBERS = Symbol(
    "ACCEPTED_TRUST_LIST_SEQUENCE_NUMBERS",
);
