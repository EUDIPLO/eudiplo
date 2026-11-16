import type {
    TrustListProvider,
    VerifiedTrustList,
} from "../ports/trust-list-provider.js";
import { isTrustedListRef, type TrustListRef } from "../types.js";

/**
 * Loads each reference with the provider for its `format`: ETSI TS 119 612
 * Trusted Lists with one, LoTEs (the default) with the other.
 */
export class TrustListProviderByFormat implements TrustListProvider {
    constructor(
        private readonly lotes: TrustListProvider,
        private readonly trustedLists: TrustListProvider,
    ) {}

    loadVerified(reference: TrustListRef): Promise<VerifiedTrustList> {
        return isTrustedListRef(reference)
            ? this.trustedLists.loadVerified(reference)
            : this.lotes.loadVerified(reference);
    }
}
