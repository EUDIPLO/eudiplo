import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Post,
    Put,
    Query,
} from "@nestjs/common";
import {
    ApiBody,
    ApiOperation,
    ApiQuery,
    ApiResponse,
    ApiTags,
} from "@nestjs/swagger";
import { Role } from "../../auth/roles/role.enum.js";
import { Secured } from "../../auth/secure.decorator.js";
import { requireTenantContext } from "../../auth/tenant-context.util.js";
import { Token, TokenPayload } from "../../auth/token.decorator.js";
import { KeyChainCreateDto } from "./dto/key-chain-create.dto.js";
import { KeyChainExportDto } from "./dto/key-chain-export.dto.js";
import { KeyChainIdResponseDto } from "./dto/key-chain-id-response.dto.js";
import { KeyChainImportDto } from "./dto/key-chain-import.dto.js";
import { KeyChainResponseDto } from "./dto/key-chain-response.dto.js";
import { KeyChainUpdateDto } from "./dto/key-chain-update.dto.js";
import { KmsConfigDto } from "./dto/kms-config.dto.js";
import { KmsProvidersResponseDto } from "./dto/kms-providers-response.dto.js";
import { KmsTenantConfigResponseDto } from "./dto/kms-tenant-config-response.dto.js";
import { ProviderHealthResponseDto } from "./dto/provider-health-response.dto.js";
import { KeyChainService } from "./key-chain.service.js";
import { KmsTenantConfigService } from "./kms/kms-tenant-config.service.js";
import { KeyUsageType } from "./types/key-usage-type.js";

const TENANT_ADMIN_REQUIRED =
    "The caller lacks the `tenant:admin` or `tenants:manage` role or a tenant context.";

/**
 * KeyChainController manages unified key chains.
 *
 * A key chain encapsulates:
 * - An optional root CA key (for internal certificate chains)
 * - An active signing key with its certificate
 * - Rotation policy and previous keys (for grace period)
 */
@ApiTags("Key Chain")
@Secured([Role.Issuances, Role.Presentations])
@Controller("key-chain")
export class KeyChainController {
    constructor(
        private readonly keyChainService: KeyChainService,
        private readonly kmsTenantConfigService: KmsTenantConfigService,
    ) {}

    /**
     * Get available KMS providers and their capabilities.
     */
    @Get("providers")
    @ApiOperation({ summary: "Get available KMS providers" })
    @ApiResponse({
        status: 200,
        description: "List of available KMS providers with capabilities",
        type: KmsProvidersResponseDto,
    })
    getProviders(@Token() token: TokenPayload): KmsProvidersResponseDto {
        return this.keyChainService.getProviders(token.entity!.id);
    }

    /**
     * Liveness/readiness probe for every registered KMS provider.
     */
    @Get("providers/health")
    @ApiOperation({ summary: "Health probe for every KMS provider" })
    @ApiResponse({
        status: 200,
        description:
            "Per-provider health result (ok, latencyMs, optional error).",
        type: [ProviderHealthResponseDto],
    })
    getProvidersHealth(
        @Token() token: TokenPayload,
    ): Promise<ProviderHealthResponseDto[]> {
        return this.keyChainService.getProviderHealth(token.entity!.id);
    }

    /**
     * The KMS provider configuration contains provider credentials, so it
     * requires the same roles as the configuration export.
     */
    @Get("providers/config")
    @Secured([Role.Tenants, Role.TenantAdmin])
    @ApiOperation({
        summary: "Get tenant KMS provider configuration",
        description:
            "Returns tenant-specific KMS config (if present) and the effective merged runtime config. Credentials are returned as `<redacted>`; `${ENV_VAR}` placeholders of the tenant file are returned as stored. Requires the `tenant:admin` or `tenants:manage` role.",
    })
    @ApiResponse({
        status: 200,
        description: "Tenant and effective KMS configuration.",
        type: KmsTenantConfigResponseDto,
    })
    @ApiResponse({ status: 403, description: TENANT_ADMIN_REQUIRED })
    getTenantKmsConfig(
        @Token() token: TokenPayload,
    ): KmsTenantConfigResponseDto {
        const tenantId = requireTenantContext(token);
        return {
            tenantConfig:
                this.kmsTenantConfigService.getTenantConfigView(tenantId),
            effectiveConfig:
                this.kmsTenantConfigService.getEffectiveConfigView(tenantId),
        };
    }

    @Put("providers/config")
    @Secured([Role.Tenants, Role.TenantAdmin])
    @ApiOperation({
        summary: "Create or replace tenant KMS provider configuration",
        description:
            "A credential sent as `<redacted>` keeps the stored value of the provider with the same `id` and `type`; send a new value or a `${ENV_VAR}` placeholder to replace it. `<redacted>` for a credential that is not stored is rejected with 400. The response is redacted like GET. Requires the `tenant:admin` or `tenants:manage` role.",
    })
    @ApiBody({ type: KmsConfigDto })
    @ApiResponse({
        status: 200,
        description: "Updated tenant KMS config.",
        type: KmsTenantConfigResponseDto,
    })
    @ApiResponse({ status: 403, description: TENANT_ADMIN_REQUIRED })
    updateTenantKmsConfig(
        @Token() token: TokenPayload,
        @Body() body: KmsConfigDto,
    ): KmsTenantConfigResponseDto {
        const tenantId = requireTenantContext(token);
        this.kmsTenantConfigService.updateTenantConfig(tenantId, body);

        return {
            tenantConfig:
                this.kmsTenantConfigService.getTenantConfigView(tenantId),
            effectiveConfig:
                this.kmsTenantConfigService.getEffectiveConfigView(tenantId),
        };
    }

