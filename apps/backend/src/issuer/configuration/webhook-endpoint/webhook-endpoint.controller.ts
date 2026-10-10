import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { AuditLogRequestMeta } from "../../../audit-log/audit-log.service.js";
import { AuditMeta } from "../../../audit-log/audit-log-context.util.js";
import { Role } from "../../../auth/roles/role.enum.js";
import { Secured } from "../../../auth/secure.decorator.js";
import { Token, TokenPayload } from "../../../auth/token.decorator.js";
import {
    redactApiKey,
    restoreApiKey,
} from "../../../shared/utils/write-only-secrets.util.js";
import type { WebhookEndpointData } from "./domain/webhook-endpoint-data.js";
import { CreateWebhookEndpointDto } from "./dto/create-webhook-endpoint.dto.js";
import { UpdateWebhookEndpointDto } from "./dto/update-webhook-endpoint.dto.js";
import { WebhookEndpointEntity } from "./entities/webhook-endpoint.entity.js";
import { WebhookEndpointService } from "./webhook-endpoint.service.js";

// Webhook endpoints are referenced from both sides: issuance configs and,
// since 7.0 replaced the inline `webhook` payload with `webhookEndpointId`,
// presentation configs too. Gating them on issuance alone meant a
// verification-only tenant could not register the webhook its own presentation
// config needs. RolesGuard is OR, so either role grants access.
@ApiTags("Issuer")
@Secured([Role.Issuances, Role.Presentations])
@Controller("issuer/webhook-endpoints")
export class WebhookEndpointController {
    constructor(private readonly service: WebhookEndpointService) {}

    /**
     * List all webhook endpoints for the tenant.
     * @param user
     * @returns
     */
    @Get()
    @ApiResponse({
        status: 200,
        description: "List of webhook endpoints",
        type: [WebhookEndpointEntity],
    })
    async getAll(@Token() user: TokenPayload): Promise<WebhookEndpointData[]> {
        return (await this.service.getAll(user.entity!.id)).map(redactApiKey);
    }

    @Get(":id")
    @ApiOperation({ summary: "Get a webhook endpoint by ID" })
    @ApiResponse({
        status: 200,
        description: "The webhook endpoint",
        type: WebhookEndpointEntity,
    })
    @ApiResponse({ status: 404, description: "Webhook endpoint not found" })
    async getById(@Param("id") id: string, @Token() user: TokenPayload) {
        return redactApiKey(await this.service.getById(user.entity!.id, id));
    }

    @Post()
    @ApiOperation({ summary: "Create a new webhook endpoint" })
    @ApiResponse({
        status: 201,
        description: "Webhook endpoint created",
        type: WebhookEndpointEntity,
    })
    @ApiBody({ type: CreateWebhookEndpointDto })
    async create(
        @Body() dto: CreateWebhookEndpointDto,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        return redactApiKey(
            await this.service.create(
                user.entity!.id,
                restoreApiKey(dto),
                user,
                requestMeta,
            ),
        );
    }

    @Patch(":id")
    @ApiOperation({ summary: "Update a webhook endpoint" })
    @ApiResponse({
        status: 200,
        description: "Webhook endpoint updated",
        type: WebhookEndpointEntity,
    })
    @ApiResponse({ status: 404, description: "Webhook endpoint not found" })
    @ApiBody({ type: UpdateWebhookEndpointDto })
    async update(
        @Param("id") id: string,
        @Body() dto: UpdateWebhookEndpointDto,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        const endpoint = await this.service.getById(user.entity!.id, id);
        const endpointUpdate = restoreApiKey(dto, endpoint);
        return redactApiKey(
            await this.service.update(
                user.entity!.id,
                id,
                endpointUpdate,
                user,
                requestMeta,
            ),
        );
    }

    @Delete(":id")
    @ApiOperation({ summary: "Delete a webhook endpoint" })
    @ApiResponse({ status: 204, description: "Webhook endpoint deleted" })
    @ApiResponse({ status: 404, description: "Webhook endpoint not found" })
    @HttpCode(204)
    delete(
        @Param("id") id: string,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        return this.service.delete(user.entity!.id, id, user, requestMeta);
    }
}
