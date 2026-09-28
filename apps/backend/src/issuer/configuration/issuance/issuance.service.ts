import { createHash } from "node:crypto";
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
} from "@nestjs/common";
import { Request } from "express";
import { decodeJwt } from "jose";
import { v4 } from "uuid";
import { AuditLogService } from "../../../audit-log/audit-log.service.js";
import {
    extractRequestMeta,
    getChangedFields,
    resolveAuditActor,
} from "../../../audit-log/audit-log-context.util.js";
import { TokenPayload } from "../../../auth/token.decorator.js";
import { ConfigImportService } from "../../../platform/config-import/config-import.service.js";
import {
    ConfigImportOrchestratorService,
    ImportPhase,
} from "../../../platform/config-import/config-import-orchestrator.service.js";
import { RegistrarService } from "../../../registrar/registrar.service.js";
import { loadConfigDto } from "../../../shared/utils/config-file-loader.util.js";
import { FilesService } from "../../../storage/files.service.js";
import { normalizeTrustListRefs } from "../../../trust/types.js";
import type { TrustListRef } from "../../../verifier/presentations/entities/presentation-config.entity.js";
import { CredentialConfigService } from "../credentials/credential-config/credential-config.service.js";
import type { IssuanceConfiguration as IssuanceConfig } from "./domain/issuance-configuration.js";
import { DisplayInfo } from "./dto/display.dto.js";
import { IssuanceDto } from "./dto/issuance.dto.js";
import { IssuerProvidedAttestation } from "./dto/issuer-registration-certificate.dto.js";
import {
    ISSUANCE_CONFIG_REPOSITORY,
    type IssuanceConfigRepository,
} from "./ports/issuance-config.repository.js";
import { IssuanceConfigSchema } from "./schemas/issuance.schema.js";
/**
 * Service for managing issuance configurations.
 * It provides methods to get, store, and delete issuance configurations.
 */
@Injectable()
export class IssuanceService {
    private readonly logger = new Logger(IssuanceService.name);

    /**
     * Constructor for IssuanceService.
     * @param issuanceConfigRepo
     * @param credentialsConfigService
     */
    constructor(
        @Inject(ISSUANCE_CONFIG_REPOSITORY)
        private readonly issuanceConfigRepo: IssuanceConfigRepository,
        private readonly filesService: FilesService,
        private readonly credentialConfigService: CredentialConfigService,
        private readonly registrarService: RegistrarService,
        private readonly configImportService: ConfigImportService,
        private readonly configImportOrchestrator: ConfigImportOrchestratorService,
        private readonly tenantActionLogService: AuditLogService,
    ) {
        this.configImportOrchestrator.register(
            "issuance",
            ImportPhase.CONFIGURATION,
            (tenantId) => this.importForTenant(tenantId),
        );
    }

    /**
     * Import issuance configurations for a specific tenant.
     */
    private async importForTenant(tenantId: string) {
        await this.configImportService.importConfigsForTenant<IssuanceDto>(
            tenantId,
            {
                subfolder: "issuance",
                fileExtension: ".json",
                validationSchema: IssuanceConfigSchema,
                resourceType: "issuance config",
                formatValidationError: (error) =>
                    this.configImportService.formatNestedValidationError(error),
                checkExists: (tid) => {
                    return this.getIssuanceConfiguration(tid)
                        .then(() => true)
                        .catch(() => false);
                },
                deleteExisting: (tid) =>
                    this.issuanceConfigRepo
                        .deleteForTenant(tid)
                        .then(() => undefined),
                loadData: (filePath) =>
                    loadConfigDto(filePath, IssuanceConfigSchema),
                processItem: async (tid, issuanceDto) => {
                    // Replace relative URIs with public URLs
                    issuanceDto.display = await this.replaceUrl(
                        issuanceDto.display,
                        tid,
                    );

                    await this.storeIssuanceConfiguration(tid, issuanceDto);
                },
            },
        );
    }

    private replaceUrl(display: DisplayInfo[], tenantId: string) {
        return Promise.all(
            display.map(async (display) => {
                if (display.logo?.uri) {
                    const uri = await this.filesService.replaceUriWithPublicUrl(
                        tenantId,
                        display.logo.uri.trim(),
                    );
                    if (!uri) {
                        this.logger.warn(
                            `[${tenantId}] Could not find logo ${display.logo.uri}, skipping`,
                        );
                        delete display.logo;
                    } else {
                        display.logo.uri = uri;
                    }
                }
                return display;
            }),
        );
    }

