import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { v4 } from "uuid";
import type { AuditLogRequestMeta } from "../../../audit-log/audit-log.service.js";
import { AuditLogService } from "../../../audit-log/audit-log.service.js";
import {
    getChangedFieldsForKeys,
    resolveAuditActor,
} from "../../../audit-log/audit-log-context.util.js";
import { TokenPayload } from "../../../auth/token.decorator.js";
import { KeyChainService } from "../../../crypto/key/key-chain.service.js";
import { ConfigImportService } from "../../../platform/config-import/config-import.service.js";
import {
    ConfigImportOrchestratorService,
    ImportPhase,
} from "../../../platform/config-import/config-import-orchestrator.service.js";
import { RegistrarService } from "../../../registrar/registrar.service.js";
import { loadConfigDto } from "../../../shared/utils/config-file-loader.util.js";
import { FilesService } from "../../../storage/files.service.js";
import { unregisteredTrustAnchorsMessage } from "../../../trust/federation-trust-anchor/domain/federation-trust-anchor-errors.js";
import { FederationTrustAnchorService } from "../../../trust/federation-trust-anchor/federation-trust-anchor.service.js";
import { normalizeTrustListRefs } from "../../../trust/types.js";
import type { TrustListRef } from "../../../verifier/presentations/entities/presentation-config.entity.js";
import { OutboundUrlPolicyService } from "../../../webhook/outbound-url-policy.service.js";
import {
    deriveRegistrationCertificateMaterial,
    isJwtActive,
    NO_CREDENTIAL_TYPES_MESSAGE,
    registrationCertificateCreationBody,
    registrationCertificateFingerprint,
} from "../../issuance/oid4vci/domain/issuer-registration-certificate.js";
import { CredentialConfigService } from "../credentials/credential-config/credential-config.service.js";
import type { IssuanceConfiguration as IssuanceConfig } from "./domain/issuance-configuration.js";
import { federationEntityIdProblem } from "./domain/own-federation-entity.js";
import {
    REMOVED_CHAINED_VP_MESSAGE,
    usesRemovedChainedVp,
} from "./domain/removed-authorization-servers.js";
import { DisplayInfo } from "./dto/display.dto.js";
import { IssuanceDto } from "./dto/issuance.dto.js";
import {
    ISSUANCE_CONFIG_REPOSITORY,
    type IssuanceConfigRepository,
} from "./ports/issuance-config.repository.js";
import {
    IssuanceConfigSchema,
    unsupportedFederationOption,
} from "./schemas/issuance.schema.js";
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
        private readonly federationTrustAnchors: FederationTrustAnchorService,
        private readonly outboundUrlPolicy: OutboundUrlPolicyService,
        private readonly configService: ConfigService,
        private readonly keyChainService: KeyChainService,
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
                deleteExisting: async (tid, data) => {
                    // Reject before deleting, so a file naming unregistered
                    // trust anchors does not remove the stored config.
                    const unregistered =
                        await this.federationTrustAnchors.unregistered(
                            tid,
                            data.federation?.trustAnchors?.map(
                                (anchor) => anchor.entityId,
                            ) ?? [],
                        );
                    if (unregistered.length > 0) {
                        throw new BadRequestException(
                            unregisteredTrustAnchorsMessage(unregistered),
                        );
                    }
                    await this.issuanceConfigRepo.deleteForTenant(tid);
                },
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
        await this.issuanceConfigRepo.updateRegistrationCertificateCache(
            tenantId,
            registrationCertificateCache,
        );
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
        const material = deriveRegistrationCertificateMaterial(
            await this.credentialConfigService.get(tenantId),
            this.configService.getOrThrow<string>("PUBLIC_URL"),
            tenantId,
        );

        if (material.providesAttestations.length === 0) {
            throw new BadRequestException(NO_CREDENTIAL_TYPES_MESSAGE);
        }

        const creationBody = registrationCertificateCreationBody(
            registrationCertificateConfig,
            material,
        );

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
            isJwtActive(previousJwt)
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

        const fingerprint = registrationCertificateFingerprint(
            registrationCertificateConfig,
            material,
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
        requestMeta?: AuditLogRequestMeta,
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

        // The HTTP API does not validate `federation` against the schema.
        const federationProblem = unsupportedFederationOption(
            (filteredValue as Partial<IssuanceDto>).federation,
        );
        if (federationProblem) {
            throw new BadRequestException(federationProblem);
        }
        const entityId = (filteredValue as Partial<IssuanceDto>).federation
            ?.entityId;
        const entityIdProblem = entityId
            ? federationEntityIdProblem(entityId, {
                  allowHttp: this.outboundUrlPolicy.allowHttp(),
              })
            : undefined;
        if (entityIdProblem) {
            throw new BadRequestException(entityIdProblem);
        }
        // Only trust anchors this change adds are checked, so a stored
        // configuration whose trust anchors are not registered yet can still
        // be changed otherwise; they are not trusted until registered.
        const stored = new Set(
            existingConfig.federation?.trustAnchors?.map(
                (anchor) => anchor.entityId,
            ) ?? [],
        );
        const unregistered = await this.federationTrustAnchors.unregistered(
            tenantId,
            (
                (filteredValue as Partial<IssuanceDto>).federation
                    ?.trustAnchors ?? []
            )
                .map((anchor) => anchor.entityId)
                .filter((entityId) => !stored.has(entityId)),
        );
        if (unregistered.length > 0) {
            throw new BadRequestException(
                unregisteredTrustAnchorsMessage(unregistered),
            );
        }

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

        const removedServer =
            configuredAuthorizationServers.find(usesRemovedChainedVp);
        if (removedServer) {
            throw new BadRequestException(
                `Authorization server '${removedServer.id}': ${REMOVED_CHAINED_VP_MESSAGE}`,
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

        await this.assertAccessTokenSigningKeys(
            tenantId,
            configuredAuthorizationServers,
            existingConfig.authorizationServers,
        );

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
            const after = this.sanitizeIssuanceConfigForLog(saved);
            await this.tenantActionLogService.record({
                tenantId,
                actionType: "issuance_config_updated",
                actor: resolveAuditActor(actorToken),
                // Compared before redaction, so a new upstream client secret
                // is listed.
                changedFields: getChangedFieldsForKeys(
                    existingConfig,
                    saved,
                    Object.keys(after) as (keyof IssuanceConfig)[],
                ),
                before,
                after,
                requestMeta,
            });
        }

        return saved;
    }

    /**
     * Refuses a `token.signingKeyId` that names no key chain with usage type
     * `accessToken`. Only values this change sets are checked, so a stored
     * configuration from before the check can still be changed otherwise;
     * its token requests fail until the value is fixed.
     */
    private async assertAccessTokenSigningKeys(
        tenantId: string,
        servers: Array<{ id?: string; token?: { signingKeyId?: string } }>,
        storedServers: unknown,
    ): Promise<void> {
        const stored = new Map(
            (Array.isArray(storedServers) ? storedServers : []).map(
                (server) => [server?.id, server?.token?.signingKeyId],
            ),
        );
        for (const server of servers) {
            const keyChainId = server.token?.signingKeyId;
            if (!keyChainId || stored.get(server.id) === keyChainId) continue;
            const refusal =
                await this.keyChainService.accessTokenKeyChainRefusal(
                    tenantId,
                    keyChainId,
                );
            if (refusal) {
                throw new BadRequestException(
                    `Authorization server '${server.id}': ${refusal}`,
                );
            }
        }
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
                hasVerifierKeyPem: !!ref.verifierKeyPem,
                hasVerifierX509Der: !!ref.verifierX509Der,
            }));
        };

        const authorizationServers = config.authorizationServers?.map(
            (server) => {
                const { upstream } = server as typeof server & {
                    upstream?: { clientSecret?: string };
                };
                return {
                    ...server,
                    // Upstream client secret of chained servers.
                    ...(upstream?.clientSecret && {
                        upstream: { ...upstream, clientSecret: "[REDACTED]" },
                    }),
                    walletProviderTrustLists: sanitizeWalletProviderTrustLists(
                        (
                            server as typeof server & {
                                walletProviderTrustLists?: TrustListRef[];
                            }
                        ).walletProviderTrustLists,
                    ),
                };
            },
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
                hasVerifierKeyPem: !!ref.verifierKeyPem,
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
            walletAttestationStatusCheckMode:
                config.walletAttestationStatusCheckMode,
            authorizationServers,
            federation: config.federation,
            registrationCertificate,
            registrationCertificateCache,
            notificationEndpointEnabled: config.notificationEndpointEnabled,
            credentialResponseEncryption: config.credentialResponseEncryption,
            credentialRequestEncryption: config.credentialRequestEncryption,
            txCodeMaxAttempts: config.txCodeMaxAttempts,
            offerLifetimeSeconds: config.offerLifetimeSeconds,
        };
    }
}
