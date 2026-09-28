import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
} from "@nestjs/common";
import type { AuditLogRequestMeta } from "../../../../audit-log/audit-log.service.js";
import { AuditLogService } from "../../../../audit-log/audit-log.service.js";
import {
    getChangedFields,
    resolveAuditActor,
} from "../../../../audit-log/audit-log-context.util.js";
import { TokenPayload } from "../../../../auth/token.decorator.js";
import { CertService } from "../../../../crypto/key/cert/cert.service.js";
import { KeyUsageType } from "../../../../crypto/key/types/key-usage-type.js";
import { ConfigImportService } from "../../../../platform/config-import/config-import.service.js";
import {
    ConfigImportOrchestratorService,
    ImportPhase,
} from "../../../../platform/config-import/config-import-orchestrator.service.js";
import { loadConfigDto } from "../../../../shared/utils/config-file-loader.util.js";
import { FilesService } from "../../../../storage/files.service.js";
import { PresentationConfigService } from "../../../../verifier/presentations/configuration/presentation-config.service.js";
import type { CredentialConfiguration as CredentialConfig } from "../domain/credential-configuration.js";
import { CredentialConfigCreate } from "../dto/credential-config-create.dto.js";
import { CredentialConfigUpdate } from "../dto/credential-config-update.dto.js";
import { IaeActionType } from "../entities/iae-action.dto.js";
import {
    CREDENTIAL_CONFIGURATION_REPOSITORY,
    type CredentialConfigurationRepository,
} from "../ports/credential-configuration.repository.js";
import { CredentialConfigCreateSchema } from "../schemas/credential-config.schema.js";

/**
 * Service for managing credential configurations.
 */
@Injectable()
export class CredentialConfigService {
    private readonly logger = new Logger(CredentialConfigService.name);

    /**
     * Constructor for CredentialConfigService.
     * @param credentialConfigRepository - Tenant-scoped credential configuration store.
     */
    constructor(
        @Inject(CREDENTIAL_CONFIGURATION_REPOSITORY)
        private readonly credentialConfigRepository: CredentialConfigurationRepository,
        private readonly certService: CertService,
        private readonly filesService: FilesService,
        private readonly configImportService: ConfigImportService,
        private readonly configImportOrchestrator: ConfigImportOrchestratorService,
        private readonly presentationConfigService: PresentationConfigService,
        private readonly tenantActionLogService: AuditLogService,
    ) {
        this.configImportOrchestrator.register(
            "credentials",
            ImportPhase.CONFIGURATION,
            (tenantId) => this.importForTenant(tenantId),
        );
    }

    /**
     * Imports credential configs for a specific tenant.
     */
    public async importForTenant(tenantId: string) {
        await this.configImportService.importConfigsForTenant<CredentialConfigCreate>(
            tenantId,
            {
                subfolder: "issuance/credentials",
                fileExtension: ".json",
                validationSchema: CredentialConfigCreateSchema,
                resourceType: "credential config",
                checkExists: (tid, data) =>
                    this.getById(tid, data.id)
                        .then(() => true)
                        .catch(() => false),
                deleteExisting: (tid, data) =>
                    this.credentialConfigRepository
                        .deleteForTenant(tid, data.id)
                        .then(() => undefined),
                loadData: (filePath) =>
                    loadConfigDto(filePath, CredentialConfigCreateSchema),
                processItem: async (tid, config) => {
                    await this.processCredentialConfig(tid, config);
                },
            },
        );
    }

    /**
     * Process a credential config for import.
     * Note: IAE action validation is skipped during import because
     * presentation configs are imported in a later phase (REFERENCES).
     */
    private async processCredentialConfig(
        tenantId: string,
        config: CredentialConfigCreate,
    ) {
        // Replace image references with actual URLs
        await this.replaceImageReferences(tenantId, config);

        await this.validateAttestationKeyChain(tenantId, config.keyChainId);

        // Keep runtime-linked schema metadata unless the imported file explicitly
        // sets (or clears) schemaMeta. This avoids losing registrar linkage on
        // forced imports/reloads when schemaMeta is omitted from file configs.
        const existing = await this.getById(tenantId, config.id).catch(
            () => null,
        );
        if (
            existing?.schemaMeta !== undefined &&
            config.schemaMeta === undefined
        ) {
            config.schemaMeta = existing.schemaMeta;
        }

        // Skip IAE validation during import - presentation configs are imported later
        await this.store(tenantId, config, true);
    }

    private async validateAttestationKeyChain(
        tenantId: string,
        keyChainId?: string | null,
    ): Promise<void> {
        if (!keyChainId) {
            return;
        }

        await this.certService.find({
            tenantId,
            type: KeyUsageType.Attestation,
            keyId: keyChainId,
        });
    }

    /**
     * Replaces a single image reference with a public URL, or returns undefined if invalid.
     */
    private async resolveImageUrl(
        tenantId: string,
        image: { uri?: string } | undefined,
        context: string,
    ): Promise<{ uri: string } | undefined> {
        if (!image?.uri) {
            return undefined;
        }
        const url = await this.filesService.replaceUriWithPublicUrl(
            tenantId,
            image.uri,
        );
        if (url) {
            return { uri: url };
        }
        this.logger.warn(
            `[${tenantId}] Could not find image ${image.uri} for ${context}`,
        );
        return undefined;
    }

    /**
     * Replaces image references (logo, background_image) with actual public URLs.
     * This is used both during file import and API calls.
     * @param tenantId - The ID of the tenant.
     * @param config - The credential config to process.
     */
    private async replaceImageReferences(
        tenantId: string,
        config: CredentialConfigCreate | CredentialConfigUpdate,
    ): Promise<void> {
        if (!config.config?.display) {
            return;
        }

        config.config.display = await Promise.all(
            config.config.display.map(async (display) => {
                display.background_image = await this.resolveImageUrl(
                    tenantId,
                    display.background_image,
                    "credentials config background_image",
                );
                display.logo = await this.resolveImageUrl(
                    tenantId,
                    display.logo,
                    "credentials config logo",
                );
                return display;
            }),
        );
    }

