import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { hostedVctUrl } from "../../../configuration/credentials/domain/hosted-vct.js";
import type { IssuanceConfiguration } from "../../../configuration/issuance/domain/issuance-configuration.js";

export type IssuerRegistrationCertificateSettings = NonNullable<
    IssuanceConfiguration["registrationCertificate"]
>;

/** Minimal view of a credential configuration needed for the derivation. */
export interface CredentialConfigurationTypeInfo {
    id: string;
    config?: { format?: string; docType?: string } | null;
    vct?: string | object | null;
}

export interface RegistrationCertificateMaterial {
    /** Credential type identifiers: SD-JWT VC `vct` and mdoc `docType`. */
    providesAttestations: string[];
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
    const types = new Set<string>();

    for (const credentialConfig of credentialConfigs) {
        const type = credentialType(credentialConfig, publicUrl, tenantId);
        if (type) {
            types.add(type);
        }
    }

    return {
        providesAttestations: [...types].sort((left, right) =>
            left.localeCompare(right),
        ),
    };
}

function credentialType(
    credentialConfig: CredentialConfigurationTypeInfo,
    publicUrl: string,
    tenantId: string,
): string | undefined {
    switch (credentialConfig.config?.format) {
        case "dc+sd-jwt": {
            const { vct } = credentialConfig;
            if (vct && typeof vct === "object") {
                return hostedVctUrl(publicUrl, tenantId, credentialConfig.id);
            }
            return nonEmpty(vct);
        }
        case "mso_mdoc":
            return nonEmpty(credentialConfig.config?.docType);
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

/** Why a generated certificate cannot be requested without credential types. */
export const NO_CREDENTIAL_TYPES_MESSAGE =
    "Create an SD-JWT VC credential configuration with a vct or an mDOC credential configuration with a docType before generating an issuer registration certificate";

/** Registrar request body for a generated issuer registration certificate. */
export function registrationCertificateCreationBody(
    settings: IssuerRegistrationCertificateSettings,
    material: RegistrationCertificateMaterial,
): {
    provides_attestations: string[];
    privacy_policy?: string;
    support_uri?: string;
} {
    return {
        provides_attestations: material.providesAttestations,
        ...(settings.privacyPolicy
            ? { privacy_policy: settings.privacyPolicy }
            : {}),
        ...(settings.supportUri ? { support_uri: settings.supportUri } : {}),
    };
}

/**
 * Fingerprint of everything that influences a generated certificate. A cached
 * certificate is reused only while the fingerprint is unchanged.
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
