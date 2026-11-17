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
        const meta =
            query?.meta && typeof query.meta === "object" ? query.meta : {};
        const metaKeys = Object.keys(meta);
        let type: string;
        if (query?.format === "dc+sd-jwt") {
            const vcts = meta.vct_values;
            if (
                metaKeys.length !== 1 ||
                !Array.isArray(vcts) ||
                vcts.length !== 1 ||
                typeof vcts[0] !== "string"
            ) {
                return {
                    problem: `${name}: the EUDI Hub registers one vct per credential, so meta must be exactly { "vct_values": ["<vct>"] }`,
                };
            }
            type = vcts[0];
        } else if (query?.format === "mso_mdoc") {
            if (
                metaKeys.length !== 1 ||
                typeof meta.doctype_value !== "string"
            ) {
                return {
                    problem: `${name}: meta must be exactly { "doctype_value": "<docType>" }`,
                };
            }
            type = meta.doctype_value;
        } else {
            return {
                problem: `${name}: the EUDI Hub supports the formats dc+sd-jwt and mso_mdoc only`,
            };
        }
        const claims = Array.isArray(query.claims) ? query.claims : [];
        if (claims.length === 0) {
            return {
                problem: `${name}: the EUDI Hub needs the requested claims listed`,
            };
        }
        const paths: { path: string[] }[] = [];
        for (const claim of claims) {
            const path = claim?.path;
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
        credentials.push({ format: query.format, type, claims: paths });
    }
    return { credentials };
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
              .sort()
        : [];
    return canonicalJson({ format: entry?.format, type: entry?.type, claims });
}

function sortedJson(value: unknown, key: (entry: unknown) => string): string {
    return Array.isArray(value) ? JSON.stringify(value.map(key).sort()) : "";
}
