import { Curve } from "@owf/cose";

/**
 * A JWK ready for `CoseKey.fromJwk` (and its subclasses such as `DeviceKey`).
 *
 * `@owf/cose` (still in 0.6.0) maps only `"P-256"` to its COSE curve id; it lists
 * P-384 and P-521 as `"p-384"` and `"p-521"`, so those keys fail to decode.
 * A numeric curve id passes through unchanged, so the EC curves are given as
 * their COSE ids (RFC 9053 §7.1).
 */
export function coseReadyJwk<T extends object>(jwk: T): T {
    const crv = (jwk as { crv?: unknown }).crv;
    if (crv === "P-256" || crv === "P-384" || crv === "P-521") {
        return { ...jwk, crv: Curve[crv] };
    }
    return jwk;
}
