/**
 * JOSE `typ` values of access tokens: RFC 9068 `at+jwt` and the plain `JWT`
 * most providers still put on theirs, each also with the `application/`
 * prefix. Compared without regard to case (RFC 7515, section 4.1.9).
 */
const ACCESS_TOKEN_TYPES = new Set([
    "jwt",
    "application/jwt",
    "at+jwt",
    "application/at+jwt",
]);

/**
 * Claims that only ID tokens carry (OpenID Connect Core, sections 3.1.3.6,
 * 3.3.2.11, and FAPI 1.0 Advanced, section 5.1): hashes of the access token,
 * the authorization code and the state that the ID token was issued with. An
 * access token cannot carry a hash of itself.
 */
const ID_TOKEN_CLAIMS = ["at_hash", "c_hash", "s_hash"] as const;

/**
 * Why a JWS header does not belong to an access token, or `undefined`. A
 * header without `typ` passes, as do `JWT` and `at+jwt`; other types, such as
 * `logout+jwt`, `dpop+jwt` or `id_token+jwt`, are other kinds of token.
 */
export function accessTokenTypeRefusal(header: {
    typ?: unknown;
}): string | undefined {
    const { typ } = header;
    if (typ === undefined) {
        return undefined;
    }
    if (typeof typ === "string" && ACCESS_TOKEN_TYPES.has(typ.toLowerCase())) {
        return undefined;
    }
    // The value is not repeated: the header is not verified yet.
    return "Not an access token: its header names another typ than at+jwt or JWT";
}

/**
 * Why a token payload is an ID token rather than an access token, or
 * `undefined`. ID tokens are signed with the keys of the access tokens, so
 * those whose audience is `OIDC_AUDIENCE`, and with Keycloak without it any
 * of the realm, would otherwise pass the signature, issuer and audience checks.
 */
export function idTokenClaimRefusal(payload: object): string | undefined {
    const claim = ID_TOKEN_CLAIMS.find((name) => Object.hasOwn(payload, name));
    return claim
        ? `Not an access token: the token carries ${claim}, which only ID tokens carry; send the access token`
        : undefined;
}

/**
 * Why a Keycloak token payload is not a bearer access token, or `undefined`:
 * its own `typ` claim is present and not `Bearer`. Keycloak's ID tokens carry
 * `ID`, its refresh tokens `Refresh` or `Offline`, its logout tokens `Logout`.
 * Access tokens bound to a DPoP key (`DPoP`) are refused too: the management
 * API takes them as bearer tokens and checks no proof. A token without the
 * claim passes; the other checks still apply to it.
 */
export function keycloakTokenTypeRefusal(payload: object): string | undefined {
    const typ = Object.hasOwn(payload, "typ")
        ? (payload as { typ: unknown }).typ
        : undefined;
    if (typ === undefined) {
        return undefined;
    }
    if (typeof typ === "string" && typ.toLowerCase() === "bearer") {
        return undefined;
    }
    return "Not an access token: its typ claim is not Bearer, as on Keycloak access tokens; send the access token";
}
