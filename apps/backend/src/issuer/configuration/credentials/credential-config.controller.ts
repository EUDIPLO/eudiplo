import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    Query,
} from "@nestjs/common";
import {
    ApiBody,
    ApiOperation,
    ApiQuery,
    ApiResponse,
    ApiTags,
} from "@nestjs/swagger";
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
    @ApiResponse({
        status: 409,
        description:
            "The tenant already has a credential configuration with this ID. Change it with PATCH.",
    })
    storeCredentialConfiguration(
        @Body(createConfigBodyPipe(CredentialConfigCreateSchema, { readOnly }))
        config: CredentialConfigCreate,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        return this.credentialsService.create(
            user.entity!.id,
            config,
            user,
            requestMeta,
        );
    }

    @Patch(":id")
    @ApiOperation({
        summary: "Update a credential configuration",
        description:
            "Updates the fields given in the body; set a field to null to clear it. With `revokeOnDisclosurePolicyChange=true`, an update that adds, changes or deletes `embeddedDisclosurePolicy` first revokes every credential issued under this configuration that has a status list entry, as `POST /session/revoke` would (ARF Annex 2, EDP_11). Credentials without a status entry cannot be revoked. Revocation is final. When revoking fails, the policy is not changed and repeating the request continues the revocation.",
    })
    @ApiQuery({
        name: "revokeOnDisclosurePolicyChange",
        required: false,
        type: Boolean,
        description:
            "Revoke the credentials issued under this configuration when the update adds, changes or deletes its embedded disclosure policy. Not stored. Default false: the update revokes nothing.",
    })
    @ApiBody({ type: CredentialConfigUpdate })
    @ApiResponse({ status: 200, type: CredentialConfig })
    @ApiResponse({
        status: 400,
        description:
            "The body is invalid, or revokeOnDisclosurePolicyChange is neither true nor false",
    })
    @ApiResponse({
        status: 403,
        description:
            "revokeOnDisclosurePolicyChange=true from a client limited to other credential configurations (allowedIssuanceConfigs)",
    })
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
        @Query("revokeOnDisclosurePolicyChange")
        revokeOnDisclosurePolicyChange?: string,
    ) {
        return this.credentialsService.update(
            user.entity!.id,
            id,
            config,
            user,
            requestMeta,
            {
                revokeOnDisclosurePolicyChange: parseBooleanQuery(
                    "revokeOnDisclosurePolicyChange",
                    revokeOnDisclosurePolicyChange,
                ),
                allowedCredentialConfigurationIds:
                    user.client?.allowedIssuanceConfigs,
            },
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

/**
 * `true` or `false` from a query parameter; absent is `false`. Anything else
 * is refused, so that a typo never silently skips what the caller asked for.
 */
function parseBooleanQuery(name: string, value?: string): boolean {
    if (value === undefined || value === "false") return false;
    if (value === "true") return true;
    throw new BadRequestException(`${name} must be true or false`);
}
