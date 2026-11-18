import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import {
    And,
    Between,
    Equal,
    FindOptionsWhere,
    In,
    LessThan,
    LessThanOrEqual,
    MoreThanOrEqual,
    Raw,
    Repository,
} from "typeorm";
import {
    type AuditActionType,
    type AuditActorType,
    type AuditObjectType,
    actionTypesMatching,
    actionTypesOf,
} from "./audit-action-types.js";
import { AuditLogEntity } from "./entities/audit-log.entity.js";

export interface AuditLogActor {
    type: AuditActorType;
    id?: string;
    display?: string;
}

export interface AuditLogRequestMeta {
    requestId?: string;
}

/** Filters of the audit log lists. All given filters must match. */
export interface AuditLogFilter {
    from?: Date;
    to?: Date;
    actionType?: AuditActionType[];
    objectType?: AuditObjectType;
    actorType?: AuditActorType;
    actorId?: string;
    requestId?: string;
    /** Text to find in the action, the actor or a changed field's name. */
    q?: string;
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

    /** The newest entries of the tenant that match the filter, at most `limit`. */
    listByTenant(
        tenantId: string,
        filter: AuditLogFilter,
        limit: number,
    ): Promise<AuditLogEntity[]> {
        const where = whereFor(tenantId, filter);
        if (!where) return Promise.resolve([]);
        return this.auditLogRepository.find({
            where,
            order: NEWEST_FIRST,
            take: limit,
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
     * Each tenant whose entries were deleted gets one `audit_log_pruned`
     * entry per run, so a gap in its log can be told from a quiet period.
     * Earlier pruning records are deleted like other entries but never
     * counted, and deleting only those writes no new record: otherwise a
     * quiet tenant would get a new record every run.
     *
     * Runs daily at 03:00.
     */
    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async pruneOldLogs(): Promise<void> {
        const { retentionDays, maxEntriesPerTenant } = this.retention();
        if (retentionDays <= 0 && maxEntriesPerTenant <= 0) return;

        let cutoff: Date | undefined;
        if (retentionDays > 0) {
            cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - retentionDays);
        }
        const tenants = await this.auditLogRepository
            .createQueryBuilder("log")
            .select("DISTINCT log.tenantId", "tenantId")
            .getRawMany<{ tenantId: string }>();

        let total = 0;
        for (const { tenantId } of tenants) {
            total += await this.pruneTenant(
                tenantId,
                retentionDays,
                cutoff,
                maxEntriesPerTenant,
            );
        }
        if (total > 0) {
            this.logger.log(`Pruned ${total} audit log entries`);
        }
    }

    /** Apply both limits to one tenant; returns the counted deletions. */
    private async pruneTenant(
        tenantId: string,
        retentionDays: number,
        cutoff: Date | undefined,
        maxEntries: number,
    ): Promise<number> {
        const applied: Record<string, unknown> = {};
        let deleted = 0;

        if (cutoff) {
            await this.auditLogRepository.delete({
                tenantId,
                actionType: "audit_log_pruned",
                timestamp: LessThan(cutoff),
            });
            const result = await this.auditLogRepository.delete({
                tenantId,
                timestamp: LessThan(cutoff),
            });
            if (result.affected) {
                deleted += result.affected;
                applied.retentionDays = retentionDays;
                applied.olderThan = cutoff.toISOString();
            }
        }

        if (maxEntries > 0) {
            const count = await this.auditLogRepository.count({
                where: { tenantId },
            });
            // The record of this run takes one place, so the next run finds
            // the tenant within the limit.
            const keep =
                deleted > 0 || count > maxEntries ? maxEntries - 1 : maxEntries;
            if (count > keep) {
                const overLimit = await this.deleteAllButNewest(tenantId, keep);
                if (overLimit > 0) {
                    deleted += overLimit;
                    applied.maxEntriesPerTenant = maxEntries;
                }
            }
        }

        if (deleted > 0) {
            await this.record({
                tenantId,
                actionType: "audit_log_pruned",
                actor: { type: "system", display: "Audit log retention" },
                after: { deletedEntries: deleted, ...applied },
            });
        }
        return deleted;
    }

    /**
     * Delete a tenant's entries after the newest `keep`, in batches by id: the
     * list order breaks timestamp ties by id, which a timestamp comparison
     * cannot reproduce on SQLite. Returns the number of deleted entries that
     * are not earlier pruning records.
     */
    private async deleteAllButNewest(
        tenantId: string,
        keep: number,
    ): Promise<number> {
        let counted = 0;
        for (;;) {
            const batch = await this.auditLogRepository.find({
                select: { id: true, actionType: true },
                where: { tenantId },
                order: NEWEST_FIRST,
                skip: keep,
                take: PRUNE_BATCH_SIZE,
            });
            if (batch.length === 0) return counted;
            const result = await this.auditLogRepository.delete({
                tenantId,
                id: In(batch.map((entry) => entry.id)),
            });
            // Another instance pruned these meanwhile: stop rather than loop.
            if (result.affected === 0) return counted;
            counted += batch.filter(
                (entry) => entry.actionType !== "audit_log_pruned",
            ).length;
        }
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
 * The query for a filter, always scoped to the tenant: one condition, or
 * several of which one must match (for `q`). `undefined` when the filter
 * cannot match anything, such as an action type that does not belong to the
 * requested object type.
 */
function whereFor(
    tenantId: string,
    filter: AuditLogFilter,
):
    | FindOptionsWhere<AuditLogEntity>
    | FindOptionsWhere<AuditLogEntity>[]
    | undefined {
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

    return filter.q ? textSearch(where, filter.q, actionTypes) : where;
}

/**
 * Entries that match `where` and contain `q` in their action, the id or
 * display value of their actor, or the name of a changed field, ignoring
 * case (SQLite folds only ASCII letters). The action is matched in code
 * against the known action types, as written or as the web client labels
 * them, so "config created" or "openid connect" become an `IN` on the
 * column instead of a pattern.
 */
function textSearch(
    where: FindOptionsWhere<AuditLogEntity>,
    q: string,
    actionTypes: AuditActionType[] | undefined,
): FindOptionsWhere<AuditLogEntity>[] {
    const pattern = `%${q.toLowerCase().replace(/[!%_]/g, "!$&")}%`;
    const contains = (expression: (alias: string) => string) =>
        Raw((alias) => `LOWER(${expression(alias)}) LIKE :q ESCAPE '!'`, {
            q: pattern,
        });

    const branches: FindOptionsWhere<AuditLogEntity>[] = [
        {
            ...where,
            // An exact actor id filter still applies.
            actorId: where.actorId
                ? And(
                      Equal(where.actorId as string),
                      contains((alias) => alias),
                  )
                : contains((alias) => alias),
        },
        { ...where, actorDisplay: contains((alias) => alias) },
        // The JSON array of field names as text; CAST works on SQLite and
        // PostgreSQL. A `q` of JSON punctuation, such as a comma, also
        // matches; that finds nothing the caller cannot already read.
        {
            ...where,
            changedFields: contains((alias) => `CAST(${alias} AS TEXT)`),
        },
    ];
    const matching = actionTypesMatching(q).filter(
        (type) => !actionTypes || actionTypes.includes(type),
    );
    if (matching.length > 0) {
        branches.push({ ...where, actionType: In(matching) });
    }
    return branches;
}
