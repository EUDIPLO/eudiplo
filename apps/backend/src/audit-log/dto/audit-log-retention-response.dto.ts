import { ApiProperty } from "@nestjs/swagger";

/**
 * How long the audit log is kept. Set by the operator with
 * `AUDIT_LOG_RETENTION_DAYS` and `AUDIT_LOG_MAX_ENTRIES_PER_TENANT`; tenants
 * cannot change or bypass it.
 */
export class AuditLogRetentionResponseDto {
    @ApiProperty({
        description:
            "Entries older than this many days are deleted daily. 0 means no age limit.",
        minimum: 0,
    })
    retentionDays!: number;

    @ApiProperty({
        description:
            "Only this many of a tenant's newest entries are kept. 0 means no count limit.",
        minimum: 0,
    })
    maxEntriesPerTenant!: number;
}
