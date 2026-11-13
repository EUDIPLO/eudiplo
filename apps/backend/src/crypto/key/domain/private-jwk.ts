import { createPrivateKey } from "node:crypto";

/**
 * Why a JWK cannot be imported as a private key, or undefined when it can.
 * Besides a missing `d`, this catches a `d` that does not belong to the public
 * key in `x` and `y`: the key would import and show the certificate's public
 * key, but every signature made with it would fail.
 */
export function privateJwkProblem(jwk: unknown): string | undefined {
    if (!jwk || typeof jwk !== "object" || !("d" in jwk) || !jwk.d) {
        return "The key has no private key (d).";
    }
    try {
        createPrivateKey({ key: jwk as JsonWebKey, format: "jwk" });
        return undefined;
    } catch {
        return "The private key (d) is not valid or does not belong to the public key (x, y).";
    }
}