    @Delete("providers/config")
    @Secured([Role.Tenants, Role.TenantAdmin])
    @ApiOperation({
        summary: "Delete tenant KMS provider configuration",
        description:
            "Removes <CONFIG_FOLDER>/<tenantId>/kms.json and falls back to global KMS config. Requires the `tenant:admin` or `tenants:manage` role.",
    })
    @ApiResponse({
        status: 204,
        description: "Tenant-specific KMS config removed.",
    })
    @ApiResponse({ status: 403, description: TENANT_ADMIN_REQUIRED })
    @HttpCode(204)
    deleteTenantKmsConfig(@Token() token: TokenPayload): void {
        this.kmsTenantConfigService.deleteTenantConfig(
            requireTenantContext(token),
        );
    }

    /**
     * List user-manageable signing key chains for the tenant.
     */
    @Get()
    @ApiOperation({
        summary: "List user-manageable signing key chains for the tenant",
    })
    @ApiResponse({
        status: 200,
        description: "List of key chains",
        type: [KeyChainResponseDto],
    })
    @ApiQuery({
        name: "usageType",
        required: false,
        enum: KeyUsageType,
        description: "Optional usage type filter",
    })
    getAll(
        @Token() token: TokenPayload,
        @Query("usageType") usageType?: KeyUsageType,
    ): Promise<KeyChainResponseDto[]> {
        return this.keyChainService.getAll(token.entity!.id, usageType);
    }

    /**
     * Get a specific key chain by ID.
     */
    @Get(":id")
    @ApiOperation({ summary: "Get a key chain by ID" })
    @ApiResponse({
        status: 200,
        description: "The key chain",
        type: KeyChainResponseDto,
    })
    @ApiResponse({ status: 404, description: "Key chain not found" })
    getById(
        @Token() token: TokenPayload,
        @Param("id") id: string,
    ): Promise<KeyChainResponseDto> {
        return this.keyChainService.getById(token.entity!.id, id);
    }

    /**
     * Export a key chain in config-import-compatible format.
     * The response includes private key material and can be saved as a JSON file
     * for provisioning via the config import mechanism. Because of that it
     * requires the same roles as the configuration export instead of the
     * key chain management roles.
     */
    @Get(":id/export")
    @Secured([Role.Tenants, Role.TenantAdmin])
    @ApiOperation({
        summary: "Export a key chain in config-import format",
        description:
            "Returns the key chain in the same format used by config import JSON files. For keys held in the database (`db` provider) the response includes the private key; for external KMS providers only the public key is returned because the private key never leaves the KMS. Requires the `tenant:admin` or `tenants:manage` role.",
    })
    @ApiResponse({
        status: 200,
        description: "Key chain export data",
        type: KeyChainExportDto,
    })
    @ApiResponse({ status: 403, description: TENANT_ADMIN_REQUIRED })
    @ApiResponse({ status: 404, description: "Key chain not found" })
    export(
        @Token() token: TokenPayload,
        @Param("id") id: string,
    ): Promise<KeyChainExportDto> {
        return this.keyChainService.export(requireTenantContext(token), id);
    }

    /**
     * Create a new key chain.
     */
    @Post()
    @ApiOperation({ summary: "Create a new key chain" })
    @ApiResponse({
        status: 201,
        description: "Key chain created successfully",
        type: KeyChainIdResponseDto,
    })
    async create(
        @Token() token: TokenPayload,
        @Body() body: KeyChainCreateDto,
    ): Promise<KeyChainIdResponseDto> {
        const id = await this.keyChainService.create(token.entity!.id, body);
        return { id };
    }

    /**
     * Import an existing key chain with provided key material and optional certificate.
     */
    @Post("import")
    @ApiOperation({ summary: "Import an existing key chain" })
    @ApiResponse({
        status: 201,
        description: "Key chain imported successfully",
        type: KeyChainIdResponseDto,
    })
    async import(
        @Token() token: TokenPayload,
        @Body() body: KeyChainImportDto,
    ): Promise<KeyChainIdResponseDto> {
        const id = await this.keyChainService.importKeyChain(
            token.entity!.id,
            body,
        );
        return { id };
    }

    /**
     * Update a key chain.
     */
    @Put(":id")
    @ApiOperation({ summary: "Update key chain metadata and rotation policy" })
    @ApiResponse({ status: 204, description: "Key chain updated successfully" })
    @ApiResponse({ status: 404, description: "Key chain not found" })
    @HttpCode(204)
    async update(
        @Token() token: TokenPayload,
        @Param("id") id: string,
        @Body() body: KeyChainUpdateDto,
    ): Promise<void> {
        await this.keyChainService.update(token.entity!.id, id, body);
    }

    /**
     * Delete a key chain.
     */
    @Delete(":id")
    @ApiOperation({ summary: "Delete a key chain" })
    @ApiResponse({ status: 204, description: "Key chain deleted successfully" })
    @ApiResponse({ status: 404, description: "Key chain not found" })
    @HttpCode(204)
    async delete(
        @Token() token: TokenPayload,
        @Param("id") id: string,
    ): Promise<void> {
        await this.keyChainService.delete(token.entity!.id, id);
    }

    /**
     * Manually trigger key rotation for a key chain.
     */
    @Post(":id/rotate")
    @ApiOperation({ summary: "Rotate the signing key in a key chain" })
    @ApiResponse({ status: 204, description: "Key chain rotated successfully" })
    @ApiResponse({ status: 404, description: "Key chain not found" })
    @HttpCode(204)
    async rotate(
        @Token() token: TokenPayload,
        @Param("id") id: string,
    ): Promise<void> {
        await this.keyChainService.rotate(token.entity!.id, id);
    }
}
