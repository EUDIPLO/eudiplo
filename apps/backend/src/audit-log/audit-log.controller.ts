import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Role } from "../auth/roles/role.enum.js";
import { Secured } from "../auth/secure.decorator.js";
import { requireTenantContext } from "../auth/tenant-context.util.js";
import { Token, TokenPayload } from "../auth/token.decorator.js";
import { AuditLogService } from "./audit-log.service.js";
import { AuditLogResponseDto } from "./dto/audit-log-response.dto.js";

@ApiTags("Audit Log")
@Secured([Role.Clients, Role.AuditRead])
@Controller("admin/audit-logs")
export class AuditLogController {
    constructor(private readonly auditLogService: AuditLogService) {}

    /**
     * Get recent audit log entries for the current tenant.
     */
    @Get()
    @ApiOperation({
        summary: "Get recent audit log entries for the current tenant",
    })
    @ApiQuery({
        name: "limit",
        required: false,
        type: Number,
        description: "Maximum number of entries to return (1–500)",
    })
    @ApiResponse({ status: 200, type: [AuditLogResponseDto] })
    getAuditLogs(
        @Token() user: TokenPayload,
        @Query("limit") limit?: string,
    ): Promise<AuditLogResponseDto[]> {
        const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
        return this.auditLogService.listByTenant(
            requireTenantContext(user),
            parsedLimit,
        );
    }
}
