import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import type { AuditLogRequestMeta } from "../../../audit-log/audit-log.service.js";
import { AuditLogService } from "../../../audit-log/audit-log.service.js";
import {
    getChangedFields,
    resolveAuditActor,
} from "../../../audit-log/audit-log-context.util.js";
import { TokenPayload } from "../../../auth/token.decorator.js";
import { insertNew } from "../../../database/insert-new.js";
import { ConfigImportService } from "../../../platform/config-import/config-import.service.js";
import {
    ConfigImportOrchestratorService,
    ImportPhase,
} from "../../../platform/config-import/config-import-orchestrator.service.js";
import { ResourceIdTaken } from "../../../shared/domain/conflict-error.js";
import { loadJsonFile } from "../../../shared/utils/config-file-loader.util.js";
import { unregisteredTrustAnchorsMessage } from "../../../trust/federation-trust-anchor/domain/federation-trust-anchor-errors.js";
import { FederationTrustAnchorService } from "../../../trust/federation-trust-anchor/federation-trust-anchor.service.js";
import {
    type TransactionDataCredentialQuery,
    type TransactionDataReferences,
    uncheckableTransactionData,
} from "../domain/transaction-data-references.js";
import {
    type CredentialQueryAuthorities,
    federationTrustAnchorIds,
    missingTrustedAuthorities,
} from "../domain/trusted-authority-requirement.js";
import { PresentationConfigCreateDto } from "../dto/presentation-config-create.dto.js";
import { PresentationConfigUpdateDto } from "../dto/presentation-config-update.dto.js";
import { PresentationConfig } from "../entities/presentation-config.entity.js";
import {
    PRESENTATION_SETTINGS,
    type PresentationSettings,
} from "../presentation-settings.js";
import { PresentationRegistrationCertificateService } from "./presentation-registration-certificate.service.js";

function idTaken(id: string): ResourceIdTaken {
    return new ResourceIdTaken("Presentation configuration", id);
}

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
        private readonly federationTrustAnchors: FederationTrustAnchorService,
        @Inject(PRESENTATION_SETTINGS)
        private readonly settings: PresentationSettings,
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
                    // Reject before deleting, so an invalid file does not
                    // remove the stored config.
                    requireCheckableTransactionData(data);
                    await this.requireTrustedAuthorities(tid, data);
                    await this.registrationCertificates.validate({
                        ...data,
                        tenantId: tid,
                    });
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
     * @throws NotFoundException when the tenant has no configuration with this ID
     */
    async getPresentationConfig(
        id: string,
        tenantId: string,
    ): Promise<PresentationConfig> {
        const config = await this.repository.findOneBy({ id, tenantId });
        if (!config) {
            throw new NotFoundException(
                `Presentation config ${JSON.stringify(id)} not found`,
            );
        }
        return config;
    }

    /**
     * Creates a presentation configuration. Refuses an ID the tenant already
     * uses: changes go through {@link updatePresentationConfig}.
     * @throws ResourceIdTaken when the tenant has a configuration with this ID.
     */
    async createPresentationConfig(
        tenantId: string,
        vprequest: PresentationConfigCreateDto,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
    ) {
        // Checked before the trust and certificate checks for a clear answer;
        // the insert decides between concurrent creates.
        if (await this.repository.existsBy({ id: vprequest.id, tenantId })) {
            throw idTaken(vprequest.id);
        }
        return this.persist(
            tenantId,
            vprequest,
            false,
            actorToken,
            requestMeta,
        );
    }

    /**
     * Stores a presentation configuration. If the configuration already
     * exists, it will be overwritten: only configuration imports (config
     * folder, bundles) replace stored configurations, the API creates with
     * {@link createPresentationConfig}.
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
        return this.persist(tenantId, vprequest, true, actorToken, requestMeta);
    }

    /**
     * Checks and stores a configuration: inserted when `replace` is false,
     * replacing a stored one when it is true.
     * @throws ResourceIdTaken when `replace` is false and the ID is taken.
     */
    private async persist(
        tenantId: string,
        vprequest: PresentationConfigCreateDto,
        replace: boolean,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
    ) {
        requireCheckableTransactionData(vprequest);
        await this.requireTrustedAuthorities(tenantId, vprequest);
        const merged = {
            ...vprequest,
            tenantId,
        } as PresentationConfig;
        await this.registrationCertificates.validate(merged);

        const saved = replace
            ? await this.repository.save(merged)
            : await insertNew(
                  this.repository,
                  merged,
                  { id: merged.id, tenantId },
                  () => idTaken(merged.id),
              );

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
        // Merge existing with updates - client must explicitly set fields to null to clear them
        // Omitted fields keep their existing values
        const merged: PresentationConfig = {
            ...existing,
            ...vprequest,
            id,
            tenantId,
        } as PresentationConfig;
        requireCheckableTransactionData(merged);
        await this.requireTrustedAuthorities(tenantId, merged, existing);

        // A stored certificate that has expired since does not block other
        // changes; it is checked when it, the DCQL query or the access key
        // chain changes.
        if (
            Object.hasOwn(vprequest, "registration_cert") ||
            Object.hasOwn(vprequest, "dcql_query") ||
            Object.hasOwn(vprequest, "accessKeyChainId")
        ) {
            await this.registrationCertificates.validate(merged);
        }

        const saved = await this.repository.save(merged);

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
     * Every DCQL credential query needs a trusted authority unless
     * `SKIP_TRUST_AUTHORITY` is set.
     * @throws BadRequestException naming the queries without one.
     */
    private async requireTrustedAuthorities(
        tenantId: string,
        config: {
            dcql_query?: {
                credentials: readonly CredentialQueryAuthorities[];
            };
        },
        /** The stored configuration; its trust anchors are not checked again. */
        existing?: {
            dcql_query?: {
                credentials: readonly CredentialQueryAuthorities[];
            };
        },
    ): Promise<void> {
        const credentials = config.dcql_query?.credentials ?? [];
        const violation = missingTrustedAuthorities(
            credentials,
            this.settings.skipTrustAuthority,
        );
        if (violation) {
            throw new BadRequestException(violation);
        }
        // Only trust anchors this change adds are checked, so a stored
        // configuration whose trust anchors are not registered yet can still
        // be changed otherwise; they are not trusted until registered.
        const stored = new Set(
            federationTrustAnchorIds(existing?.dcql_query?.credentials ?? []),
        );
        const unregistered = await this.federationTrustAnchors.unregistered(
            tenantId,
            federationTrustAnchorIds(credentials).filter(
                (entityId) => !stored.has(entityId),
            ),
        );
        if (unregistered.length > 0) {
            throw new BadRequestException(
                unregisteredTrustAnchorsMessage(unregistered),
            );
        }
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
        attached: config.attached,
        redirectUri: config.redirectUri,
        accessKeyChainId: config.accessKeyChainId,
        allowedOrigins: config.allowedOrigins,
        readerAuth: config.readerAuth,
    };
}

/**
 * Every transaction data entry must reference only `dc+sd-jwt` credential
 * queries of the DCQL query, the only ones EUDIPLO can check (see
 * `uncheckableTransactionData`).
 * @throws BadRequestException naming the entries that break the rule.
 */
function requireCheckableTransactionData(config: {
    transaction_data?: readonly TransactionDataReferences[] | null;
    dcql_query?: { credentials: readonly TransactionDataCredentialQuery[] };
}): void {
    const violation = uncheckableTransactionData(
        config.transaction_data,
        config.dcql_query?.credentials ?? [],
    );
    if (violation) {
        throw new BadRequestException(violation);
    }
}