    /**
     * Returns the issuance configuration for this tenant.
     * @param tenantId
     * @returns
     */
    public getIssuanceConfiguration(tenantId: string) {
        return this.issuanceConfigRepo.getForTenant(tenantId);
    }

    /**
     * Updates only the server-managed registration certificate cache.
     */
    async updateRegistrationCertificateCache(
        tenantId: string,
        registrationCertificateCache: IssuanceConfig["registrationCertificateCache"],
    ): Promise<void> {
        await this.issuanceConfigRepo.save({
            ...(await this.getIssuanceConfiguration(tenantId)),
            tenantId,
            registrationCertificateCache,
        });
    }

    /**
     * Force reissue of issuer registration certificate in generate mode.
     * Replaces cache and revokes the previously active cached certificate.
     */
    async reissueRegistrationCertificate(
        tenantId: string,
    ): Promise<IssuanceConfig> {
        const issuanceConfig = await this.getIssuanceConfiguration(tenantId);
        const registrationCertificateConfig =
            issuanceConfig.registrationCertificate;

        if (!registrationCertificateConfig?.enabled) {
            throw new BadRequestException(
                "Issuance config has no enabled registration certificate",
            );
        }

        const mode = registrationCertificateConfig.mode ?? "generate";
        if (mode !== "generate") {
            throw new BadRequestException(
                "Reissue is only supported in generate mode",
            );
        }

        if (!(await this.registrarService.isEnabledForTenant(tenantId))) {
            throw new BadRequestException(
                "Registrar is not enabled for this tenant",
            );
        }

        const previousJwt = issuanceConfig.registrationCertificateCache?.jwt;
        const { schemaMetadataIds, providedAttestations } =
            await this.deriveRegistrationCertificateMaterialFromCredentialConfigs(
                tenantId,
            );

        if (providedAttestations.length === 0) {
            throw new BadRequestException(
                "No credential configs with supported schema metadata found for registration certificate generation",
            );
        }

        const creationBody = {
            ...(schemaMetadataIds.length > 0
                ? {
                      provides_attestations: schemaMetadataIds,
                  }
                : {}),
            ...(registrationCertificateConfig.privacyPolicy
                ? {
                      privacy_policy:
                          registrationCertificateConfig.privacyPolicy,
                  }
                : {}),
            ...(registrationCertificateConfig.supportUri
                ? { support_uri: registrationCertificateConfig.supportUri }
                : {}),
        };

        const resolved =
            await this.registrarService.resolveRegistrationCertificate(
                { body: creationBody },
                {},
                `issuance-reissue-${v4()}`,
                tenantId,
            );

        if (
            previousJwt &&
            previousJwt !== resolved.jwt &&
            this.isJwtActive(previousJwt)
        ) {
            try {
                await this.registrarService.revokeRegistrationCertificateByJwt(
                    tenantId,
                    previousJwt,
                );
            } catch (error) {
                this.logger.warn(
                    `[${tenantId}] Failed to revoke previous issuer registration certificate during manual reissue: ${error instanceof Error ? error.message : "unknown error"}`,
                );
            }
        }

        const fingerprint = this.computeRegistrationCertificateFingerprint(
            registrationCertificateConfig,
            schemaMetadataIds,
            providedAttestations,
        );

        await this.updateRegistrationCertificateCache(tenantId, {
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

        return this.getIssuanceConfiguration(tenantId);
    }

    /**
     * Store the config. If it already exist, merge with existing values.
     * - Undefined values are ignored, preserving existing configuration.
     * - Null values explicitly clear/unset the field.
     * @param tenantId
     * @param value
     * @returns
     */
    async storeIssuanceConfiguration(
        tenantId: string,
        value: Partial<IssuanceDto>,
        actorToken?: TokenPayload,
        req?: Request,
    ) {
        if (value.display) {
            value.display = await this.replaceUrl(value.display, tenantId);
        }

        // Fetch existing configuration (if any)
        let existingConfig: Partial<IssuanceConfig> = {};
        try {
            existingConfig = await this.getIssuanceConfiguration(tenantId);
        } catch {
            // No existing config, will create new
            existingConfig = {
                tenantId,
                authorizationServers: [
                    {
                        type: "built-in",
                        id: "issuer-built-in",
                        enabled: true,
                    },
                ],
            };
        }

        // Filter out undefined values from the incoming config.
        // Null values are kept to allow explicitly clearing a field.
        const filteredValue = Object.fromEntries(
            Object.entries(value).filter(([, v]) => v !== undefined),
        );

        const hasIncomingAuthorizationServers =
            Object.prototype.hasOwnProperty.call(
                filteredValue,
                "authorizationServers",
            );
        const effectiveAuthorizationServers = hasIncomingAuthorizationServers
            ? (filteredValue as Partial<IssuanceDto>).authorizationServers
            : existingConfig.authorizationServers;

        if (!Array.isArray(effectiveAuthorizationServers)) {
            throw new BadRequestException(
                "At least one authorization server must be configured",
            );
        }

        const configuredAuthorizationServers =
            effectiveAuthorizationServers as Array<{
                id?: string;
                type?: string;
            }>;

        if (configuredAuthorizationServers.length < 1) {
            throw new BadRequestException(
                "At least one authorization server must be configured",
            );
        }

        const builtInCount = configuredAuthorizationServers.filter(
            (server) => server?.type === "built-in",
        ).length;
        if (builtInCount > 1) {
            throw new BadRequestException(
                "Only one built-in authorization server can be configured",
            );
        }

        const reservedIds = new Set(["built-in", "chained-as"]);
        const seenIds = new Set<string>();
        for (const server of configuredAuthorizationServers) {
            if (typeof server.id !== "string" || server.id.trim().length < 1) {
                throw new BadRequestException(
                    "Each authorization server must define a non-empty id",
                );
            }

            const normalizedId = server.id.trim();
            if (reservedIds.has(normalizedId)) {
                throw new BadRequestException(
                    `Authorization server id '${normalizedId}' is reserved`,
                );
            }

            if (seenIds.has(normalizedId)) {
                throw new BadRequestException(
                    `Authorization server id '${normalizedId}' is duplicated`,
                );
            }

            seenIds.add(normalizedId);
            server.id = normalizedId;
        }

        const before =
            "tenantId" in existingConfig
                ? this.sanitizeIssuanceConfigForLog(
                      existingConfig as IssuanceConfig,
                  )
                : undefined;

        const saved = await this.issuanceConfigRepo.save({
            ...existingConfig,
            ...filteredValue,
            tenantId,
        });

        if (actorToken) {
            await this.tenantActionLogService.record({
                tenantId,
                actionType: "issuance_config_updated",
                actor: resolveAuditActor(actorToken),
                changedFields: getChangedFields(
                    before,
                    this.sanitizeIssuanceConfigForLog(saved),
                ),
                before,
                after: this.sanitizeIssuanceConfigForLog(saved),
                requestMeta: extractRequestMeta(req),
            });
        }

        return saved;
    }

    private sanitizeIssuanceConfigForLog(
        config: IssuanceConfig,
    ): Record<string, unknown> {
        const sanitizeWalletProviderTrustLists = (
            value: TrustListRef[] | null | undefined,
        ) => {
            let walletProviderTrustListsRaw: ReturnType<
                typeof normalizeTrustListRefs
            >;
            try {
                walletProviderTrustListsRaw = normalizeTrustListRefs(value);
            } catch {
                walletProviderTrustListsRaw = [];
            }
            return walletProviderTrustListsRaw.map((ref) => ({
                url: ref.url,
                hasVerifierKey: !!ref.verifierKey,
                hasVerifierX509Der: !!ref.verifierX509Der,
            }));
        };

        const authorizationServers = config.authorizationServers?.map(
            (server) => ({
                ...server,
                walletProviderTrustLists: sanitizeWalletProviderTrustLists(
                    (
                        server as typeof server & {
                            walletProviderTrustLists?: TrustListRef[];
                        }
                    ).walletProviderTrustLists,
                ),
            }),
        );

        let walletProviderTrustListsRaw: ReturnType<
            typeof normalizeTrustListRefs
        >;
        try {
            walletProviderTrustListsRaw = normalizeTrustListRefs(
                config.walletProviderTrustLists,
            );
        } catch {
            walletProviderTrustListsRaw = [];
        }
        const walletProviderTrustLists = walletProviderTrustListsRaw.map(
            (ref) => ({
                url: ref.url,
                hasVerifierKey: !!ref.verifierKey,
                hasVerifierX509Der: !!ref.verifierX509Der,
            }),
        );

        const registrationCertificate = config.registrationCertificate
            ? {
                  ...config.registrationCertificate,
                  jwt: config.registrationCertificate.jwt
                      ? "[REDACTED]"
                      : undefined,
              }
            : config.registrationCertificate;

        const registrationCertificateCache = config.registrationCertificateCache
            ? {
                  ...config.registrationCertificateCache,
                  jwt: "[REDACTED]",
              }
            : config.registrationCertificateCache;

        return {
            display: config.display,
            batchSize: config.batchSize,
            dPopRequired: config.dPopRequired,
            walletAttestationRequired: config.walletAttestationRequired,
            walletProviderTrustLists,
            signingKeyId: config.signingKeyId,
            authorizationServers,
            federation: config.federation,
            registrationCertificate,
            registrationCertificateCache,
            notificationEndpointEnabled: config.notificationEndpointEnabled,
            credentialResponseEncryption: config.credentialResponseEncryption,
            credentialRequestEncryption: config.credentialRequestEncryption,
            txCodeMaxAttempts: config.txCodeMaxAttempts,
        };
    }

    private normalizeSchemaMetadataIds(
        ids: Array<string | null | undefined>,
    ): string[] {
        return Array.from(
            new Set(
                ids
                    .filter(
                        (id): id is string =>
                            typeof id === "string" && id.trim().length > 0,
                    )
                    .map((id) => id.trim()),
            ),
        ).sort((left, right) => left.localeCompare(right));
    }

    private async deriveRegistrationCertificateMaterialFromCredentialConfigs(
        tenantId: string,
    ): Promise<{
        schemaMetadataIds: string[];
        providedAttestations: IssuerProvidedAttestation[];
    }> {
        const credentialConfigs =
            await this.credentialConfigService.get(tenantId);
        const providedAttestations: IssuerProvidedAttestation[] = [];

        for (const credentialConfig of credentialConfigs) {
            const schemaMetadataId = credentialConfig.schemaMeta?.id;
            if (!schemaMetadataId || schemaMetadataId.trim().length === 0) {
                continue;
            }

            const format = credentialConfig.config?.format;
            if (format !== "dc+sd-jwt" && format !== "mso_mdoc") {
                continue;
            }

            const schemaMetadataVersion =
                typeof credentialConfig.schemaMeta?.version === "string" &&
                credentialConfig.schemaMeta.version.trim().length > 0
                    ? credentialConfig.schemaMeta.version.trim()
                    : undefined;

            providedAttestations.push({
                credentialConfigId: credentialConfig.id,
                format,
                meta: {
                    schema_metadata_id: schemaMetadataId.trim(),
                    ...(schemaMetadataVersion
                        ? {
                              schema_metadata_version: schemaMetadataVersion,
                          }
                        : {}),
                },
            });
        }

        providedAttestations.sort((left, right) => {
            const leftId =
                typeof left.meta?.["schema_metadata_id"] === "string"
                    ? left.meta["schema_metadata_id"]
                    : "";
            const rightId =
                typeof right.meta?.["schema_metadata_id"] === "string"
                    ? right.meta["schema_metadata_id"]
                    : "";

            if (leftId !== rightId) {
                return leftId.localeCompare(rightId);
            }

            return (left.format ?? "").localeCompare(right.format ?? "");
        });

        const schemaMetadataIds = this.normalizeSchemaMetadataIds(
            providedAttestations.map((attestation) => {
                const value = attestation.meta?.["schema_metadata_id"];
                return typeof value === "string" ? value : undefined;
            }),
        );

        return {
            schemaMetadataIds,
            providedAttestations,
        };
    }

    private computeRegistrationCertificateFingerprint(
        registrationCertificateConfig: NonNullable<
            IssuanceConfig["registrationCertificate"]
        >,
        resolvedSchemaMetadataIds: string[],
        derivedProvidedAttestations: IssuerProvidedAttestation[],
    ): string {
        const material = {
            mode: registrationCertificateConfig.mode,
            schemaMetadataIds: resolvedSchemaMetadataIds,
            privacyPolicy: registrationCertificateConfig.privacyPolicy,
            supportUri: registrationCertificateConfig.supportUri,
            providedAttestations: derivedProvidedAttestations,
        };

        return createHash("sha256")
            .update(JSON.stringify(material))
            .digest("hex");
    }

    private isJwtActive(jwt: string): boolean {
        try {
            const payload = decodeJwt(jwt);
            const now = Math.floor(Date.now() / 1000);
            const skewSeconds = 30;

            if (
                typeof payload.nbf === "number" &&
                now + skewSeconds < payload.nbf
            ) {
                return false;
            }

            if (
                typeof payload.exp === "number" &&
                now - skewSeconds >= payload.exp
            ) {
                return false;
            }

            return true;
        } catch {
            return false;
        }
    }
}
