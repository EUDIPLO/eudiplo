import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AuditLogRequestMeta } from "../../../audit-log/audit-log.service.js";
import { AuditLogService } from "../../../audit-log/audit-log.service.js";
import {
    getChangedFields,
    getChangedFieldsForKeys,
    resolveAuditActor,
} from "../../../audit-log/audit-log-context.util.js";
import { TokenPayload } from "../../../auth/token.decorator.js";
import { ConfigImportService } from "../../../platform/config-import/config-import.service.js";
import {
    ConfigImportOrchestratorService,
    ImportPhase,
} from "../../../platform/config-import/config-import-orchestrator.service.js";
import { loadConfigDto } from "../../../shared/utils/config-file-loader.util.js";
import { redactWebhookAuth } from "../../../webhook/domain/webhook-configuration.js";
import { OutboundUrlPolicyService } from "../../../webhook/outbound-url-policy.service.js";
import type { AttributeProviderData } from "./domain/attribute-provider-data.js";
import { CreateAttributeProviderDto } from "./dto/create-attribute-provider.dto.js";
import {
    ATTRIBUTE_PROVIDER_REPOSITORY,
    type AttributeProviderRepository,
} from "./ports/attribute-provider.repository.js";
import type {
    CreateAttributeProvider,
    UpdateAttributeProvider,
} from "./schemas/attribute-provider.schema.js";

@Injectable()
export class AttributeProviderService {
    constructor(
        @Inject(ATTRIBUTE_PROVIDER_REPOSITORY)
        private readonly repo: AttributeProviderRepository,
        private readonly configImportService: ConfigImportService,
        private readonly configImportOrchestrator: ConfigImportOrchestratorService,
        private readonly tenantActionLogService: AuditLogService,
        private readonly outboundUrlPolicyService: OutboundUrlPolicyService,
    ) {
        this.configImportOrchestrator.register(
            "attribute-providers",
            ImportPhase.CORE,
            (tenantId) => this.importForTenant(tenantId),
        );
    }

    private async importForTenant(tenantId: string) {
        await this.configImportService.importConfigsForTenant<CreateAttributeProviderDto>(
            tenantId,
            {
                subfolder: "attribute-providers",
                fileExtension: ".json",
                validationSchema: CreateAttributeProviderDto,
                resourceType: "attribute provider",
                checkExists: (tid, data) =>
                    this.getById(tid, data.id)
                        .then(() => true)
                        .catch(() => false),
                deleteExisting: (tid, data) =>
                    this.repo
                        .deleteForTenant(tid, data.id)
                        .then(() => undefined),
                loadData: (filePath) =>
                    loadConfigDto(filePath, CreateAttributeProviderDto),
                processItem: async (tid, dto) => {
                    await this.create(tid, dto);
                },
            },
        );
    }

    getAll(tenantId: string) {
        return this.repo.listForTenant(tenantId);
    }

    async getById(tenantId: string, id: string) {
        const entity = await this.repo.findForTenant(tenantId, id);
        if (!entity) {
            throw new NotFoundException(`Attribute provider '${id}' not found`);
        }
        return entity;
    }

    async create(
        tenantId: string,
        dto: CreateAttributeProvider,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
    ) {
        await this.outboundUrlPolicyService.assertSafeUrl(dto.url);

        const saved = await this.repo.save({
            ...dto,
            tenantId,
        });

        if (actorToken) {
            await this.tenantActionLogService.record({
                tenantId,
                actionType: "attribute_provider_created",
                actor: resolveAuditActor(actorToken),
                changedFields: getChangedFields(
                    undefined,
                    this.sanitizeAttributeProviderForLog(saved),
                ),
                after: this.sanitizeAttributeProviderForLog(saved),
                requestMeta,
            });
        }

        return saved;
    }

    async update(
        tenantId: string,
        id: string,
        dto: UpdateAttributeProvider,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
    ) {
        const existing = await this.getById(tenantId, id);

        if (dto.url) {
            await this.outboundUrlPolicyService.assertSafeUrl(dto.url);
        }

        const saved = await this.repo.save({
            ...existing,
            ...dto,
            id,
            tenantId,
        });

        if (actorToken) {
            await this.tenantActionLogService.record({
                tenantId,
                actionType: "attribute_provider_updated",
                actor: resolveAuditActor(actorToken),
                // Compared before redaction, so a new API key is listed.
                changedFields: getChangedFieldsForKeys(existing, saved, [
                    "id",
                    "name",
                    "url",
                    "description",
                    "auth",
                ]),
                before: this.sanitizeAttributeProviderForLog(existing),
                after: this.sanitizeAttributeProviderForLog(saved),
                requestMeta,
            });
        }

        return saved;
    }

    async delete(
        tenantId: string,
        id: string,
        actorToken?: TokenPayload,
        requestMeta?: AuditLogRequestMeta,
    ) {
        const existing = await this.getById(tenantId, id);
        const result = await this.repo.deleteForTenant(tenantId, id);

        if (actorToken) {
            await this.tenantActionLogService.record({
                tenantId,
                actionType: "attribute_provider_deleted",
                actor: resolveAuditActor(actorToken),
                before: this.sanitizeAttributeProviderForLog(existing),
                requestMeta,
            });
        }

        return result;
    }

    private sanitizeAttributeProviderForLog(
        provider: AttributeProviderData,
    ): Record<string, unknown> {
        return {
            id: provider.id,
            name: provider.name,
            description: provider.description,
            url: provider.url,
            auth: redactWebhookAuth(provider.auth),
        };
    }
}
