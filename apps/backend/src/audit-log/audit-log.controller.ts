import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Role } from "../auth/roles/role.enum.js";
import { Secured } from "../auth/secure.decorator.js";
import { requireTenantContext } from "../auth/tenant-context.util.js";
import { Token, TokenPayload } from "../auth/token.decorator.js";
import { AuditLogService } from "./audit-log.service.js";
import {
    AuditLogListQueryDto,
    AuditLogSearchQueryDto,
} from "./dto/audit-log-query.dto.js";
import { AuditLogPageResponseDto } from "./dto/audit-log-page-response.dto.js";
import { AuditLogResponseDto } from "./dto/audit-log-response.dto.js";
import { AuditLogRetentionResponseDto } from "./dto/audit-log-retention-response.dto.js";

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
        description:
            "Returns the newest entries that match the filters, at most `limit`. Use `GET /api/admin/audit-logs/search` to page through all entries.",
    })
    @ApiResponse({ status: 200, type: [AuditLogResponseDto] })
    getAuditLogs(
        @Token() user: TokenPayload,
        @Query() query: AuditLogListQueryDto,
    ): Promise<AuditLogResponseDto[]> {
        const { limit, ...filter } = query;
        return this.auditLogService.listByTenant(
            requireTenantContext(user),
            filter,
            limit,
        );
    }

    /**
     * Page through the audit log entries of the current tenant.
     */
    @Get("search")
    @ApiOperation({
        summary: "Search the audit log of the current tenant (paginated)",
        description:
            "Returns one page of the entries that match all given filters, newest first.",
    })
    @ApiResponse({ status: 200, type: AuditLogPageResponseDto })
    searchAuditLogs(
        @Token() user: TokenPayload,
        @Query() query: AuditLogSearchQueryDto,
    ): Promise<AuditLogPageResponseDto> {
        const { page, pageSize, ...filter } = query;
        return this.auditLogService.pageByTenant(
            requireTenantContext(user),
            filter,
            page,
            pageSize,
        );
    }

    /**
     * How long audit log entries are kept on this instance.
     */
    @Get("retention")
    @ApiOperation({
        summary: "Get the audit log retention of this instance",
        description:
            "The limits the daily pruning applies to every tenant. They are set by the operator and cannot be changed through the API.",
    })
    @ApiResponse({ status: 200, type: AuditLogRetentionResponseDto })
    getRetention(): AuditLogRetentionResponseDto {
        return this.auditLogService.retention();
    }
}
