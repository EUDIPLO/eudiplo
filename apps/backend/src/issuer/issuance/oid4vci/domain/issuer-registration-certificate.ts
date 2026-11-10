import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { hostedVctUrl } from "../../../configuration/credentials/domain/hosted-vct.js";
import type { IssuanceConfiguration } from "../../../configuration/issuance/domain/issuance-configuration.js";

export type IssuerRegistrationCertificateSettings = NonNullable<
    IssuanceConfiguration["registrationCertificate"]
>;

export type RegistrationCertificateRenewal = NonNullable<
    IssuerRegistrationCertificateSettings["renewal"]
>;

/** Renewal used when `renewal` is not set. */
export const DEFAULT_REGISTRATION_CERTIFICATE_RENEWAL: RegistrationCertificateRenewal =
    "onCredentialConfigChange";

/**
 * The cached generated certificate to serve instead of requesting a new one,
 * if any. An inactive certificate is never served. In `manual` mode an active
 * one is served even when the credential types or settings changed; otherwise
 * it must match the current fingerprint.
 */
export function usableCachedCertificate(
    cache: { jwt?: string; fingerprint?: string } | null | undefined,
    fingerprint: string,
    renewal: RegistrationCertificateRenewal,
    nowMs = Date.now(),
): string | undefined {
    if (!cache?.jwt || !isJwtActive(cache.jwt, nowMs)) {
        return undefined;
    }
    return renewal === "manual" || cache.fingerprint === fingerprint
        ? cache.jwt
        : undefined;
}

/**
 * Whether a change of the credential or issuance configuration renews the
 * generated certificate in the background.
 */
export function renewsOnConfigChange(
    settings: IssuerRegistrationCertificateSettings | null | undefined,
): boolean {
    return (
        !!settings?.enabled &&
        (settings.mode ?? "generate") === "generate" &&
        (settings.renewal ?? DEFAULT_REGISTRATION_CERTIFICATE_RENEWAL) ===
            "onCredentialConfigChange"
    );
}

/** Minimal view of a credential configuration needed for the derivation. */
export interface CredentialConfigurationTypeInfo {
    id: string;
    config?: { format?: string; docType?: string } | null;
    vct?: string | object | null;
}

/** A credential type an issuer provides, with the format it is issued in. */
interface ProvidedCredentialType {
    format: "dc+sd-jwt" | "mso_mdoc";
    /** SD-JWT VC `vct` or mdoc `docType`. */
    type: string;
}

export interface RegistrationCertificateMaterial {
    providesAttestations: ProvidedCredentialType[];
}

/**
 * Derives the credential types an issuer provides from its credential
 * configurations: the `vct` of SD-JWT VC configurations (the hosted VCT URL
 * when EUDIPLO hosts the type metadata) and the `docType` of mdoc
 * configurations. The result is deduplicated and sorted so the fingerprint is
 * stable.
 */
export function deriveRegistrationCertificateMaterial(
    credentialConfigs: CredentialConfigurationTypeInfo[],
    publicUrl: string,
    tenantId: string,
): RegistrationCertificateMaterial {
    const types = new Map<string, ProvidedCredentialType>();

    for (const credentialConfig of credentialConfigs) {
        const type = credentialType(credentialConfig, publicUrl, tenantId);
        if (type) {
            types.set(`${type.format}\n${type.type}`, type);
        }
    }

    return {
        providesAttestations: [...types.values()].sort(
            (left, right) =>
                left.type.localeCompare(right.type) ||
                left.format.localeCompare(right.format),
        ),
    };
}

function credentialType(
    credentialConfig: CredentialConfigurationTypeInfo,
    publicUrl: string,
    tenantId: string,
): ProvidedCredentialType | undefined {
    switch (credentialConfig.config?.format) {
        case "dc+sd-jwt": {
            const { vct } = credentialConfig;
            const type =
                vct && typeof vct === "object"
                    ? hostedVctUrl(publicUrl, tenantId, credentialConfig.id)
                    : nonEmpty(vct);
            return type ? { format: "dc+sd-jwt", type } : undefined;
        }
        case "mso_mdoc": {
            const type = nonEmpty(credentialConfig.config?.docType);
            return type ? { format: "mso_mdoc", type } : undefined;
        }
        default:
            return undefined;
    }
}

/** Skips blank values; others stay as stored so they match the metadata. */
function nonEmpty(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value
        : undefined;
}

/**
 * The requested credential types that a registrar-issued certificate does not
 * list in `provides_attestations`. A registrar without support for
 * `custom_provides_attestations` ignores the field and issues a certificate
 * that lists none. The registrar trims the values, so they are compared
 * trimmed.
 */
export function unlistedCredentialTypes(
    payload: Record<string, unknown>,
    material: RegistrationCertificateMaterial,
): string[] {
    const listed = new Set<string>();
    const entries = Array.isArray(payload.provides_attestations)
        ? payload.provides_attestations
        : [];
    for (const entry of entries) {
        const { format, meta } = (entry ?? {}) as {
            format?: unknown;
            meta?: { vct_values?: unknown; doctype_value?: unknown };
        };
        if (format === "mso_mdoc" && typeof meta?.doctype_value === "string") {
            listed.add(`mso_mdoc\n${meta.doctype_value.trim()}`);
        }
        if (format === "dc+sd-jwt" && Array.isArray(meta?.vct_values)) {
            for (const vct of meta.vct_values) {
                if (typeof vct === "string") {
                    listed.add(`dc+sd-jwt\n${vct.trim()}`);
                }
            }
        }
    }
    return material.providesAttestations
        .filter(({ format, type }) => !listed.has(`${format}\n${type.trim()}`))
        .map(({ type }) => type);
}

/** Why a certificate that does not list every requested type is refused. */
export function unlistedCredentialTypesMessage(types: string[]): string {
    return `The registrar issued a registration certificate that does not list ${types.join(", ")}; it needs support for custom_provides_attestations (rp-registrar 811ed05 or later)`;
}

/** Why a generated certificate cannot be requested without credential types. */
export const NO_CREDENTIAL_TYPES_MESSAGE =
    "Create an SD-JWT VC credential configuration with a vct or an mDOC credential configuration with a docType before generating an issuer registration certificate";

/**
 * Fingerprint of everything that influences a generated certificate. A cached
 * certificate is reused only while the fingerprint is unchanged. The format
 * of each type is part of it, as the certificate names the format.
 */
export function registrationCertificateFingerprint(
    settings: IssuerRegistrationCertificateSettings,
    material: RegistrationCertificateMaterial,
): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                mode: settings.mode,
                providesAttestations: material.providesAttestations,
                privacyPolicy: settings.privacyPolicy,
                supportUri: settings.supportUri,
            }),
        )
        .digest("hex");
}

const CLOCK_SKEW_SECONDS = 30;

/** Whether a JWT is within its `nbf`/`exp` window (30 s skew). */
export function isJwtActive(jwt: string, nowMs = Date.now()): boolean {
    try {
        const payload = decodeJwt(jwt);
        const now = Math.floor(nowMs / 1000);

        if (
            typeof payload.nbf === "number" &&
            now + CLOCK_SKEW_SECONDS < payload.nbf
        ) {
            return false;
        }

        if (
            typeof payload.exp === "number" &&
            now - CLOCK_SKEW_SECONDS >= payload.exp
        ) {
            return false;
        }

        return true;
    } catch {
        return false;
    }
}
