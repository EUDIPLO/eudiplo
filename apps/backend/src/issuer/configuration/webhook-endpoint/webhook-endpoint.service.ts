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
import type { WebhookEndpointData } from "./domain/webhook-endpoint-data.js";
import { CreateWebhookEndpointDto } from "./dto/create-webhook-endpoint.dto.js";
import {
    WEBHOOK_ENDPOINT_REPOSITORY,
    type WebhookEndpointRepository,
} from "./ports/webhook-endpoint.repository.js";
import type {
    CreateWebhookEndpoint,
    UpdateWebhookEndpoint,
} from "./schemas/webhook-endpoint.schema.js";

@Injectable()
export class WebhookEndpointService {
    constructor(
        @Inject(WEBHOOK_ENDPOINT_REPOSITORY)
        private readonly repo: WebhookEndpointRepository,
        private readonly configImportService: ConfigImportService,
        private readonly configImportOrchestrator: ConfigImportOrchestratorService,
        private readonly tenantActionLogService: AuditLogService,
        private readonly outboundUrlPolicyService: OutboundUrlPolicyService,
    ) {
        this.configImportOrchestrator.register(
            "webhook-endpoints",
            ImportPhase.CORE,
            (tenantId) => this.importForTenant(tenantId),
        );
    }

    private async importForTenant(tenantId: string) {
        await this.configImportService.importConfigsForTenant<CreateWebhookEndpointDto>(
            tenantId,
            {
                subfolder: "webhook-endpoints",
                fileExtension: ".json",
                validationSchema: CreateWebhookEndpointDto,
                resourceType: "webhook endpoint",
                checkExists: (tid, data) =>
                    this.getById(tid, data.id)
                        .then(() => true)
                        .catch(() => false),
                deleteExisting: (tid, data) =>
                    this.repo
                        .deleteForTenant(tid, data.id)
                        .then(() => undefined),
                loadData: (filePath) =>
                    loadConfigDto(filePath, CreateWebhookEndpointDto),
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
            throw new NotFoundException(`Webhook endpoint '${id}' not found`);
        }
        return entity;
    }

    async create(
        tenantId: string,
        dto: CreateWebhookEndpoint,
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
                actionType: "webhook_endpoint_created",
                actor: resolveAuditActor(actorToken),
                changedFields: getChangedFields(
                    undefined,
                    this.sanitizeWebhookEndpointForLog(saved),
                ),
                after: this.sanitizeWebhookEndpointForLog(saved),
                requestMeta,
            });
        }

        return saved;
    }

    async update(
        tenantId: string,
        id: string,
        dto: UpdateWebhookEndpoint,
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
                actionType: "webhook_endpoint_updated",
                actor: resolveAuditActor(actorToken),
                // Compared before redaction, so a new API key is listed.
                changedFields: getChangedFieldsForKeys(existing, saved, [
                    "id",
                    "name",
                    "url",
                    "description",
                    "auth",
                ]),
                before: this.sanitizeWebhookEndpointForLog(existing),
                after: this.sanitizeWebhookEndpointForLog(saved),
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
                actionType: "webhook_endpoint_deleted",
                actor: resolveAuditActor(actorToken),
                before: this.sanitizeWebhookEndpointForLog(existing),
                requestMeta,
            });
        }

        return result;
    }

    private sanitizeWebhookEndpointForLog(
        endpoint: WebhookEndpointData,
    ): Record<string, unknown> {
        return {
            id: endpoint.id,
            name: endpoint.name,
            url: endpoint.url,
            description: endpoint.description,
            auth: redactWebhookAuth(endpoint.auth),
        };
    }
}
