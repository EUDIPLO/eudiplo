import { Curve } from "@owf/cose";

/**
 * A JWK ready for `CoseKey.fromJwk` (and its subclasses such as `DeviceKey`).
 *
 * `@owf/cose` before 0.8 mapped only `"P-256"` to its COSE curve id, so P-384
 * and P-521 keys failed to decode. 0.8 maps all three; the helper still gives
 * the EC curves as their COSE ids (RFC 9053 §7.1), which pass through
 * unchanged, and can be dropped with its callers.
 */
export function coseReadyJwk<T extends object>(jwk: T): T {
    const crv = (jwk as { crv?: unknown }).crv;
    if (crv === "P-256" || crv === "P-384" || crv === "P-521") {
        return { ...jwk, crv: Curve[crv] };
    }
    return jwk;
}
