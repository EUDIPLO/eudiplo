import { ConflictException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import type { AuditLogRequestMeta } from "../../../audit-log/audit-log.service.js";
import { AuditLogService } from "../../../audit-log/audit-log.service.js";
import {
    getChangedFields,
    resolveAuditActor,
} from "../../../audit-log/audit-log-context.util.js";
import { TokenPayload } from "../../../auth/token.decorator.js";
import { ConfigImportService } from "../../../platform/config-import/config-import.service.js";
import {
    ConfigImportOrchestratorService,
    ImportPhase,
} from "../../../platform/config-import/config-import-orchestrator.service.js";
import { loadJsonFile } from "../../../shared/utils/config-file-loader.util.js";
import { PresentationConfigCreateDto } from "../dto/presentation-config-create.dto.js";
import { PresentationConfigUpdateDto } from "../dto/presentation-config-update.dto.js";
import { PresentationConfig } from "../entities/presentation-config.entity.js";
import { PresentationRegistrationCertificateService } from "./presentation-registration-certificate.service.js";
import { normalizeRegistrationCertFormFields } from "./registration-cert-form-fields.js";

/**
 * Tenant-scoped CRUD for presentation configurations, including the
 * file-based import and audit logging of administrative changes.
 */
@Injectable()
export class PresentationConfigService {
    constructor(
        @InjectRepository(PresentationConfig)
        private readonly repository: Repository<PresentationConfig>,
        private readonly registrationCertificates: PresentationRegistrationCertificateService,
        private readonly configImportService: ConfigImportService,
        configImportOrchestrator: ConfigImportOrchestratorService,
        private readonly auditLogService: AuditLogService,
    ) {
        // Register presentation config import in REFERENCES phase
        // This runs after CORE (keys, certs) and CONFIGURATION phases
        configImportOrchestrator.register(
            "presentation-configs",
            ImportPhase.REFERENCES,
            (tenantId) => this.importForTenant(tenantId),
        );
    }

    /**
     * Imports presentation configurations for a specific tenant.
     */
    private async importForTenant(tenantId: string) {
        await this.configImportService.importConfigsForTenant<PresentationConfigCreateDto>(
            tenantId,
            {
                subfolder: "presentation",
                fileExtension: ".json",
                validationSchema: PresentationConfigCreateDto,
                resourceType: "presentation config",
                loadData: (filePath) => {
                    const payload =
                        loadJsonFile<Record<string, unknown>>(filePath);
                    const id = (filePath.split("/").pop() || "").replace(
                        ".json",
                        "",
                    );
                    payload.id = id;
                    return payload as unknown as PresentationConfigCreateDto;
                },
                checkExists: (tid, data) => {
                    return this.getPresentationConfig(data.id, tid)
                        .then(() => true)
                        .catch(() => false);
                },
                deleteExisting: async (tid, data) => {
                    await this.repository.delete({
                        id: data.id,
                        tenantId: tid,
                    });
                },
                processItem: async (tid, config) => {
                    await this.storePresentationConfig(tid, config);
                },
            },
        );
    }

    /**
     * Retrieves all presentation configurations for a given tenant.
     * @param tenantId - The ID of the tenant for which to retrieve configurations.
     * @returns A promise that resolves to an array of PresentationConfig entities.
     */
    getPresentationConfigs(tenantId: string): Promise<PresentationConfig[]> {
        return this.repository.find({
            where: { tenantId },
            order: { createdAt: "DESC" },
        });
    }

    /**
     * Retrieves a presentation configuration by its ID and tenant ID.
     * @param id - The ID of the presentation configuration to retrieve.
     * @param tenantId - The ID of the tenant for which to retrieve the configuration.
     * @returns A promise that resolves to the requested PresentationConfig entity.
     */
    getPresentationConfig(
        id: string,
        tenantId: string,
    ): Promise<PresentationConfig> {
        return this.repository
            .findOneByOrFail({
                id,
                tenantId,
            })
            .catch(() => {
                throw new ConflictException(`Request ID ${id} not found`);
            });
    }

    /**
     * Stores a new presentation configuration.
     * @param tenantId - The ID of the tenant for which to store the configuration.
     * @param vprequest - The PresentationConfig entity to store.
     * @returns A promise that resolves to the stored PresentationConfig entity.
     */
    async storePresentationConfig(
        tenantId: string,
        vprequest: PresentationConfigCreateDto,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
    ) {
        const normalizedRequest =
            normalizeRegistrationCertFormFields(vprequest);
        const merged = {
            ...normalizedRequest,
            tenantId,
        } as PresentationConfig;

        // Persist first for fast UI response; cache is resolved asynchronously.
        merged.registrationCertCache = null;
        const saved = await this.repository.save(merged);

        if (saved.registration_cert) {
            this.registrationCertificates.scheduleRefresh(saved.id, tenantId);
        }

        if (actorToken) {
            await this.auditLogService.record({
                tenantId,
                actionType: "presentation_config_created",
                actor: resolveAuditActor(actorToken),
                changedFields: getChangedFields(
                    undefined,
                    sanitizeForLog(saved),
                ),
                after: sanitizeForLog(saved),
                requestMeta,
            });
        }

        return saved;
    }

    /**
     * Updates an existing presentation configuration.
     */
    async updatePresentationConfig(
        id: string,
        tenantId: string,
        vprequest: PresentationConfigUpdateDto,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
    ) {
        // Verify the config exists
        const existing = await this.getPresentationConfig(id, tenantId);
        const normalizedRequest =
            normalizeRegistrationCertFormFields(vprequest);

        // Merge existing with updates - client must explicitly set fields to null to clear them
        // Omitted fields keep their existing values
        const merged: PresentationConfig = {
            ...existing,
            ...normalizedRequest,
            id,
            tenantId,
        } as PresentationConfig;

        // Return quickly; resolve registration-certificate cache asynchronously.
        const cacheRelevantChanged =
            Object.prototype.hasOwnProperty.call(
                normalizedRequest,
                "registration_cert",
            ) || Object.prototype.hasOwnProperty.call(vprequest, "dcql_query");

        if (!merged.registration_cert) {
            merged.registrationCertCache = null;
        } else if (cacheRelevantChanged) {
            // Mark pending in UI while async refresh runs.
            merged.registrationCertCache = null;
        }

        const saved = await this.repository.save(merged);

        if (saved.registration_cert && cacheRelevantChanged) {
            this.registrationCertificates.scheduleRefresh(saved.id, tenantId);
        }

        if (actorToken) {
            await this.auditLogService.record({
                tenantId,
                actionType: "presentation_config_updated",
                actor: resolveAuditActor(actorToken),
                changedFields: getChangedFields(
                    sanitizeForLog(existing),
                    sanitizeForLog(saved),
                ),
                before: sanitizeForLog(existing),
                after: sanitizeForLog(saved),
                requestMeta,
            });
        }

        return saved;
    }

    /**
     * Deletes a presentation configuration by its ID and tenant ID.
     * @param id - The ID of the presentation configuration to delete.
     * @param tenantId - The ID of the tenant for which to delete the configuration.
     * @returns A promise that resolves when the deletion is complete.
     */
    async deletePresentationConfig(
        id: string,
        tenantId: string,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
    ) {
        const existing = await this.getPresentationConfig(id, tenantId);
        const result = await this.repository.delete({ id, tenantId });

        if (actorToken) {
            await this.auditLogService.record({
                tenantId,
                actionType: "presentation_config_deleted",
                actor: resolveAuditActor(actorToken),
                before: sanitizeForLog(existing),
                requestMeta,
            });
        }

        return result;
    }

    /**
     * Force-reissue the registration certificate for a presentation config,
     * bypassing the cache. Used by the management UI's "Reissue now" action.
     *
     * Throws if the config has no `registrationCert` spec or the registrar is
     * not enabled for this tenant.
     */
    async reissueRegistrationCertificate(
        id: string,
        tenantId: string,
    ): Promise<PresentationConfig> {
        const presentationConfig = await this.getPresentationConfig(
            id,
            tenantId,
        );
        await this.registrationCertificates.reissue(presentationConfig);
        return this.getPresentationConfig(id, tenantId);
    }
}

function sanitizeForLog(config: PresentationConfig): Record<string, unknown> {
    return {
        id: config.id,
        description: config.description,
        lifeTime: config.lifeTime,
        dcql_query: config.dcql_query,
        transaction_data: config.transaction_data,
        skewSeconds: config.skewSeconds,
        registration_cert: config.registration_cert,
        registrationCertCache: config.registrationCertCache,
        attached: config.attached,
        redirectUri: config.redirectUri,
        accessKeyChainId: config.accessKeyChainId,
    };
}
