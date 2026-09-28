import type { TrustListRef } from "../../../trust/types.js";

/** A `trusted_authorities` entry of a presentation config is incomplete. */
export class InvalidTrustedAuthoritiesError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidTrustedAuthoritiesError";
    }
}

/** Resolves configured `etsi_tl` trusted authorities into trust-list references. */
export interface TrustListRefResolver {
    /** @throws InvalidTrustedAuthoritiesError for an incomplete reference. */
    resolveTrustListRefsForTenant(
        refs: TrustListRef[] | undefined,
        tenantId: string,
        tenantHost: string,
    ): Promise<TrustListRef[]>;
}
