import {
    getAccessCertificateSubjectIdentifier,
    parseAccessCertificate,
} from "@owf/eudi-access-certificate";
import { decodeJwt } from "jose";

/**
 * Checks a registration certificate JWT against the DCQL query it is attached
 * to, without contacting the registrar:
 *
 * 1. JWT decoding (structural validation, no signature check).
 * 2. Temporal validity (`exp`, `nbf`) with a clock skew tolerance.
 * 3. Access certificate match (ETSI TS 119 475 clause 5.1): when an access
 *    certificate is given, the identifier the registration certificate names
 *    must be the access certificate subject's `organizationIdentifier` (legal
 *    person) or `serialNumber` (natural person), as
 *    `@owf/eudi-access-certificate` reads it. That identifier is
 *    `intermediary.sub` when the relying party acts through an intermediary
 *    (which presents its own access certificate) and must then be present;
 *    otherwise `sub`. The v1.1.1 shapes `act.sub.id` and `sub.id` are read
 *    too. Certificates without any identifier are not checked.
 * 4. Overasking: every credential requested in `dcqlQuery.credentials` must be
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
    | "ACCESS_CERTIFICATE_MISMATCH"
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
    /**
     * Leaf access certificate (PEM or base64 DER) the request is signed with.
     * When omitted, the registration certificate is not matched against it.
     */
    accessCertificate?: string;
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
        accessCertificate,
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

    if (accessCertificate !== undefined) {
        const mismatch = accessCertificateMismatch(payload, accessCertificate);
        if (mismatch) {
            return problem("ACCESS_CERTIFICATE_MISMATCH", mismatch);
        }
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

/**
 * The identifier the access certificate must carry, and the field it comes
 * from. ETSI TS 119 475 v1.2.1 names the relying party in `sub` and an
 * intermediary in `intermediary.sub`; v1.1.1 used `sub.id` and `act.sub.id`
 * (Annex C: a string `act.sub`). An intermediary presents its own access
 * certificate, so its identifier is matched instead of the relying party's.
 */
function expectedIdentifiers(payload: Record<string, any>): {
    field: string;
    ids: string[];
    intermediary: boolean;
} {
    if (isRecord(payload.intermediary)) {
        return {
            field: "intermediary.sub",
            ids: identifiers(payload.intermediary.sub),
            intermediary: true,
        };
    }
    if (isRecord(payload.act)) {
        const { sub } = payload.act;
        return isRecord(sub)
            ? {
                  field: "act.sub.id",
                  ids: identifiers(sub.id),
                  intermediary: true,
              }
            : { field: "act.sub", ids: identifiers(sub), intermediary: true };
    }
    return isRecord(payload.sub)
        ? {
              field: "sub.id",
              ids: identifiers(payload.sub.id),
              intermediary: false,
          }
        : { field: "sub", ids: identifiers(payload.sub), intermediary: false };
}

/**
 * Why the access certificate does not belong to the relying party (or the
 * intermediary) the registration certificate names, or `undefined` when it
 * does or when the registration certificate names no identifier to compare.
 */
function accessCertificateMismatch(
    payload: Record<string, any>,
    accessCertificate: string,
): string | undefined {
    const { field, ids, intermediary } = expectedIdentifiers(payload);
    if (ids.length === 0) {
        // GEN-5.2.4-09: an intermediated certificate names the intermediary,
        // whose access certificate signs the request.
        return intermediary
            ? `The registration certificate names an intermediary but no ${field} to match with the access certificate`
            : undefined;
    }

    let presented: string | undefined;
    try {
        // organizationIdentifier of a legal person, serialNumber of a natural
        // person (ETSI TS 119 475 Tables 1 and 3, ETSI TS 119 411-8).
        presented = getAccessCertificateSubjectIdentifier(
            parseAccessCertificate(accessCertificate),
        )?.trim();
    } catch (error) {
        const reason = error instanceof Error ? `: ${error.message}` : "";
        return `The access certificate could not be read to match it with the registration certificate${reason}`;
    }

    // GEN-5.1.1-04: with several identifiers, one match is enough.
    if (presented && ids.includes(presented)) {
        return undefined;
    }
    const found = presented
        ? `carries '${presented}'`
        : "has no organizationIdentifier or serialNumber";
    return `The registration certificate does not belong to the access certificate: its ${field} is ${ids.map((id) => `'${id}'`).join(", ")}, but the access certificate subject ${found}`;
}

function identifiers(value: unknown): string[] {
    const values = Array.isArray(value) ? value : [value];
    return values
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
}

function isRecord(value: unknown): value is Record<string, any> {
    return !!value && typeof value === "object" && !Array.isArray(value);
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
