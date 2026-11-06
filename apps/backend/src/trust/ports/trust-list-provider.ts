import type { TrustedEntity, TrustListRef } from "../types.js";
export interface VerifiedTrustList {
    /** As signed; null marks a closed list (ETSI TS 119 602 §6.3.15). */
    nextUpdate?: string | null;
    entities: TrustedEntity[];
}
/** Fetches, verifies and parses one LoTE before exposing its trusted entities. */
export interface TrustListProvider {
    loadVerified(reference: TrustListRef): Promise<VerifiedTrustList>;
}
export const TRUST_LIST_PROVIDER = Symbol("TRUST_LIST_PROVIDER");
