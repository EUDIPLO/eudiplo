import type { IssuerMetadataResult } from "@openid4vc/openid4vci";
import {
    CompactEncrypt,
    type CompactJWEHeaderParameters,
    exportJWK,
    generateKeyPair,
    importJWK,
    type JWK,
} from "jose";

/**
 * Helpers for encrypted credential and deferred credential requests
 * (OpenID4VCI 1.0 Section 10). Kept out of `../utils.ts`, which imports
 * AppModule.
 */

/** The first key the issuer advertises in `credential_request_encryption`. */
export function advertisedKey(issuerMetadata: IssuerMetadataResult) {
    const key =
        issuerMetadata.credentialIssuer.credential_request_encryption?.jwks
            .keys[0];
    if (!key) throw new Error("no credential request encryption key");
    return key;
}

/**
 * Encrypt a request payload to the advertised key with ECDH-ES and A128GCM.
 * A string payload is encrypted as it is, an object as JSON.
 * `header` overrides the protected header; extension parameters it lists in
 * `crit` are accepted. `recipient` encrypts to another public key while the
 * header still names the advertised kid.
 */
export async function encryptRequest(
    issuerMetadata: IssuerMetadataResult,
    payload: Record<string, unknown> | string,
    header: Partial<CompactJWEHeaderParameters> = {},
    recipient?: JWK,
): Promise<string> {
    const key = advertisedKey(issuerMetadata);
    const plaintext =
        typeof payload === "string" ? payload : JSON.stringify(payload);
    return new CompactEncrypt(new TextEncoder().encode(plaintext))
        .setProtectedHeader({
            alg: "ECDH-ES",
            enc: "A128GCM",
            kid: key.kid,
            ...header,
        })
        .encrypt(
            await importJWK(recipient ?? (key as JWK), "ECDH-ES"),
            header.crit && {
                crit: Object.fromEntries(
                    header.crit.map((name) => [name, true]),
                ),
            },
        );
}

/**
 * The JWE with `crv` removed from the `epk` in its protected header, a header
 * that passes the header checks but whose `epk` cannot be imported.
 */
export function withoutEpkCurve(jwe: string): string {
    const [header, ...rest] = jwe.split(".");
    const decoded = JSON.parse(Buffer.from(header, "base64url").toString());
    delete decoded.epk.crv;
    return [
        Buffer.from(JSON.stringify(decoded)).toString("base64url"),
        ...rest,
    ].join(".");
}

/**
 * `credential_response_encryption` parameters for a fresh wallet key, and the
 * private key to decrypt the response with.
 */
export async function responseEncryption(kid?: string) {
    const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", {
        extractable: true,
    });
    return {
        privateKey,
        parameters: {
            jwk: {
                ...(await exportJWK(publicKey)),
                alg: "ECDH-ES",
                ...(kid && { kid }),
            },
            enc: "A128GCM",
        },
    };
}
