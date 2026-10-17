import type { JWK } from "jose";

/** The metadata type that lists the signing keys of a credential issuer. */
export const CREDENTIAL_ISSUER_METADATA_TYPE = "openid_credential_issuer";

const PRIVATE_KEY_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/**
 * The public key `kid` in the `jwks` of the resolved `metadataType` metadata
 * of a federation entity, for example the credential signing key in
 * `openid_credential_issuer`. These are protocol keys; the federation keys of
 * the entity configuration only sign entity statements and are never used.
 *
 * Returns `undefined` when the metadata lists no such key. Private key
 * members are dropped.
 */
export function findFederationProtocolKey(
    metadata: Record<string, Record<string, unknown>>,
    metadataType: string,
    kid: string,
): JWK | undefined {
    const jwks = metadata[metadataType]?.jwks;
    if (!jwks || typeof jwks !== "object") return undefined;
    const keys = (jwks as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) return undefined;

    const key = keys.find(
        (candidate): candidate is JWK =>
            typeof candidate === "object" &&
            candidate !== null &&
            (candidate as JWK).kid === kid,
    );
    if (!key) return undefined;

    const publicKey: Record<string, unknown> = { ...key };
    for (const member of PRIVATE_KEY_MEMBERS) delete publicKey[member];
    return publicKey as JWK;
}
