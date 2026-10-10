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
import { AttributeProviderService } from "./attribute-provider.service.js";
import { CreateAttributeProviderDto } from "./dto/create-attribute-provider.dto.js";
import { UpdateAttributeProviderDto } from "./dto/update-attribute-provider.dto.js";
import { AttributeProviderEntity } from "./entities/attribute-provider.entity.js";

@ApiTags("Issuer")
@Secured([Role.Issuances])
@Controller("issuer/attribute-providers")
export class AttributeProviderController {
    constructor(private readonly service: AttributeProviderService) {}

    @Get()
    @ApiOperation({ summary: "List all attribute providers" })
    @ApiResponse({
        status: 200,
        description: "List of attribute providers",
        type: [AttributeProviderEntity],
    })
    async getAll(@Token() user: TokenPayload) {
        return (await this.service.getAll(user.entity!.id)).map(redactApiKey);
    }

    @Get(":id")
    @ApiOperation({ summary: "Get an attribute provider by ID" })
    @ApiResponse({
        status: 200,
        description: "The attribute provider",
        type: AttributeProviderEntity,
    })
    @ApiResponse({ status: 404, description: "Attribute provider not found" })
    async getById(@Param("id") id: string, @Token() user: TokenPayload) {
        return redactApiKey(await this.service.getById(user.entity!.id, id));
    }

    @Post()
    @ApiOperation({ summary: "Create a new attribute provider" })
    @ApiResponse({
        status: 201,
        description: "Attribute provider created",
        type: AttributeProviderEntity,
    })
    @ApiBody({ type: CreateAttributeProviderDto })
    async create(
        @Body() dto: CreateAttributeProviderDto,
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
    @ApiOperation({ summary: "Update an attribute provider" })
    @ApiResponse({
        status: 200,
        description: "Attribute provider updated",
        type: AttributeProviderEntity,
    })
    @ApiResponse({ status: 404, description: "Attribute provider not found" })
    @ApiBody({ type: UpdateAttributeProviderDto })
    async update(
        @Param("id") id: string,
        @Body() dto: UpdateAttributeProviderDto,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        const stored = await this.service.getById(user.entity!.id, id);
        return redactApiKey(
            await this.service.update(
                user.entity!.id,
                id,
                restoreApiKey(dto, stored),
                user,
                requestMeta,
            ),
        );
    }

    @Delete(":id")
    @ApiOperation({ summary: "Delete an attribute provider" })
    @ApiResponse({ status: 204, description: "Attribute provider deleted" })
    @ApiResponse({ status: 404, description: "Attribute provider not found" })
    @HttpCode(204)
    delete(
        @Param("id") id: string,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        return this.service.delete(user.entity!.id, id, user, requestMeta);
    }
}
