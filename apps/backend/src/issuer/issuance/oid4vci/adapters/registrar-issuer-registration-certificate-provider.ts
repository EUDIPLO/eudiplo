import { Logger } from "@nestjs/common";
import { v4 } from "uuid";
import type { RegistrationCertificateCreation } from "../../../../registrar/generated/index.js";
import type { RegistrarService } from "../../../../registrar/registrar.service.js";
import type { CredentialsService } from "../../../configuration/credentials/credentials.service.js";
import type { IssuanceService } from "../../../configuration/issuance/issuance.service.js";
import {
    deriveRegistrationCertificateMaterial,
    type IssuerRegistrationCertificateSettings,
    isJwtActive,
    registrationCertificateFingerprint,
} from "../domain/issuer-registration-certificate.js";
import type { IssuerRegistrationCertificateProvider } from "../ports/issuer-registration-certificate-provider.js";

/**
 * Provides the issuer registration certificate: the configured JWT in import
 * mode, or a registrar-issued certificate in generate mode. Generated
 * certificates are cached in the issuance configuration by fingerprint; a
 * replaced certificate is revoked at the registrar.
 */
export class RegistrarIssuerRegistrationCertificateProvider
    implements IssuerRegistrationCertificateProvider
{
    private readonly logger = new Logger(
        RegistrarIssuerRegistrationCertificateProvider.name,
    );

    constructor(
        private readonly registrar: RegistrarService,
        private readonly credentials: CredentialsService,
        private readonly issuance: IssuanceService,
    ) {}

    async resolve(
        tenantId: string,
        settings: IssuerRegistrationCertificateSettings,
    ): Promise<string | undefined> {
        try {
            return settings.mode === "import"
                ? this.imported(tenantId, settings)
                : await this.generated(tenantId, settings);
        } catch (error) {
            this.logger.warn(
                `[${tenantId}] Failed to resolve issuer registration certificate: ${error instanceof Error ? error.message : "unknown error"}`,
            );
            return undefined;
        }
    }

    private imported(
        tenantId: string,
        settings: IssuerRegistrationCertificateSettings,
    ): string | undefined {
        if (!settings.jwt) {
            this.logger.warn(
                `[${tenantId}] registrationCertificate is enabled in import mode but no jwt is configured`,
            );
            return undefined;
        }
        if (!isJwtActive(settings.jwt)) {
            this.logger.warn(
                `[${tenantId}] configured registration certificate jwt is expired or not active`,
            );
            return undefined;
        }
        return settings.jwt;
    }

    private async generated(
        tenantId: string,
        settings: IssuerRegistrationCertificateSettings,
    ): Promise<string | undefined> {
        const material = deriveRegistrationCertificateMaterial(
            await this.credentials.getCredentialConfigsForTenant(tenantId),
        );
        if (material.providedAttestations.length === 0) {
            this.logger.warn(
                `[${tenantId}] registrationCertificate generate mode requires credential configs with schema metadata`,
            );
            return undefined;
        }

        const fingerprint = registrationCertificateFingerprint(
            settings,
            material,
        );
        const cache = (await this.issuance.getIssuanceConfiguration(tenantId))
            .registrationCertificateCache;
        if (
            cache?.jwt &&
            cache.fingerprint === fingerprint &&
            isJwtActive(cache.jwt)
        ) {
            return cache.jwt;
        }

        const { schemaMetadataIds } = material;
        const body: Partial<RegistrationCertificateCreation> = {
            ...(schemaMetadataIds.length > 0
                ? {
                      provides_attestations:
                          schemaMetadataIds as RegistrationCertificateCreation["provides_attestations"],
                  }
                : {}),
            ...(settings.privacyPolicy
                ? { privacy_policy: settings.privacyPolicy }
                : {}),
            ...(settings.supportUri
                ? { support_uri: settings.supportUri }
                : {}),
        };
        const resolved = await this.registrar.resolveRegistrationCertificate(
            { body },
            {},
            v4(),
            tenantId,
        );

        if (
            cache?.jwt &&
            cache.jwt !== resolved.jwt &&
            isJwtActive(cache.jwt)
        ) {
            await this.revokeReplaced(tenantId, cache.jwt);
        }

        await this.issuance.updateRegistrationCertificateCache(tenantId, {
            jwt: resolved.jwt,
            fingerprint,
            issuedAt:
                typeof resolved.payload.iat === "number"
                    ? resolved.payload.iat
                    : undefined,
            expiresAt:
                typeof resolved.payload.exp === "number"
                    ? resolved.payload.exp
                    : undefined,
        });

        return resolved.jwt;
    }

    private async revokeReplaced(tenantId: string, jwt: string) {
        try {
            const revoked =
                await this.registrar.revokeRegistrationCertificateByJwt(
                    tenantId,
                    jwt,
                );
            if (!revoked) {
                this.logger.warn(
                    `[${tenantId}] Previous issuer registration certificate was not found as active during replacement`,
                );
            }
        } catch (error) {
            this.logger.warn(
                `[${tenantId}] Failed to revoke previous issuer registration certificate during replacement: ${error instanceof Error ? error.message : "unknown error"}`,
            );
        }
    }
}
