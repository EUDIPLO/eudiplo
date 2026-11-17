import { createHmac } from "node:crypto";

/**
 * Claims of the ID token that a presented claim must never replace: the
 * token's own (OpenID Connect Core 1.0 Section 2) and the technical claims
 * of an SD-JWT VC or mdoc that only describe the credential.
 */
const RESERVED_CLAIMS = new Set([
    "iss",
    "sub",
    "aud",
    "exp",
    "iat",
    "nbf",
    "jti",
    "auth_time",
    "nonce",
    "acr",
    "amr",
    "azp",
    "at_hash",
    "c_hash",
    "sid",
    "credentials",
    "vct",
    "cnf",
    "status",
    "_sd",
    "_sd_alg",
]);

/** Which presented claim identifies the user across sign-ins. */
export interface SubjectClaim {
    /** ID of the credential query (DCQL) whose claim is used. */
    credentialId: string;
    /** Dot-separated path to the claim, e.g. `personal_administrative_number`. */
    claim: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The disclosed claims of one credential of a presentation: the first set
 * of values of the credential query with this ID.
 */
export function credentialClaims(
    credentials: unknown[] | undefined,
    credentialId: string,
): Record<string, unknown> | undefined {
    for (const credential of credentials ?? []) {
        if (!isRecord(credential) || credential.id !== credentialId) continue;
        const values = credential.values;
        const first = Array.isArray(values) ? values[0] : undefined;
        return isRecord(first) ? first : undefined;
    }
    return undefined;
}

/** The claim at a dot-separated path, or undefined. */
export function claimAt(
    claims: Record<string, unknown> | undefined,
    path: string,
): unknown {
    let current: unknown = claims;
    for (const segment of path.split(".")) {
        // Own properties only: `__proto__` or `constructor` reach nothing.
        if (!isRecord(current) || !Object.hasOwn(current, segment)) {
            return undefined;
        }
        current = current[segment];
    }
    return current;
}

/**
 * A subject that stays the same for one user and one client across
 * sign-ins: HMAC-SHA-256, keyed with a secret of the instance, over the
 * tenant, the client, the issuer and the claim value. With the issuer in
 * it, two issuers that hand out the same value never share a subject. Another client gets another
 * subject for the same user (pairwise, OpenID Connect Core 1.0 Section
 * 8.1). Without the key, nobody can compute a user's subject at another
 * client or guess the value from `sub`.
 */
export function pairwiseSubject(
    key: Uint8Array,
    tenantId: string,
    clientId: string,
    issuer: string,
    value: string | number,
): string {
    return createHmac("sha256", key)
        .update(JSON.stringify([tenantId, clientId, issuer, String(value)]))
        .digest("base64url");
}

/**
 * The subject for a presentation, or undefined when the claim is missing or
 * is not a string or number, or the credential's issuer is not known.
 */
export function subjectFromPresentation(
    key: Uint8Array,
    tenantId: string,
    clientId: string,
    subject: SubjectClaim,
    credentials: unknown[] | undefined,
    issuers: Record<string, string> | undefined,
): string | undefined {
    const issuer = issuers?.[subject.credentialId];
    if (!issuer) return undefined;
    const value = claimAt(
        credentialClaims(credentials, subject.credentialId),
        subject.claim,
    );
    if (typeof value === "string" && value.length > 0) {
        return pairwiseSubject(key, tenantId, clientId, issuer, value);
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return pairwiseSubject(key, tenantId, clientId, issuer, value);
    }
    return undefined;
}

/**
 * The claims of one credential for the top level of the ID token, without
 * the reserved ones, so a relying party can map `given_name` directly.
 */
export function topLevelClaims(
    credentials: unknown[] | undefined,
    credentialId: string,
): Record<string, unknown> {
    const claims = credentialClaims(credentials, credentialId) ?? {};
    return Object.fromEntries(
        Object.entries(claims).filter(([name]) => !RESERVED_CLAIMS.has(name)),
    );
}
