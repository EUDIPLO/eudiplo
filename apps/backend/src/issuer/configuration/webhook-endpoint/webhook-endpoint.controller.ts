import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    Req,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { Role } from "../../../auth/roles/role.enum.js";
import { Secured } from "../../../auth/secure.decorator.js";
import { Token, TokenPayload } from "../../../auth/token.decorator.js";
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
    getAll(@Token() user: TokenPayload): Promise<WebhookEndpointData[]> {
        return this.service.getAll(user.entity!.id);
    }

    @Get(":id")
    @ApiOperation({ summary: "Get a webhook endpoint by ID" })
    @ApiResponse({
        status: 200,
        description: "The webhook endpoint",
        type: WebhookEndpointEntity,
    })
    @ApiResponse({ status: 404, description: "Webhook endpoint not found" })
    getById(@Param("id") id: string, @Token() user: TokenPayload) {
        return this.service.getById(user.entity!.id, id);
    }

    @Post()
    @ApiOperation({ summary: "Create a new webhook endpoint" })
    @ApiResponse({
        status: 201,
        description: "Webhook endpoint created",
        type: WebhookEndpointEntity,
    })
    @ApiBody({ type: CreateWebhookEndpointDto })
    create(
        @Body() dto: CreateWebhookEndpointDto,
        @Token() user: TokenPayload,
        @Req() req: Request,
    ) {
        return this.service.create(user.entity!.id, dto, user, req);
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
    update(
        @Param("id") id: string,
        @Body() dto: UpdateWebhookEndpointDto,
        @Token() user: TokenPayload,
        @Req() req: Request,
    ) {
        return this.service.update(user.entity!.id, id, dto, user, req);
    }

    @Delete(":id")
    @ApiOperation({ summary: "Delete a webhook endpoint" })
    @ApiResponse({ status: 204, description: "Webhook endpoint deleted" })
    @ApiResponse({ status: 404, description: "Webhook endpoint not found" })
    @HttpCode(204)
    delete(
        @Param("id") id: string,
        @Token() user: TokenPayload,
        @Req() req: Request,
    ) {
        return this.service.delete(user.entity!.id, id, user, req);
    }
}
