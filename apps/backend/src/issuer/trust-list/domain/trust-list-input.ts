import { X509Certificate } from "node:crypto";
import { LocalizedURISchema, PostalAddressSchema } from "@owf/eudi-lote";

/** Why a field of a trust list body that passed schema validation is refused. */
type TrustListInputIssueCode =
    | "key_chain_not_found"
    | "key_chain_usage_mismatch"
    | "invalid_certificate"
    | "invalid_entity_info";

/** A refused field of a trust list body, at its path in the body. */
export interface TrustListInputIssue {
    /** For example `["keyChainId"]` or `["entities", 0, "issuerCertPem"]`. */
    path: (string | number)[];
    message: string;
    code: TrustListInputIssueCode;
}

/**
 * Fields of a trust list body name key chains the list cannot use or hold
 * values it cannot publish. The API answers `400` with an issue at each field.
 */
export class TrustListInputError extends Error {
    readonly issues: TrustListInputIssue[];

    constructor(issues: TrustListInputIssue[]) {
        const sorted = byEntity(issues);
        // The importers only log the message, so it names each field.
        super(
            sorted
                .map(({ path, message }) => `${path.join(".")}: ${message}`)
                .join("; "),
        );
        this.name = "TrustListInputError";
        this.issues = sorted;
    }
}

/** Top-level fields first, then the entities in their order; stable otherwise. */
function byEntity(issues: TrustListInputIssue[]): TrustListInputIssue[] {
    const rank = ({ path }: TrustListInputIssue) =>
        path[0] === "entities" && typeof path[1] === "number" ? path[1] : -1;
    return [...issues].sort((a, b) => rank(a) - rank(b));
}

/**
 * The Base64 DER of the certificate in `pem`, given as PEM or Base64 DER, or
 * undefined when it holds none. A trust list publishes this parsed value,
 * never the input as given.
 */
export function certificateBase64(pem: string): string | undefined {
    if (pem.trim() === "") return undefined;
    try {
        return new X509Certificate(
            pem.includes("-----BEGIN")
                ? pem
                : Buffer.from(pem.replaceAll(/\s/g, ""), "base64"),
        ).raw.toString("base64");
    } catch {
        return undefined;
    }
}

const CERTIFICATE_FIELDS = ["issuerCertPem", "revocationCertPem"] as const;

type CertificateField = (typeof CERTIFICATE_FIELDS)[number];

/** An external entity's certificate fields as the body may carry them. */
type ExternalEntityInput = {
    type?: unknown;
} & Partial<Record<CertificateField, unknown>>;

/** The Base64 DER an external entity publishes for each certificate field. */
export type ExternalEntityCertificates = Record<CertificateField, string>;

/**
 * The certificates of external entities, parsed once, by entity index, and an
 * issue for each certificate field that holds none. An entity with such a
 * field has no entry.
 */
export function externalEntityCertificates(
    entities: readonly ExternalEntityInput[],
): {
    certificates: Map<number, ExternalEntityCertificates>;
    issues: TrustListInputIssue[];
} {
    const certificates = new Map<number, ExternalEntityCertificates>();
    const issues: TrustListInputIssue[] = [];
    for (const [index, entity] of entities.entries()) {
        if (entity.type !== "external") continue;
        const parsed: Partial<ExternalEntityCertificates> = {};
        for (const field of CERTIFICATE_FIELDS) {
            const value = entity[field];
            const der =
                typeof value === "string"
                    ? certificateBase64(value)
                    : undefined;
            if (der) {
                parsed[field] = der;
            } else {
                issues.push({
                    path: ["entities", index, field],
                    message: `${field} must be an X.509 certificate in PEM or Base64 DER.`,
                    code: "invalid_certificate",
                });
            }
        }
        if (parsed.issuerCertPem && parsed.revocationCertPem) {
            certificates.set(index, parsed as ExternalEntityCertificates);
        }
    }
    return { certificates, issues };
}

/** The issue for a key chain ID that names no key chain of the tenant. */
export function keyChainNotFoundIssue(
    path: TrustListInputIssue["path"],
    keyChainId: string,
): TrustListInputIssue {
    return {
        path,
        message: `Key chain ${JSON.stringify(keyChainId)} does not exist.`,
        code: "key_chain_not_found",
    };
}

/** The entity info fields a LoTE document restricts further than the body schema. */
type EntityInfoInput = { info?: { country?: string; uri?: string } };

/**
 * Issues for entity info that the LoTE builder of `@owf/eudi-lote` refuses:
 * a country of other than two characters and an information URI that is no
 * absolute URL. Checked with the builder's own schemas, so both refuse the
 * same values; like the builder, this does not check that the country is an
 * upper-case ISO 3166-1 code.
 */
export function entityInfoIssues(
    entities: readonly EntityInfoInput[],
): TrustListInputIssue[] {
    return entities.flatMap(({ info }, index) => {
        const issues: TrustListInputIssue[] = [];
        if (
            info?.country &&
            !PostalAddressSchema.shape.Country.safeParse(info.country).success
        ) {
            issues.push({
                path: ["entities", index, "info", "country"],
                message:
                    'country must be a country code of two characters, such as "DE" or "EU".',
                code: "invalid_entity_info",
            });
        }
        if (
            info?.uri &&
            !LocalizedURISchema.shape.uriValue.safeParse(info.uri).success
        ) {
            issues.push({
                path: ["entities", index, "info", "uri"],
                message:
                    'uri must be an absolute URL, such as "https://issuer.example".',
                code: "invalid_entity_info",
            });
        }
        return issues;
    });
}
