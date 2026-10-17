/** An OpenID Federation trust anchor a resolution may end at. */
interface FederationTrustAnchor {
    entityId: string;
}

export interface FederationResolutionRequest {
    entityId: string;
    trustAnchors: FederationTrustAnchor[];
    /**
     * Metadata types the caller needs. The resolution fails when the
     * resolved metadata contains none of them.
     */
    metadataTypes?: string[];
}

/** A federation entity whose trust chain to a trust anchor was validated. */
export interface FederationResolution {
    entityId: string;
    trustAnchor: string;
    /**
     * The validated trust chain as compact JWTs: the entity's entity
     * configuration, the subordinate statements and the trust anchor's entity
     * configuration. Only the entity configuration when the entity is a trust
     * anchor.
     */
    trustChain: string[];
    /**
     * Metadata of the entity after the metadata policies of the chain were
     * applied, by metadata type. Protocol keys, such as the credential signing
     * keys, are in the `jwks` of these types, not in the federation keys of
     * the entity configuration.
     */
    metadata: Record<string, Record<string, unknown>>;
    /** ISO 8601 time after which the chain must not be used. */
    expiresAt: string;
}

/**
 * Why a resolution failed. `untrusted`: no valid trust chain, for example a
 * bad signature, an expired statement or an unknown trust anchor; the result
 * must never be replaced by an older one. `unavailable`: a request failed, so
 * trust could not be decided.
 */
export type FederationResolutionFailure = "untrusted" | "unavailable";

export class FederationResolutionError extends Error {
    constructor(
        message: string,
        readonly failure: FederationResolutionFailure,
    ) {
        super(message);
        this.name = "FederationResolutionError";
    }
}

/**
 * Resolves and validates the trust chain of a federation entity, locally or
 * through an external trust engine. Rejects with a
 * {@link FederationResolutionError}.
 */
export interface FederationResolver {
    resolveEntity(
        request: FederationResolutionRequest,
    ): Promise<FederationResolution>;
}

export const FEDERATION_RESOLVER = Symbol("FEDERATION_RESOLVER");
