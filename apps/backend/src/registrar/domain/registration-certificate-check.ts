import { decodeJwt } from "jose";

/**
 * Checks a registration certificate JWT against the DCQL query it is attached
 * to, without contacting the registrar:
 *
 * 1. JWT decoding (structural validation, no signature check).
 * 2. Temporal validity (`exp`, `nbf`) with a clock skew tolerance.
 * 3. Overasking: every credential requested in `dcqlQuery.credentials` must be
 *    present in the certificate's authorized `credentials` claim. Skipped when
 *    `skipOveraskingCheck` (`SKIP_OVERASKING_CHECK`) is set.
 *
 * Pure functions; the caller decides how a problem is reported. `<TENANT_URL>`
 * placeholders must be resolved in the DCQL query before the check.
 */

/** Clock skew tolerance for `exp` and `nbf`, in seconds. */
const REGISTRATION_CERTIFICATE_CLOCK_SKEW_SECONDS = 60;

type RegistrationCertificateProblemCode =
    | "INVALID_JWT"
    | "EXPIRED"
    | "NOT_YET_VALID"
    | "NO_AUTHORIZED_CREDENTIALS"
    | "OVERASKING";

interface RegistrationCertificateProblem {
    code: RegistrationCertificateProblemCode;
    message: string;
    /** `id` of each requested credential the certificate does not authorize. */
    unauthorizedCredentialIds?: unknown[];
}

export type RegistrationCertificateCheck =
    | { payload: Record<string, any>; problem?: undefined }
    | { payload?: undefined; problem: RegistrationCertificateProblem };

export interface RegistrationCertificateCheckOptions {
    skipOveraskingCheck: boolean;
    /** Current time in seconds since the epoch. Defaults to now. */
    now?: number;
}

/**
 * The decoded payload, or the reason the certificate would be refused for the
 * DCQL query.
 */
export function checkRegistrationCertificate(
    jwt: string,
    dcqlQuery: unknown,
    {
        skipOveraskingCheck,
        now = Math.floor(Date.now() / 1000),
    }: RegistrationCertificateCheckOptions,
): RegistrationCertificateCheck {
    let payload: Record<string, any>;
    try {
        payload = decodeJwt(jwt) as Record<string, any>;
    } catch {
        return problem(
            "INVALID_JWT",
            "Registration certificate is not a valid JWT",
        );
    }

    const skew = REGISTRATION_CERTIFICATE_CLOCK_SKEW_SECONDS;
    if (typeof payload.exp === "number" && payload.exp + skew < now) {
        return problem("EXPIRED", "Registration certificate is expired");
    }
    if (typeof payload.nbf === "number" && payload.nbf - skew > now) {
        return problem(
            "NOT_YET_VALID",
            "Registration certificate is not yet valid",
        );
    }

    const credentials = (dcqlQuery as { credentials?: unknown } | null)
        ?.credentials;
    const requestedCredentials: unknown[] = Array.isArray(credentials)
        ? credentials
        : [];
    if (requestedCredentials.length === 0 || skipOveraskingCheck) {
        return { payload };
    }

    const authorizedCredentials: unknown[] | null = Array.isArray(
        payload.credentials,
    )
        ? payload.credentials
        : null;
    if (!authorizedCredentials || authorizedCredentials.length === 0) {
        return problem(
            "NO_AUTHORIZED_CREDENTIALS",
            "Registration certificate has no authorized credentials",
        );
    }

    // Claim order carries no meaning for authorization, so certificates
    // listing the same claims in another order still match.
    const authorizedFingerprints = new Set(
        authorizedCredentials.map((c) =>
            credentialFingerprint(c, { sortClaims: true }),
        ),
    );
    const unauthorized = requestedCredentials.filter(
        (c) =>
            !authorizedFingerprints.has(
                credentialFingerprint(c, { sortClaims: true }),
            ),
    );
    if (unauthorized.length > 0) {
        return {
            problem: {
                code: "OVERASKING",
                message:
                    "Registration certificate does not authorize the requested DCQL credentials",
                unauthorizedCredentialIds: unauthorized.map(
                    (c) => (c as { id?: unknown } | null)?.id,
                ),
            },
        };
    }

    return { payload };
}

function problem(
    code: RegistrationCertificateProblemCode,
    message: string,
): RegistrationCertificateCheck {
    return { problem: { code, message } };
}

/**
 * Stable canonical fingerprint of a single credential entry.
 *
 * Normalizes to the registrar CredentialDef shape (`format`, `claims`, `meta`)
 * before serializing, because DCQL credentials may include transport/query
 * fields that are not present in registrar certificates. Claims are reduced to
 * their `path`: certificates only carry the path, while DCQL claims may add
 * `id`, `values` or `intent_to_retain`. With `sortClaims`, claims are sorted so
 * the fingerprint does not depend on their order.
 */
function credentialFingerprint(
    cred: unknown,
    { sortClaims = false }: { sortClaims?: boolean } = {},
): string {
    if (!cred || typeof cred !== "object") {
        return JSON.stringify(cred ?? null);
    }
    const entry = cred as Record<string, any>;

    let rawClaims: unknown[] | undefined;
    if (Array.isArray(entry.claims)) rawClaims = entry.claims;
    else if (Array.isArray(entry.claim)) rawClaims = entry.claim;
    const normalizedClaims = rawClaims?.map((claim: any) => ({
        path: claim?.path,
    }));
    if (sortClaims) {
        normalizedClaims?.sort((a: unknown, b: unknown) =>
            canonicalJson(a).localeCompare(canonicalJson(b)),
        );
    }

    return canonicalJson({
        format: entry.format,
        claims: normalizedClaims,
        meta: entry.meta && typeof entry.meta === "object" ? entry.meta : {},
    });
}

/**
 * Recursively canonicalize a JSON value: object keys sorted, arrays preserved
 * in their original order (DCQL arrays are order-significant).
 */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    return `{${keys
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
        .join(",")}}`;
}
