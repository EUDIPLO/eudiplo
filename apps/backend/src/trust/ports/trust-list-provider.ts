import type { TrustedEntity, TrustListRef } from "../types.js";
export interface VerifiedTrustList {
    nextUpdate?: string;
    entities: TrustedEntity[];
}
/** Fetches, verifies and parses one LoTE before exposing its trusted entities. */
export interface TrustListProvider {
    loadVerified(reference: TrustListRef): Promise<VerifiedTrustList>;
}
export const TRUST_LIST_PROVIDER = Symbol("TRUST_LIST_PROVIDER");
