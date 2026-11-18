import { ApiProperty } from "@nestjs/swagger";
import { AuditLogResponseDto } from "./audit-log-response.dto.js";

/** One page of audit log entries, newest first. */
export class AuditLogPageResponseDto {
    @ApiProperty({ type: [AuditLogResponseDto] })
    items!: AuditLogResponseDto[];

    @ApiProperty({ description: "Number of entries matching the filters" })
    total!: number;

    @ApiProperty({ description: "Current page number (1-based)" })
    page!: number;

    @ApiProperty({ description: "Number of entries per page" })
    pageSize!: number;

    @ApiProperty({ description: "Total number of pages" })
    totalPages!: number;
}
