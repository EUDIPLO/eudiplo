import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThan, Repository } from "typeorm";
import {
    AuditActionType,
    AuditActorType,
    AuditLogEntity,
} from "./entities/audit-log.entity.js";

export interface AuditLogActor {
    type: AuditActorType;
    id?: string;
    display?: string;
}

export interface AuditLogRequestMeta {
    requestId?: string;
}

export interface RecordAuditLogInput {
    tenantId: string;
    actionType: AuditActionType;
    actor: AuditLogActor;
    changedFields?: string[];
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    requestMeta?: AuditLogRequestMeta;
}

@Injectable()
export class AuditLogService {
    private readonly logger = new Logger(AuditLogService.name);

    constructor(
        @InjectRepository(AuditLogEntity)
        private readonly auditLogRepository: Repository<AuditLogEntity>,
        private readonly configService: ConfigService,
    ) {}

    async record(input: RecordAuditLogInput): Promise<void> {
        await this.auditLogRepository.save({
            tenantId: input.tenantId,
            actionType: input.actionType,
            actorType: input.actor.type,
            actorId: input.actor.id,
            actorDisplay: input.actor.display,
            changedFields: input.changedFields,
            before: input.before,
            after: input.after,
            requestId: input.requestMeta?.requestId,
        });
    }

    listByTenant(tenantId: string, limit = 100): Promise<AuditLogEntity[]> {
        return this.auditLogRepository.find({
            where: { tenantId },
            order: { timestamp: "DESC" },
            take: Math.max(1, Math.min(limit, 500)),
        });
    }

    /**
     * Scheduled job that prunes old audit log entries based on environment configuration.
     *
     * AUDIT_LOG_RETENTION_DAYS — delete entries older than N days (0 = disabled).
     * AUDIT_LOG_MAX_ENTRIES_PER_TENANT — keep only the last N entries per tenant (0 = disabled).
     *
     * Runs daily at 03:00.
     */
    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async pruneOldLogs(): Promise<void> {
        const retentionDays = this.configService.get<number>(
            "AUDIT_LOG_RETENTION_DAYS",
            0,
        );
        const maxEntriesPerTenant = this.configService.get<number>(
            "AUDIT_LOG_MAX_ENTRIES_PER_TENANT",
            0,
        );

        if (retentionDays > 0) {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - retentionDays);
            const result = await this.auditLogRepository.delete({
                timestamp: LessThan(cutoff),
            });
            this.logger.log(
                `Pruned ${result.affected ?? 0} audit log entries older than ${retentionDays} days`,
            );
        }

        if (maxEntriesPerTenant > 0) {
            await this.pruneByMaxEntries(maxEntriesPerTenant);
        }
    }

    private async pruneByMaxEntries(maxEntries: number): Promise<void> {
        // Fetch distinct tenant IDs that have logs
        const tenants = await this.auditLogRepository
            .createQueryBuilder("log")
            .select("DISTINCT log.tenantId", "tenantId")
            .getRawMany<{ tenantId: string }>();

        let total = 0;
        for (const { tenantId } of tenants) {
            const count = await this.auditLogRepository.count({
                where: { tenantId },
            });
            if (count <= maxEntries) continue;

            // Find the timestamp of the Nth newest entry (the cutoff point)
            const [cutoffEntry] = await this.auditLogRepository.find({
                where: { tenantId },
                order: { timestamp: "DESC" },
                skip: maxEntries,
                take: 1,
            });
            if (!cutoffEntry) continue;

            const result = await this.auditLogRepository
                .createQueryBuilder()
                .delete()
                .where("tenantId = :tenantId", { tenantId })
                .andWhere("timestamp <= :cutoff", {
                    cutoff: cutoffEntry.timestamp,
                })
                .execute();
            total += result.affected ?? 0;
        }

        if (total > 0) {
            this.logger.log(
                `Pruned ${total} audit log entries exceeding per-tenant limit of ${maxEntries}`,
            );
        }
    }
}
