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
import {
    ApiBody,
    ApiExtraModels,
    ApiOperation,
    ApiResponse,
    ApiTags,
} from "@nestjs/swagger";
import type { AuditLogRequestMeta } from "../../audit-log/audit-log.service.js";
import { AuditMeta } from "../../audit-log/audit-log-context.util.js";
import { Role } from "../roles/role.enum.js";
import { Secured } from "../secure.decorator.js";
import { Token, TokenPayload } from "../token.decorator.js";
import { CreateTenantDto } from "./dto/create-tenant.dto.js";
import { ImportTenantDto } from "./dto/import-tenant.dto.js";
import {
    TenantCreateResponseDto,
    TenantResponseDto,
} from "./dto/tenant-response.dto.js";
import { UpdateTenantDto } from "./dto/update-tenant.dto.js";
import { TenantService } from "./tenant.service.js";

/**
 * Tenant management controller
 */
@ApiExtraModels(ImportTenantDto)
@ApiTags("Tenant")
@Secured([Role.Tenants])
@Controller("tenant")
export class TenantController {
    constructor(private readonly tenantService: TenantService) {}

    /**
     * Get all tenants
     * @returns
     */
    @ApiOperation({ summary: "Get all tenants" })
    @ApiResponse({ status: 200, type: [TenantResponseDto] })
    @Get()
    getTenants(): Promise<TenantResponseDto[]> {
        return this.tenantService.getAll();
    }

    /**
     * Initialize a tenant
     * @param data
     * @returns
     */
    @ApiOperation({ summary: "Initialize a tenant" })
    @ApiBody({ type: CreateTenantDto })
    @ApiResponse({ status: 201, type: TenantCreateResponseDto })
    @Post()
    initTenant(
        @Body() data: CreateTenantDto,
        @Token() token: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        return this.tenantService.createTenant(data, token, requestMeta);
    }

    /**
     * Get a tenant by ID
     * @param id The ID of the tenant
     * @returns The tenant
     */
    @ApiOperation({ summary: "Get a tenant by ID" })
    @ApiResponse({ status: 200, type: TenantResponseDto })
    @Get(":id")
    getTenant(@Param("id") id: string): Promise<TenantResponseDto> {
        return this.tenantService.getTenant(id);
    }

    /**
     * Update a tenant by ID
     * @param id The ID of the tenant
     * @param data The updated tenant data
     * @returns The updated tenant
     */
    @ApiOperation({ summary: "Update a tenant by ID" })
    @ApiBody({ type: UpdateTenantDto })
    @ApiResponse({ status: 200, type: TenantResponseDto })
    @Patch(":id")
    updateTenant(
        @Param("id") id: string,
        @Body() data: UpdateTenantDto,
        @Token() token: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        return this.tenantService.updateTenant(id, data, token, requestMeta);
    }

    /**
     * Deletes a tenant by ID
     * @param id The ID of the tenant to delete
     */
    @ApiOperation({ summary: "Delete a tenant by ID" })
    @ApiResponse({ status: 204, description: "Tenant deleted" })
    @Delete(":id")
    @HttpCode(204)
    deleteTenant(
        @Param("id") id: string,
        @Token() token: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        return this.tenantService.deleteTenant(id, token, requestMeta);
    }
}
