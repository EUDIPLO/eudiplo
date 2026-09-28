import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import type { IssuanceConfiguration } from "../../../configuration/issuance/domain/issuance-configuration.js";

export type IssuerRegistrationCertificateSettings = NonNullable<
    IssuanceConfiguration["registrationCertificate"]
>;

/** One attestation the issuer declares in its registration certificate. */
interface ProvidedAttestation {
    credentialConfigId: string;
    format: "dc+sd-jwt" | "mso_mdoc";
    meta: {
        schema_metadata_id: string;
        schema_metadata_version?: string;
    };
}

/** Minimal view of a credential configuration needed for the derivation. */
export interface CredentialConfigurationSchemaInfo {
    id: string;
    config?: { format?: string } | null;
    schemaMeta?: { id?: string; version?: string } | null;
}

export interface RegistrationCertificateMaterial {
    schemaMetadataIds: string[];
    providedAttestations: ProvidedAttestation[];
}

/**
 * Derives the attestations an issuer provides from its credential
 * configurations. Only SD-JWT VC and mdoc configurations with schema metadata
 * are included; the result is sorted so the fingerprint is stable.
 */
export function deriveRegistrationCertificateMaterial(
    credentialConfigs: CredentialConfigurationSchemaInfo[],
): RegistrationCertificateMaterial {
    const providedAttestations: ProvidedAttestation[] = [];

    for (const credentialConfig of credentialConfigs) {
        const schemaMetadataId = credentialConfig.schemaMeta?.id;
        if (!schemaMetadataId || schemaMetadataId.trim().length === 0) {
            continue;
        }

        const format = credentialConfig.config?.format;
        if (format !== "dc+sd-jwt" && format !== "mso_mdoc") {
            continue;
        }

        const version = credentialConfig.schemaMeta?.version;
        const schemaMetadataVersion =
            typeof version === "string" && version.trim().length > 0
                ? version.trim()
                : undefined;

        providedAttestations.push({
            credentialConfigId: credentialConfig.id,
            format,
            meta: {
                schema_metadata_id: schemaMetadataId.trim(),
                ...(schemaMetadataVersion
                    ? { schema_metadata_version: schemaMetadataVersion }
                    : {}),
            },
        });
    }

    providedAttestations.sort((left, right) => {
        const leftId = left.meta.schema_metadata_id;
        const rightId = right.meta.schema_metadata_id;
        if (leftId !== rightId) {
            return leftId.localeCompare(rightId);
        }
        return left.format.localeCompare(right.format);
    });

    const schemaMetadataIds = Array.from(
        new Set(
            providedAttestations.map(
                (attestation) => attestation.meta.schema_metadata_id,
            ),
        ),
    ).sort((left, right) => left.localeCompare(right));

    return { schemaMetadataIds, providedAttestations };
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
                schemaMetadataIds: material.schemaMetadataIds,
                privacyPolicy: settings.privacyPolicy,
                supportUri: settings.supportUri,
                providedAttestations: material.providedAttestations,
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
