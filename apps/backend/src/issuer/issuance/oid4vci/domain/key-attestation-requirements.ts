import type { Jwk } from "@openid4vc/oauth2";
import { InvalidCredentialProof } from "./credential-proof-errors.js";

/**
 * Key attestation requirements of a credential configuration, published as
 * `proof_types_supported.*.key_attestations_required` (OpenID4VCI 1.0,
 * Section 12.2.4). An empty object requires a key attestation without
 * further constraints; a non-empty `key_storage` / `user_authentication`
 * lists the values the issuer accepts.
 */
export interface KeyAttestationRequirements {
    key_storage?: string[];
    user_authentication?: string[];
}

/** Claims of a verified key attestation (OpenID4VCI 1.0, Appendix D.1). */
export interface VerifiedKeyAttestation {
    attestedKeys: Jwk[];
    keyStorage?: string[];
    userAuthentication?: string[];
}

/** Result of verifying one key proof of a credential request. */
export interface VerifiedCredentialProof {
    /** Keys proven by the proof; credentials are bound to these keys. */
    holderKeys: Jwk[];
    /**
     * Key attestation conveyed with the proof (the `key_attestation` header
     * of a `jwt` proof or an `attestation` proof). Only set once its
     * signature and its provider's trust have been verified.
     */
    keyAttestation?: VerifiedKeyAttestation;
}

/**
 * RFC 7638 members that identify a public key, so keys compare equal
 * regardless of optional members such as `kid`, `alg` or `use`.
 */
const KEY_MEMBERS: Record<string, string[]> = {
    EC: ["crv", "x", "y"],
    OKP: ["crv", "x"],
    RSA: ["e", "n"],
};

function isSameKey(a: Jwk, b: Jwk): boolean {
    const members = KEY_MEMBERS[a.kty];
    if (!members || a.kty !== b.kty) return false;
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    return members.every(
        (member) =>
            typeof left[member] === "string" && left[member] === right[member],
    );
}

function assertAcceptedValue(
    claim: "key_storage" | "user_authentication",
    accepted: string[] | undefined,
    attested: string[] | undefined,
): void {
    if (!accepted || accepted.length === 0) return;
    if (!attested?.some((value) => accepted.includes(value))) {
        throw new InvalidCredentialProof(
            `The key attestation does not state an accepted ${claim} value (accepted: ${accepted.join(", ")})`,
        );
    }
}

/**
 * Enforce the key attestation requirements of a credential configuration
 * on a verified proof. Without requirements every proof is accepted.
 *
 * @throws InvalidCredentialProof when the proof carries no key attestation,
 * proves a key that is not attested, or the attestation does not state an
 * accepted `key_storage` or `user_authentication` value.
 */
export function assertKeyAttestationRequirements(
    requirements: KeyAttestationRequirements | undefined,
    proof: VerifiedCredentialProof,
): void {
    if (!requirements) return;

    const attestation = proof.keyAttestation;
    if (!attestation) {
        throw new InvalidCredentialProof(
            "The credential configuration requires a key attestation: use the attestation proof type or add a key_attestation header to the jwt proof",
        );
    }
    if (
        proof.holderKeys.length === 0 ||
        !proof.holderKeys.every((key) =>
            attestation.attestedKeys.some((attested) =>
                isSameKey(key, attested),
            ),
        )
    ) {
        throw new InvalidCredentialProof(
            "The proof contains a key that is not listed in attested_keys of the key attestation",
        );
    }
    assertAcceptedValue(
        "key_storage",
        requirements.key_storage,
        attestation.keyStorage,
    );
    assertAcceptedValue(
        "user_authentication",
        requirements.user_authentication,
        attestation.userAuthentication,
    );
}
