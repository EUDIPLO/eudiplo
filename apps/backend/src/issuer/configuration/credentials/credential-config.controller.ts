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
import { createConfigBodyPipe } from "../../../shared/common/zod/zod-schema.util.js";
import { CredentialConfigService } from "./credential-config/credential-config.service.js";
import { CredentialConfigCreate } from "./dto/credential-config-create.dto.js";
import { CredentialConfigUpdate } from "./dto/credential-config-update.dto.js";
import { CredentialConfig } from "./entities/credential.entity.js";
import { CredentialConfigCreateSchema } from "./schemas/credential-config.schema.js";

/** Fields a GET response adds to the configuration (tenant and relations). */
const readOnly = [
    "tenantId",
    "tenant",
    "attributeProvider",
    "webhookEndpoint",
    "keyChain",
];

/**
 * Controller for managing credential configurations.
 */
@ApiTags("Issuer")
@Secured([Role.Issuances])
@Controller("issuer/credentials")
export class CredentialConfigController {
    constructor(private readonly credentialsService: CredentialConfigService) {}

    @Get()
    @ApiOperation({ summary: "List credential configurations" })
    @ApiResponse({ status: 200, type: [CredentialConfig] })
    getConfigs(@Token() user: TokenPayload) {
        return this.credentialsService.get(user.entity!.id);
    }

    @Get(":id")
    @ApiOperation({ summary: "Get a credential configuration by ID" })
    @ApiResponse({ status: 200, type: CredentialConfig })
    getConfigById(@Param("id") id: string, @Token() user: TokenPayload) {
        return this.credentialsService.getById(user.entity!.id, id);
    }

    @Post()
    @ApiOperation({ summary: "Create a credential configuration" })
    @ApiBody({ type: CredentialConfigCreate })
    @ApiResponse({ status: 201, type: CredentialConfig })
    storeCredentialConfiguration(
        @Body(createConfigBodyPipe(CredentialConfigCreateSchema, { readOnly }))
        config: CredentialConfigCreate,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        return this.credentialsService.store(
            user.entity!.id,
            config,
            false,
            user,
            requestMeta,
        );
    }

    @Patch(":id")
    @ApiOperation({ summary: "Update a credential configuration" })
    @ApiBody({ type: CredentialConfigUpdate })
    @ApiResponse({ status: 200, type: CredentialConfig })
    updateCredentialConfiguration(
        @Param("id") id: string,
        @Body(
            createConfigBodyPipe(CredentialConfigCreateSchema, {
                readOnly,
                partial: true,
            }),
        )
        config: CredentialConfigUpdate,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        return this.credentialsService.update(
            user.entity!.id,
            id,
            config,
            user,
            requestMeta,
        );
    }

    @Delete(":id")
    @ApiOperation({ summary: "Delete a credential configuration" })
    @ApiResponse({
        status: 204,
        description: "Credential configuration deleted",
    })
    @HttpCode(204)
    deleteIssuanceConfiguration(
        @Param("id") id: string,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ): Promise<unknown> {
        return this.credentialsService.delete(
            user.entity!.id,
            id,
            user,
            requestMeta,
        );
    }
}