    /**
     * Retrieves all credential configurations for a given tenant.
     * @param tenantId - The ID of the tenant.
     * @returns A promise that resolves to an array of CredentialConfig entities.
     */
    get(tenantId: string) {
        return this.credentialConfigRepository.listForTenant(tenantId);
    }

    /**
     * Retrieves a credential configuration by its ID for a given tenant.
     * @param tenantId
     * @param id
     * @returns
     */
    getById(tenantId: string, id: string) {
        return this.credentialConfigRepository.getForTenant(tenantId, id);
    }

    /**
     * Validates IAE actions in a credential configuration.
     * Checks that all referenced presentation configs exist.
     * @param tenantId - The ID of the tenant.
     * @param config - The credential config to validate.
     * @throws BadRequestException if a referenced presentation config doesn't exist.
     */
    private async validateIaeActions(
        tenantId: string,
        config: CredentialConfigCreate | CredentialConfigUpdate,
    ): Promise<void> {
        if (!config.iaeActions?.length) {
            return;
        }

        for (const action of config.iaeActions) {
            if (action.type === IaeActionType.OPENID4VP_PRESENTATION) {
                const presentationConfigId = (
                    action as { presentationConfigId: string }
                ).presentationConfigId;

                try {
                    await this.presentationConfigService.getPresentationConfig(
                        presentationConfigId,
                        tenantId,
                    );
                } catch {
                    throw new BadRequestException(
                        `IAE action references presentation config '${presentationConfigId}' which does not exist`,
                    );
                }
            }
        }
    }

    /**
     * Stores a credential configuration for a given tenant.
     * If the configuration already exists, it will be overwritten.
     * Automatically replaces image references with public URLs.
     * Validates IAE action references.
     * @param tenantId - The ID of the tenant.
     * @param config - The CredentialConfig entity to store.
     * @param skipValidation - Skip IAE action validation (used during file imports).
     * @returns A promise that resolves to the stored CredentialConfig entity.
     */
    async store(
        tenantId: string,
        config: CredentialConfigCreate,
        skipValidation = false,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
    ) {
        await this.replaceImageReferences(tenantId, config);
        await this.validateAttestationKeyChain(tenantId, config.keyChainId);
        if (!skipValidation) {
            await this.validateIaeActions(tenantId, config);
        }
        const saved = await this.credentialConfigRepository.save({
            ...config,
            tenantId,
        });

        if (actorToken) {
            await this.tenantActionLogService.record({
                tenantId,
                actionType: "credential_config_created",
                actor: resolveAuditActor(actorToken),
                changedFields: getChangedFields(
                    undefined,
                    this.sanitizeCredentialConfigForLog(saved),
                ),
                after: this.sanitizeCredentialConfigForLog(saved),
                requestMeta,
            });
        }

        return saved;
    }

    /**
     * Updates a credential configuration for a given tenant.
     * Only updates fields that are provided in the config.
     * Set fields to null to clear them.
     * Automatically replaces image references with public URLs.
     * Validates IAE action references.
     * @param tenantId - The ID of the tenant.
     * @param id - The ID of the CredentialConfig entity to update.
     * @param config - The partial CredentialConfig to update.
     * @returns A promise that resolves to the updated CredentialConfig entity.
     */
    async update(
        tenantId: string,
        id: string,
        config: CredentialConfigUpdate,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
    ) {
        await this.replaceImageReferences(tenantId, config);
        await this.validateIaeActions(tenantId, config);
        const existing = await this.getById(tenantId, id);
        const keyChainId =
            config.keyChainId !== undefined
                ? (config.keyChainId ?? undefined)
                : existing.keyChainId;
        await this.validateAttestationKeyChain(tenantId, keyChainId);
        const saved = await this.credentialConfigRepository.save({
            ...existing,
            ...config,
            id,
            tenantId,
        });

        if (actorToken) {
            await this.tenantActionLogService.record({
                tenantId,
                actionType: "credential_config_updated",
                actor: resolveAuditActor(actorToken),
                changedFields: getChangedFields(
                    this.sanitizeCredentialConfigForLog(existing),
                    this.sanitizeCredentialConfigForLog(saved),
                ),
                before: this.sanitizeCredentialConfigForLog(existing),
                after: this.sanitizeCredentialConfigForLog(saved),
                requestMeta,
            });
        }

        return saved;
    }

    /**
     * Deletes a credential configuration for a given tenant.
     * @param tenantId - The ID of the tenant.
     * @param id - The ID of the CredentialConfig entity to delete.
     * @returns A promise that resolves to the result of the delete operation.
     */
    async delete(
        tenantId: string,
        id: string,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
    ) {
        const existing = await this.getById(tenantId, id);
        const result = await this.credentialConfigRepository.deleteForTenant(
            tenantId,
            id,
        );

        if (actorToken) {
            await this.tenantActionLogService.record({
                tenantId,
                actionType: "credential_config_deleted",
                actor: resolveAuditActor(actorToken),
                before: this.sanitizeCredentialConfigForLog(existing),
                requestMeta,
            });
        }

        return result;
    }

    private sanitizeCredentialConfigForLog(
        config: CredentialConfig,
    ): Record<string, unknown> {
        return {
            id: config.id,
            format: config.config?.format,
            config: config.config,
            fields: config.fields,
            vct: config.vct,
            schemaMeta: config.schemaMeta,
            iaeActions: config.iaeActions,
            keyChainId: config.keyChainId,
        };
    }
}
