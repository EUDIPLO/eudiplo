import { canonicalJson } from "../../domain/registration-certificate-check.js";

/** A localized text as the EUDI Hub models it. */
export interface EudiHubText {
    lang: string;
    content: string;
}

/** A credential as a credential request or credential issuance names it. */
export interface EudiHubCredential {
    format: "dc+sd-jwt" | "mso_mdoc";
    /** `vct` or `docType`; the EUDI Hub writes it into the certificate as given. */
    type: string;
    claims?: { path: string[] }[];
}

/** The credentials of a DCQL query as the EUDI Hub registers them, or why they cannot be. */
export type HubCredentialsMapping =
    | { credentials: EudiHubCredential[]; problem?: undefined }
    | { credentials?: undefined; problem: string };

/**
 * The credentials a credential request at the EUDI Hub must name so that the
 * registration certificate it issues passes EUDIPLO's overasking check for
 * this DCQL query. The EUDI Hub writes `type` into the certificate as
 * `meta.vct_values: [type]` or `meta.doctype_value`, and the claim paths as
 * they are; the check compares format, meta and claim paths exactly. So each
 * credential query needs exactly one `vct` or `docType` as its only meta,
 * and claims whose paths are strings only, as the EUDI Hub accepts no array
 * indexes or wildcards.
 */
export function hubCredentialsForDcql(
    dcqlQuery: unknown,
): HubCredentialsMapping {
    const queries = (dcqlQuery as { credentials?: unknown } | null)
        ?.credentials;
    if (!Array.isArray(queries) || queries.length === 0) {
        return { problem: "The DCQL query has no credential queries" };
    }
    const credentials: EudiHubCredential[] = [];
    for (const query of queries as Record<string, any>[]) {
        const name = `Credential query ${JSON.stringify(query?.id ?? "")}`;
        const type = hubType(query, name);
        if (type.problem !== undefined) return type;
        const claims = hubClaims(query, name);
        if (claims.problem !== undefined) return claims;
        credentials.push({
            format: query.format,
            type: type.value,
            claims: claims.value,
        });
    }
    return { credentials };
}

type Checked<T> =
    | { value: T; problem?: undefined }
    | { value?: undefined; problem: string };

/** The `vct` or `docType` of a credential query, the only meta it may have. */
function hubType(query: Record<string, any>, name: string): Checked<string> {
    const meta =
        query?.meta && typeof query.meta === "object" ? query.meta : {};
    const onlyKey = Object.keys(meta).length === 1;
    if (query?.format === "dc+sd-jwt") {
        const vcts = meta.vct_values;
        return onlyKey &&
            Array.isArray(vcts) &&
            vcts.length === 1 &&
            typeof vcts[0] === "string"
            ? { value: vcts[0] }
            : {
                  problem: `${name}: the EUDI Hub registers one vct per credential, so meta must be exactly { "vct_values": ["<vct>"] }`,
              };
    }
    if (query?.format === "mso_mdoc") {
        return onlyKey && typeof meta.doctype_value === "string"
            ? { value: meta.doctype_value }
            : {
                  problem: `${name}: meta must be exactly { "doctype_value": "<docType>" }`,
              };
    }
    return {
        problem: `${name}: the EUDI Hub supports the formats dc+sd-jwt and mso_mdoc only`,
    };
}

/** The claim paths of a credential query, which must be strings only. */
function hubClaims(
    query: Record<string, any>,
    name: string,
): Checked<{ path: string[] }[]> {
    const claims: unknown[] = Array.isArray(query.claims) ? query.claims : [];
    if (claims.length === 0) {
        return {
            problem: `${name}: the EUDI Hub needs the requested claims listed`,
        };
    }
    const paths: { path: string[] }[] = [];
    for (const claim of claims) {
        const path = (claim as { path?: unknown } | null)?.path;
        if (
            !Array.isArray(path) ||
            path.length === 0 ||
            !path.every((segment: unknown) => typeof segment === "string")
        ) {
            return {
                problem: `${name}: the claim path ${JSON.stringify(path)} has array indexes or wildcards, which the EUDI Hub does not accept`,
            };
        }
        paths.push({ path });
    }
    return { value: paths };
}

/** Whether an existing credential request asks for the same data for the same reason. */
export function sameCredentialRequest(
    existing: {
        credentials?: unknown;
        purpose?: unknown;
        privacyPolicy?: unknown;
    },
    wanted: {
        credentials: EudiHubCredential[];
        purpose: EudiHubText[];
        privacyPolicy: string;
    },
): boolean {
    return (
        existing.privacyPolicy === wanted.privacyPolicy &&
        sortedJson(existing.purpose, purposeKey) ===
            sortedJson(wanted.purpose, purposeKey) &&
        sortedJson(existing.credentials, credentialKey) ===
            sortedJson(wanted.credentials, credentialKey)
    );
}

function purposeKey(entry: any): string {
    return canonicalJson({ lang: entry?.lang, content: entry?.content });
}

function credentialKey(entry: any): string {
    const claims = Array.isArray(entry?.claims)
        ? entry.claims
              .map((claim: any) => canonicalJson(claim?.path ?? null))
              .sort(byCodeUnits)
        : [];
    return canonicalJson({ format: entry?.format, type: entry?.type, claims });
}

function sortedJson(value: unknown, key: (entry: unknown) => string): string {
    return Array.isArray(value)
        ? JSON.stringify(value.map(key).sort(byCodeUnits))
        : "";
}

/** The default sort order, spelled out as Sonar asks for a comparator. */
function byCodeUnits(a: string, b: string): number {
    if (a < b) return -1;
    return a > b ? 1 : 0;
}

/** Most texts in different languages the EUDI Hub accepts for one field. */
export const MAX_HUB_TEXTS = 24;

/** Language codes the EUDI Hub accepts: two letters (ISO 639-1). */
export const HUB_LANGUAGE = /^[a-z]{2}$/;

/**
 * The purpose texts the EUDI Hub accepts: those with a two-letter language
 * code, at most 24. The language tags of the others, which are kept in the
 * presentation configuration only, are listed in `notSent`.
 */
export function hubPurpose(purpose: EudiHubText[]): {
    sent: EudiHubText[];
    notSent: string[];
} {
    const twoLetter = purpose.filter(({ lang }) => HUB_LANGUAGE.test(lang));
    // German and English first, so the limit never drops them.
    const ordered = [
        ...twoLetter.filter(({ lang }) => lang === "de" || lang === "en"),
        ...twoLetter.filter(({ lang }) => lang !== "de" && lang !== "en"),
    ];
    const sent = ordered.slice(0, MAX_HUB_TEXTS);
    const sentLangs = new Set(sent.map(({ lang }) => lang));
    return {
        sent,
        notSent: purpose
            .map(({ lang }) => lang)
            .filter((lang) => !sentLangs.has(lang)),
    };
}
