import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Delete,
    Get,
    HttpCode,
    Inject,
    NotFoundException,
    Param,
    Patch,
    Post,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { AuditLogRequestMeta } from "../../audit-log/audit-log.service.js";
import { AuditMeta } from "../../audit-log/audit-log-context.util.js";
import { Role } from "../../auth/roles/role.enum.js";
import { Secured } from "../../auth/secure.decorator.js";
import { Token, type TokenPayload } from "../../auth/token.decorator.js";
import { ConflictError } from "../../shared/domain/conflict-error.js";
import { NotFoundError } from "../../shared/domain/not-found-error.js";
import {
    CreateOidcClientDto,
    UpdateOidcClientDto,
    UpdateOidcClientSecretDto,
} from "./dto/oidc-client-request.dto.js";
import {
    CreatedOidcClientResponseDto,
    CreatedOidcClientSecretResponseDto,
    OidcClientResponseDto,
    OidcClientSecretDto,
    toClientDto,
    toSecretDto,
} from "./dto/oidc-client-response.dto.js";
import { InvalidOidcClient, OidcClientService } from "./oidc-client.service.js";
import {
    OIDC_PROVIDER_SETTINGS,
    type OidcProviderSettings,
    oidcIssuer,
} from "./oidc-provider-settings.js";

/**
 * OpenID Connect clients: relying parties that sign users in with a
 * presentation from their wallet through the tenant's OpenID Provider.
 */
@ApiTags("Verifier")
@Secured([Role.Presentations])
@Controller("verifier/oidc-clients")
export class OidcClientController {
    constructor(
        private readonly service: OidcClientService,
        @Inject(OIDC_PROVIDER_SETTINGS)
        private readonly settings: OidcProviderSettings,
    ) {}

    @Secured([Role.PresentationRead])
    @Get()
    @ApiOperation({ summary: "List the tenant's OpenID Connect clients" })
    @ApiResponse({ status: 200, type: [OidcClientResponseDto] })
    async list(@Token() user: TokenPayload): Promise<OidcClientResponseDto[]> {
        const tenantId = user.entity!.id;
        const clients = await this.service.list(tenantId);
        return clients.map((client) =>
            toClientDto(client, this.issuer(tenantId)),
        );
    }

    @Secured([Role.PresentationRead])
    @Get(":id")
    @ApiOperation({ summary: "Get an OpenID Connect client" })
    @ApiResponse({ status: 200, type: OidcClientResponseDto })
    @ApiResponse({ status: 404, description: "Client not found" })
    async get(
        @Param("id") id: string,
        @Token() user: TokenPayload,
    ): Promise<OidcClientResponseDto> {
        const tenantId = user.entity!.id;
        return toClientDto(
            await mapErrors(this.service.get(tenantId, id)),
            this.issuer(tenantId),
        );
    }

    @Post()
    @ApiOperation({
        summary: "Create an OpenID Connect client",
        description:
            "The response carries the client secret. It is returned only once and stored as a hash.",
    })
    @ApiBody({ type: CreateOidcClientDto })
    @ApiResponse({ status: 201, type: CreatedOidcClientResponseDto })
    @ApiResponse({
        status: 400,
        description:
            "A redirect URI or scope is invalid, or a presentation config is missing or defines transaction data",
    })
    async create(
        @Body() body: CreateOidcClientDto,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ): Promise<CreatedOidcClientResponseDto> {
        const tenantId = user.entity!.id;
        const { client, clientSecret } = await mapErrors(
            this.service.create(tenantId, body, { token: user, requestMeta }),
        );
        return {
            ...toClientDto(client, this.issuer(tenantId)),
            clientSecret,
        };
    }

    @Patch(":id")
    @ApiOperation({ summary: "Change an OpenID Connect client" })
    @ApiBody({ type: UpdateOidcClientDto })
    @ApiResponse({ status: 200, type: OidcClientResponseDto })
    @ApiResponse({ status: 404, description: "Client not found" })
    async update(
        @Param("id") id: string,
        @Body() body: UpdateOidcClientDto,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ): Promise<OidcClientResponseDto> {
        const tenantId = user.entity!.id;
        return toClientDto(
            await mapErrors(
                this.service.update(tenantId, id, body, {
                    token: user,
                    requestMeta,
                }),
            ),
            this.issuer(tenantId),
        );
    }

    @Delete(":id")
    @HttpCode(204)
    @ApiOperation({ summary: "Delete an OpenID Connect client" })
    @ApiResponse({ status: 204, description: "Client deleted" })
    @ApiResponse({ status: 404, description: "Client not found" })
    async delete(
        @Param("id") id: string,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ): Promise<void> {
        await mapErrors(
            this.service.delete(user.entity!.id, id, {
                token: user,
                requestMeta,
            }),
        );
    }

    @Post(":id/secrets")
    @ApiOperation({
        summary: "Add a client secret",
        description:
            "A client holds at most two secrets and accepts either, so the secret can be rotated without failed sign-ins. The value is returned only once.",
    })
    @ApiResponse({ status: 201, type: CreatedOidcClientSecretResponseDto })
    @ApiResponse({ status: 409, description: "The client has two secrets" })
    async addSecret(
        @Param("id") id: string,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ): Promise<CreatedOidcClientSecretResponseDto> {
        const { secret, clientSecret } = await mapErrors(
            this.service.addSecret(user.entity!.id, id, {
                token: user,
                requestMeta,
            }),
        );
        return { ...toSecretDto(secret), clientSecret };
    }

    @Patch(":id/secrets/:secretId")
    @ApiOperation({
        summary: "Change when a client secret expires",
    })
    @ApiBody({ type: UpdateOidcClientSecretDto })
    @ApiResponse({ status: 200, type: OidcClientSecretDto })
    @ApiResponse({ status: 404, description: "Client or secret not found" })
    async updateSecret(
        @Param("id") id: string,
        @Param("secretId") secretId: string,
        @Body() body: UpdateOidcClientSecretDto,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ): Promise<OidcClientSecretDto> {
        return toSecretDto(
            await mapErrors(
                this.service.updateSecret(user.entity!.id, id, secretId, body, {
                    token: user,
                    requestMeta,
                }),
            ),
        );
    }

    @Delete(":id/secrets/:secretId")
    @HttpCode(204)
    @ApiOperation({ summary: "Delete a client secret" })
    @ApiResponse({ status: 204, description: "Secret deleted" })
    @ApiResponse({ status: 404, description: "Client or secret not found" })
    @ApiResponse({
        status: 409,
        description: "The client's last secret cannot be deleted",
    })
    async deleteSecret(
        @Param("id") id: string,
        @Param("secretId") secretId: string,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ): Promise<void> {
        await mapErrors(
            this.service.deleteSecret(user.entity!.id, id, secretId, {
                token: user,
                requestMeta,
            }),
        );
    }

    private issuer(tenantId: string): string {
        return oidcIssuer(this.settings.publicUrl, tenantId);
    }
}

/**
 * Service errors as HTTP errors: a refused change answers 400, a missing
 * client or secret 404 and a conflict with the client's secrets 409.
 */
async function mapErrors<T>(operation: Promise<T>): Promise<T> {
    try {
        return await operation;
    } catch (error) {
        if (error instanceof InvalidOidcClient) {
            throw new BadRequestException(error.message);
        }
        if (error instanceof NotFoundError) {
            throw new NotFoundException(error.message);
        }
        if (error instanceof ConflictError) {
            throw new ConflictException(error.message);
        }
        throw error;
    }
}
