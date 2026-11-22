import { zCompactJwt } from "@owf/jose";

/** Proof types whose key proofs are compact JWTs (OpenID4VCI 1.0 Appendix F). */
const COMPACT_JWT_PROOF_TYPES = ["jwt", "attestation"] as const;

/**
 * Find a key proof in a credential request body that is not a compact JWT
 * with three non-empty parts, for example an unsecured JWT (`alg` `none`
 * with an empty signature). `@openid4vc/openid4vci` refuses such a request
 * while parsing it, as a malformed request; this tells the caller that the
 * proof is what it refused, so the wallet can get `invalid_proof`
 * (OpenID4VCI 1.0 Section 8.3.1.2). Looks at `proofs` and at the single
 * `proof` of earlier drafts.
 * @returns The proof type of the first malformed proof, if any
 */
export function findMalformedKeyProof(body: unknown): string | undefined {
    if (typeof body !== "object" || body === null) return undefined;
    const { proofs, proof } = body as { proofs?: unknown; proof?: unknown };
    for (const type of COMPACT_JWT_PROOF_TYPES) {
        const values =
            typeof proofs === "object" && proofs !== null
                ? (proofs as Record<string, unknown>)[type]
                : undefined;
        if (
            Array.isArray(values) &&
            values.some((value) => !zCompactJwt.safeParse(value).success)
        ) {
            return type;
        }
        if (
            typeof proof === "object" &&
            proof !== null &&
            (proof as Record<string, unknown>).proof_type === type &&
            !zCompactJwt.safeParse((proof as Record<string, unknown>)[type])
                .success
        ) {
            return type;
        }
    }
    return undefined;
}
