import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import {
    Between,
    FindOptionsWhere,
    In,
    LessThan,
    LessThanOrEqual,
    MoreThanOrEqual,
    Repository,
} from "typeorm";
import {
    type AuditActionType,
    type AuditActorType,
    actionTypesOf,
} from "./audit-action-types.js";
import type { AuditLogFilter } from "./dto/audit-log-query.dto.js";
import { AuditLogEntity } from "./entities/audit-log.entity.js";

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

    /** The newest entries of the tenant that match the filter. */
    async listByTenant(
        tenantId: string,
        filter: AuditLogFilter = {},
        limit = 100,
    ): Promise<AuditLogEntity[]> {
        const where = whereFor(tenantId, filter);
        if (!where) return [];
        return this.auditLogRepository.find({
            where,
            order: NEWEST_FIRST,
            take: Math.max(1, Math.min(limit, 500)),
        });
    }

    /** One page of the tenant's entries that match the filter, newest first. */
    async pageByTenant(
        tenantId: string,
        filter: AuditLogFilter,
        page: number,
        pageSize: number,
    ): Promise<AuditLogPage> {
        const where = whereFor(tenantId, filter);
        const [items, total] = where
            ? await this.auditLogRepository.findAndCount({
                  where,
                  order: NEWEST_FIRST,
                  skip: (page - 1) * pageSize,
                  take: pageSize,
              })
            : [[], 0];
        return {
            items,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    }

    /** The operator's retention limits; 0 means no limit. */
    retention(): AuditLogRetention {
        return {
            retentionDays: this.configService.get<number>(
                "AUDIT_LOG_RETENTION_DAYS",
                0,
            ),
            maxEntriesPerTenant: this.configService.get<number>(
                "AUDIT_LOG_MAX_ENTRIES_PER_TENANT",
                0,
            ),
        };
    }

    /**
     * Scheduled job that prunes old audit log entries based on environment configuration.
     *
     * AUDIT_LOG_RETENTION_DAYS — delete entries older than N days (0 = disabled).
     * AUDIT_LOG_MAX_ENTRIES_PER_TENANT — keep only the last N entries per tenant (0 = disabled).
     *
     * Each tenant whose entries were deleted gets an `audit_log_pruned` entry,
     * so a gap in its log can be told from a quiet period.
     *
     * Runs daily at 03:00.
     */
    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async pruneOldLogs(): Promise<void> {
        const { retentionDays, maxEntriesPerTenant } = this.retention();
        if (retentionDays > 0) {
            await this.pruneByAge(retentionDays);
        }
        if (maxEntriesPerTenant > 0) {
            await this.pruneByMaxEntries(maxEntriesPerTenant);
        }
    }

    private async pruneByAge(retentionDays: number): Promise<void> {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);
        const tenants = await this.auditLogRepository
            .createQueryBuilder("log")
            .select("DISTINCT log.tenantId", "tenantId")
            .where("log.timestamp < :cutoff", { cutoff })
            .getRawMany<{ tenantId: string }>();

        let total = 0;
        for (const { tenantId } of tenants) {
            const result = await this.auditLogRepository.delete({
                tenantId,
                timestamp: LessThan(cutoff),
            });
            const deleted = result.affected ?? 0;
            if (deleted === 0) continue;
            total += deleted;
            await this.recordPruned(tenantId, deleted, {
                reason: "retention_days",
                retentionDays,
                olderThan: cutoff.toISOString(),
            });
        }
        this.logger.log(
            `Pruned ${total} audit log entries older than ${retentionDays} days`,
        );
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

            // Keep one entry less than allowed: the record of this pruning
            // takes the last place, so the next run has nothing to prune.
            const deleted = await this.deleteAllButNewest(
                tenantId,
                maxEntries - 1,
            );
            if (deleted === 0) continue;
            total += deleted;
            await this.recordPruned(tenantId, deleted, {
                reason: "max_entries_per_tenant",
                maxEntriesPerTenant: maxEntries,
            });
        }

        if (total > 0) {
            this.logger.log(
                `Pruned ${total} audit log entries exceeding per-tenant limit of ${maxEntries}`,
            );
        }
    }

    /**
     * Delete a tenant's entries after the newest `keep`, in batches by id: the
     * list order breaks timestamp ties by id, which a timestamp comparison
     * cannot reproduce on SQLite.
     */
    private async deleteAllButNewest(
        tenantId: string,
        keep: number,
    ): Promise<number> {
        let deleted = 0;
        for (;;) {
            const batch = await this.auditLogRepository.find({
                select: { id: true },
                where: { tenantId },
                order: NEWEST_FIRST,
                skip: keep,
                take: PRUNE_BATCH_SIZE,
            });
            if (batch.length === 0) return deleted;
            const result = await this.auditLogRepository.delete({
                tenantId,
                id: In(batch.map((entry) => entry.id)),
            });
            // Another instance pruned these meanwhile: stop rather than loop.
            if (result.affected === 0) return deleted;
            deleted += result.affected ?? batch.length;
        }
    }

    private recordPruned(
        tenantId: string,
        deletedEntries: number,
        details: Record<string, unknown>,
    ): Promise<void> {
        return this.record({
            tenantId,
            actionType: "audit_log_pruned",
            actor: { type: "system", display: "Audit log retention" },
            after: { deletedEntries, ...details },
        });
    }
}

const NEWEST_FIRST = { timestamp: "DESC", id: "DESC" } as const;
const PRUNE_BATCH_SIZE = 500;

export interface AuditLogPage {
    items: AuditLogEntity[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

export interface AuditLogRetention {
    retentionDays: number;
    maxEntriesPerTenant: number;
}

/**
 * The query for a filter, always scoped to the tenant. `undefined` when the
 * filter cannot match anything: an action type that does not belong to the
 * requested object type.
 */
function whereFor(
    tenantId: string,
    filter: AuditLogFilter,
): FindOptionsWhere<AuditLogEntity> | undefined {
    const where: FindOptionsWhere<AuditLogEntity> = { tenantId };

    let actionTypes = filter.actionType;
    if (filter.objectType) {
        const ofObject = actionTypesOf(filter.objectType);
        actionTypes = actionTypes
            ? actionTypes.filter((type) => ofObject.includes(type))
            : ofObject;
    }
    if (actionTypes) {
        if (actionTypes.length === 0) return undefined;
        where.actionType = In(actionTypes);
    }

    if (filter.from && filter.to) {
        where.timestamp = Between(filter.from, filter.to);
    } else if (filter.from) {
        where.timestamp = MoreThanOrEqual(filter.from);
    } else if (filter.to) {
        where.timestamp = LessThanOrEqual(filter.to);
    }
    if (filter.actorType) where.actorType = filter.actorType;
    if (filter.actorId) where.actorId = filter.actorId;
    if (filter.requestId) where.requestId = filter.requestId;
    return where;
}
