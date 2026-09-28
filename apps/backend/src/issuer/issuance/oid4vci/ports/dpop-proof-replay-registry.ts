export const DPOP_PROOF_REPLAY_REGISTRY = Symbol("DPOP_PROOF_REPLAY_REGISTRY");

/**
 * Records DPoP proofs (RFC 9449 Section 11.1) that were already presented, so
 * a captured proof cannot be replayed while it is still fresh.
 */
export interface DpopProofReplayRegistry {
    /**
     * Atomically record the proof `jti` for the key with the given JWK
     * thumbprint until `expiresAt`.
     *
     * @returns `true` if the proof was not seen before (or its earlier entry
     * expired), `false` if it is a replay. Of concurrent registrations of the
     * same proof, exactly one returns `true`.
     */
    register(
        jwkThumbprint: string,
        jti: string,
        expiresAt: Date,
    ): Promise<boolean>;
}
