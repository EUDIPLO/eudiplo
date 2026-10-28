import type { X509Certificate } from "node:crypto";
import type { JWK } from "jose";

/**
 * Whether two JWKs hold the same public key. Only the public key parameters
 * count, so a private JWK matches its public JWK and `kid` or `alg` do not
 * matter.
 */
export function arePublicJwksEquivalent(left: JWK, right: JWK): boolean {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;

    if (a.kty !== b.kty) {
        return false;
    }

    if (a.kty === "EC") {
        return a.crv === b.crv && a.x === b.x && a.y === b.y;
    }

    if (a.kty === "RSA") {
        return a.n === b.n && a.e === b.e;
    }

    if (a.kty === "OKP") {
        return a.crv === b.crv && a.x === b.x;
    }

    return false;
}

/** Whether the certificate is issued for the public key of the JWK. */
export function certificateHoldsKey(
    certificate: X509Certificate,
    jwk: JWK,
): boolean {
    return arePublicJwksEquivalent(
        certificate.publicKey.export({ format: "jwk" }) as JWK,
        jwk,
    );
}
