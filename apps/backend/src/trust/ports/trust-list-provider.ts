import type { TrustedEntity, TrustListRef } from "../types.js";
export interface VerifiedTrustList {
    /** As signed; null marks a closed list (ETSI TS 119 602 §6.3.15). */
    nextUpdate?: string | null;
    /**
     * `LoTESequenceNumber` (ETSI TS 119 602 §6.3.2) or `TSLSequenceNumber`
     * (ETSI TS 119 612 clause 5.3.2) as signed, unchecked.
     */
    sequenceNumber?: unknown;
    entities: TrustedEntity[];
    /**
     * Set only for an ETSI TS 119 612 list of trusted lists: the lists it
     * points to, to be loaded and checked one by one, each with the
     * certificates this list publishes for it.
     */
    pointers?: TrustListRef[];
}
/**
 * Fetches, verifies and parses one trust list, a LoTE or an ETSI TS 119 612
 * Trusted List by its `format`, before exposing its trusted entities.
 */
export interface TrustListProvider {
    loadVerified(reference: TrustListRef): Promise<VerifiedTrustList>;
}
export const TRUST_LIST_PROVIDER = Symbol("TRUST_LIST_PROVIDER");
