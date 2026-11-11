import { zCompactJwe } from "@openid4vc/oauth2";
import { decodeProtectedHeader } from "jose";

/** What the issuer advertises in `credential_request_encryption`. */
export interface CredentialRequestEncryptionSupport {
    readonly jwks: {
        readonly keys: readonly {
            readonly kid?: string;
            readonly alg?: string;
        }[];
    };
    readonly enc_values_supported: readonly string[];
}

/** An encrypted credential request whose JWE header the issuer refuses. */
export class InvalidCredentialRequestEncryption extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidCredentialRequestEncryption";
    }
}

/**
 * Check the protected header of an encrypted credential request (OpenID4VCI
 * 1.0 Section 10) before it is decrypted: `kid` names an advertised key,
 * `alg` is that key's alg, `enc` is advertised, and there is no `zip` or
 * `crit`. The rules are those of `verifyCredentialRequestEncryption` in
 * `@openid4vc/openid4vci` (not exported), which checks the same header only
 * after the issuer has read the plaintext. The messages are the library's,
 * except that a member of the wrong type gets the message of the rule it
 * breaks rather than "Unable to decode credential request JWE header".
 * Checking first keeps every answer to a refused header independent of the
 * plaintext, and nothing is inflated before a `zip` is refused.
 */
export function checkCredentialRequestJweHeader(
    jwe: string,
    supported: CredentialRequestEncryptionSupport | undefined,
): asserts supported {
    if (!supported) {
        throw new InvalidCredentialRequestEncryption(
            "Credential request encryption is not supported",
        );
    }
    if (!zCompactJwe.safeParse(jwe).success) {
        throw new InvalidCredentialRequestEncryption(
            "Credential request is not a compact JWE",
        );
    }
    let header: Record<string, unknown>;
    try {
        header = decodeProtectedHeader(jwe);
    } catch {
        throw new InvalidCredentialRequestEncryption(
            "Unable to decode credential request JWE header",
        );
    }
    const { kid, alg, enc } = header;
    const key =
        typeof kid === "string" && kid !== ""
            ? supported.jwks.keys.find((candidate) => candidate.kid === kid)
            : undefined;
    if (!key) {
        throw new InvalidCredentialRequestEncryption(
            "Credential request is not encrypted to a key advertised by the issuer",
        );
    }
    if (typeof alg !== "string" || alg !== key.alg) {
        throw new InvalidCredentialRequestEncryption(
            `Credential request JWE 'alg' must match the advertised key algorithm '${key.alg}'`,
        );
    }
    if (
        typeof enc !== "string" ||
        !supported.enc_values_supported.includes(enc)
    ) {
        throw new InvalidCredentialRequestEncryption(
            `Credential request JWE 'enc' must be one of ${supported.enc_values_supported.map((value) => `'${value}'`).join(", ")}`,
        );
    }
    if (header.zip !== undefined) {
        throw new InvalidCredentialRequestEncryption(
            "Compressed credential requests are not supported",
        );
    }
    if (header.crit !== undefined) {
        throw new InvalidCredentialRequestEncryption(
            "Credential request JWE must not contain a critical ('crit') header parameter",
        );
    }
}
