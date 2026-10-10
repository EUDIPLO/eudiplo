import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
    Brackets,
    type FindOptionsWhere,
    In,
    IsNull,
    LessThan,
    MoreThan,
    Not,
    Repository,
    type SelectQueryBuilder,
} from "typeorm";
import type { QueryDeepPartialEntity } from "typeorm/query-builder/QueryPartialEntity.js";
import { hashAuthorizationCode } from "../../issuer/issuance/oid4vci/authorization/domain/token-grant-rules.js";
import type {
    ExternalSessionBinding,
    NewSession,
    SessionData,
    SessionUpdate,
} from "../domain/session-data.js";
import type {
    SessionListQuery,
    SessionSummary,
    SessionType,
} from "../domain/session-list.js";
import {
    parseSessionSearch,
    type SessionSearch,
    uuidPrefixRange,
} from "../domain/session-search.js";
import {
    OPEN_SESSION_STATUSES,
    type SessionLifecycleContext,
    type SessionStateUpdate,
    SessionStatus,
} from "../domain/session-state.js";
import type { SessionTypeStatusCount } from "../domain/session-stats.js";
import { Session } from "../entities/session.entity.js";
import type {
    SessionCount,
    SessionCredentialOffer,
    SessionRepository,
} from "../ports/session.repository.js";

/** Issuance sessions have no `requestId`, as in {@link typeWhere}. */
const ISSUANCE_CASE = "CASE WHEN s.requestId IS NULL THEN 1 ELSE 0 END";

interface TypeStatusCountRow {
    issuance: number | string | boolean;
    status: SessionStatus;
    count: number | string;
}

/** Replace the selection with counts per session type and status. */
function countByTypeAndStatus(
    query: SelectQueryBuilder<Session>,
): SelectQueryBuilder<Session> {
    return query
        .select(ISSUANCE_CASE, "issuance")
        .addSelect("s.status", "status")
        .addSelect("COUNT(*)", "count")
        .groupBy(ISSUANCE_CASE)
        .addGroupBy("s.status");
}

function toTypeStatusCount(row: TypeStatusCountRow): SessionTypeStatusCount {
    return {
        type: Number(row.issuance) === 1 ? "issuance" : "presentation",
        status: row.status,
        count: Number(row.count),
    };
}

/** Where clause selecting one session type; any type when omitted. */
function typeWhere(type?: SessionType): FindOptionsWhere<Session> {
    if (type === "issuance") return { requestId: IsNull() };
    if (type === "presentation") return { requestId: Not(IsNull()) };
    return {};
}

@Injectable()
export class TypeOrmSessionRepository implements SessionRepository {
    private readonly logger = new Logger(TypeOrmSessionRepository.name);

    constructor(
        @InjectRepository(Session)
        private readonly sessions: Repository<Session>,
    ) {}

    async create(session: NewSession): Promise<SessionData> {
        return this.toData(await this.sessions.save(session));
    }

    async updateForTenant(
        tenantId: string,
        id: string,
        update: SessionUpdate,
    ): Promise<number> {
        const result = await this.sessions.update(
            { tenantId, id },
            update as QueryDeepPartialEntity<Session>,
        );
        return result.affected ?? 0;
    }

    async updateUnconsumedForTenant(
        tenantId: string,
        id: string,
        update: SessionUpdate,
    ): Promise<boolean> {
        // One atomic statement: a session that is already finished or past
        // its expiry keeps its final state.
        const base = {
            tenantId,
            id,
            consumed: false,
            status: In([...OPEN_SESSION_STATUSES]),
        };
        const result = await this.sessions.update(
            [
                { ...base, expiresAt: IsNull() },
                { ...base, expiresAt: MoreThan(new Date()) },
            ],
            update as QueryDeepPartialEntity<Session>,
        );
        return (result.affected ?? 0) > 0;
    }

    async consumeRequestUri(
        tenantId: string,
        id: string,
        expiresAt: Date,
        now: Date,
    ): Promise<boolean> {
        if (expiresAt.getTime() <= now.getTime()) return false;
        // Compare-and-set on the expiry read by the caller: the first update
        // replaces it with `now`, so every later update matches no row.
        const result = await this.sessions.update(
            { tenantId, id, request_uri_expires_at: expiresAt },
            { request_uri_expires_at: now },
        );
        return (result.affected ?? 0) > 0;
    }

    findForTenant(tenantId: string, id: string, type?: SessionType) {
        return this.findSession({ tenantId, id, ...typeWhere(type) });
    }

    findByIdForInternalFlow(id: string) {
        return this.findSession({ id });
    }
    async findForWalletRequest(walletNonce: string) {
        return (
            (await this.findSession({ walletNonce })) ??
            this.findSession({ id: walletNonce })
        );
    }
    findIso18013Session(id: string) {
        return this.findSession({ id, dcApiProtocol: "iso-18013-7" });
    }
    findByAuthorizationCode(tenantId: string, codeHash: string) {
        return this.findSession({ tenantId, authorization_code: codeHash });
    }
    findByRefreshToken(tenantId: string, refreshTokenHash: string) {
        return this.findSession({ tenantId, refresh_token: refreshTokenHash });
    }
    findByRequestUri(tenantId: string, request_uri: string) {
        return this.findSession({ tenantId, request_uri });
    }

    async bindExternalAuthorization(
        binding: ExternalSessionBinding,
    ): Promise<SessionData | null> {
        const where = {
            id: binding.sessionId,
            tenantId: binding.tenantId,
            authorizationServerId: binding.authorizationServerId,
            status: SessionStatus.Active,
        };
        const existing = await this.findSession(where);
        if (!existing) return null;
        await this.sessions.update(
            { id: existing.id, tenantId: binding.tenantId },
            {
                externalIssuer: binding.externalIssuer,
                externalSubject: binding.externalSubject,
            },
        );
        return existing;
    }

    private async findSession(
        where: FindOptionsWhere<Session>,
    ): Promise<SessionData | null> {
        const session = await this.sessions.findOneBy(where);
        return session ? this.toData(session) : null;
    }

    private toData(session: Session): SessionData {
        const { tenant, ...data } = session;
        return {
            ...data,
            ...(tenant === undefined
                ? {}
                : {
                      tenant:
                          tenant === null
                              ? tenant
                              : {
                                    id: tenant.id,
                                    name: tenant.name,
                                    description: tenant.description,
                                    status: tenant.status,
                                    sessionConfig: tenant.sessionConfig,
                                    statusListConfig: tenant.statusListConfig,
                                },
                  }),
        };
    }

    async incrementFailedTxCodeAttempts(
        tenantId: string,
        sessionId: string,
    ): Promise<number | null> {
        const where = { id: sessionId, tenantId };
        await this.sessions.increment(where, "txCodeFailedAttempts", 1);
        const session = await this.sessions.findOne({
            where,
            select: { id: true, txCodeFailedAttempts: true },
            loadEagerRelations: false,
        });
        return session ? (session.txCodeFailedAttempts ?? 0) : null;
    }

    async listForTenant(
        tenantId: string,
        query: SessionListQuery,
    ): Promise<{ items: SessionSummary[]; total: number }> {
        const { page, pageSize, sortBy, sortOrder } = query;
        const filtered = this.filteredSessions(tenantId, query);
        // Count separately from the paged, projected query.
        const total = await filtered.clone().getCount();
        const direction = sortOrder === "asc" ? "ASC" : "DESC";
        const sessions = await filtered
            .select([
                "s.id",
                "s.status",
                "s.createdAt",
                "s.updatedAt",
                "s.expiresAt",
                "s.requestId",
                "s.failureCode",
                "s.reference",
            ])
            .orderBy(`s.${sortBy ?? "updatedAt"}`, direction)
            // Tie-breaker so pages neither repeat nor skip equal sort values.
            .addOrderBy("s.id", direction)
            .offset((page - 1) * pageSize)
            .limit(pageSize)
            .getMany();
        return {
            items: sessions.map((session) => ({
                id: session.id,
                status: session.status,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                expiresAt: session.expiresAt ?? null,
                requestId: session.requestId ?? null,
                failureCode: session.failureCode ?? null,
                reference: session.reference ?? null,
            })),
            total,
        };
    }

    async countForTenant(
        tenantId: string,
        type?: SessionType,
    ): Promise<SessionTypeStatusCount[]> {
        const rows: TypeStatusCountRow[] = await countByTypeAndStatus(
            this.filteredSessions(tenantId, { type }),
        ).getRawMany();
        return rows.map(toTypeStatusCount);
    }

    async lastUpdatedForTenant(
        tenantId: string,
        type: SessionType,
        status: SessionStatus,
    ): Promise<Date | null> {
        // Read through the entity, so both databases return a Date.
        const session = await this.filteredSessions(tenantId, {
            type,
            status: [status],
        })
            .select(["s.id", "s.updatedAt"])
            .orderBy("s.updatedAt", "DESC")
            .limit(1)
            .getOne();
        return session?.updatedAt ?? null;
    }

    /** The tenant's sessions matching every filter of the query. */
    private filteredSessions(
        tenantId: string,
        query: Omit<SessionListQuery, "page" | "pageSize">,
    ): SelectQueryBuilder<Session> {
        const qb = this.sessions
            .createQueryBuilder("s")
            .where("s.tenantId = :tenantId", { tenantId });
        if (query.status?.length)
            qb.andWhere("s.status IN (:...statuses)", {
                statuses: query.status,
            });
        if (query.type === "issuance") qb.andWhere("s.requestId IS NULL");
        else if (query.type === "presentation")
            qb.andWhere("s.requestId IS NOT NULL");
        if (query.createdFrom)
            qb.andWhere("s.createdAt >= :createdFrom", {
                createdFrom: query.createdFrom,
            });
        if (query.createdTo)
            qb.andWhere("s.createdAt <= :createdTo", {
                createdTo: query.createdTo,
            });
        if (query.updatedFrom)
            qb.andWhere("s.updatedAt >= :updatedFrom", {
                updatedFrom: query.updatedFrom,
            });
        if (query.updatedTo)
            qb.andWhere("s.updatedAt <= :updatedTo", {
                updatedTo: query.updatedTo,
            });
        if (query.requestId)
            qb.andWhere("s.requestId = :requestId", {
                requestId: query.requestId,
            });
        if (query.failureCode)
            qb.andWhere("s.failureCode = :failureCode", {
                failureCode: query.failureCode,
            });
        if (query.credentialConfigurationId)
            qb.andWhere(
                ...this.offersCredentialConfiguration(
                    query.credentialConfigurationId,
                ),
            );
        if (query.id) {
            const [idFrom, idTo] = uuidPrefixRange(query.id);
            qb.andWhere("s.id BETWEEN :idFrom AND :idTo", { idFrom, idTo });
        }
        if (query.q)
            qb.andWhere(this.matchesSearch(parseSessionSearch(query.q)));
        return qb;
    }

    /** JSON array membership; neither dialect can index it, the tenant scope bounds it. */
    private offersCredentialConfiguration(
        id: string,
    ): [string, { credentialConfigurationId: string }] {
        return this.sessions.manager.connection.options.type === "postgres"
            ? [
                  "CAST(s.credentialConfigurationIds AS jsonb) @> CAST(:credentialConfigurationId AS jsonb)",
                  { credentialConfigurationId: JSON.stringify([id]) },
              ]
            : [
                  "EXISTS (SELECT 1 FROM json_each(s.credentialConfigurationIds) WHERE json_each.value = :credentialConfigurationId)",
                  { credentialConfigurationId: id },
              ];
    }

    /** Any identifier of the search matches; a search without identifiers matches nothing. */
    private matchesSearch(search: SessionSearch): Brackets {
        return new Brackets((qb) => {
            qb.where("1 = 0");
            if (search.idPrefix) {
                const [searchIdFrom, searchIdTo] = uuidPrefixRange(
                    search.idPrefix,
                );
                qb.orWhere("s.id BETWEEN :searchIdFrom AND :searchIdTo", {
                    searchIdFrom,
                    searchIdTo,
                });
            }
            if (search.walletNonce)
                qb.orWhere("s.walletNonce = :searchWalletNonce", {
                    searchWalletNonce: search.walletNonce,
                });
            if (search.authorizationCode)
                qb.orWhere("s.authorization_code = :searchAuthorizationCode", {
                    // Only the hash of the code is stored.
                    searchAuthorizationCode: hashAuthorizationCode(
                        search.authorizationCode,
                    ),
                });
            if (search.reference)
                qb.orWhere("s.reference = :searchReference", {
                    searchReference: search.reference,
                });
        });
    }

    async deleteForTenant(
        tenantId: string,
        sessionId: string,
        type?: SessionType,
    ): Promise<void> {
        await this.sessions.delete({
            id: sessionId,
            tenantId,
            ...typeWhere(type),
        });
    }

    async findExpiredSessionsForMaintenance(
        before: Date,
    ): Promise<SessionLifecycleContext[]> {
        const sessions = await this.sessions.find({
            where: [
                {
                    expiresAt: LessThan(before),
                    requestId: Not(IsNull()),
                    status: In([...OPEN_SESSION_STATUSES]),
                },
                // Issuance offers expire only while not redeemed: a wallet
                // holding tokens keeps using the session after `expiresAt`.
                {
                    expiresAt: LessThan(before),
                    requestId: IsNull(),
                    status: SessionStatus.Active,
                    consumed: false,
                },
            ],
            select: { id: true, tenantId: true, requestId: true },
            loadEagerRelations: false,
        });
        return sessions.map(({ id, tenantId, requestId }) => ({
            id,
            tenantId,
            requestId,
        }));
    }

    async countSessionsByStatus(): Promise<SessionCount[]> {
        const rows: (TypeStatusCountRow & { tenantId: string })[] =
            await countByTypeAndStatus(this.sessions.createQueryBuilder("s"))
                .addSelect("s.tenantId", "tenantId")
                .addGroupBy("s.tenantId")
                .getRawMany();
        return rows.map((row) => {
            const { type, status, count } = toTypeStatusCount(row);
            return {
                tenantId: row.tenantId,
                kind: type === "issuance" ? "issuance" : "verification",
                status,
                count,
            };
        });
    }

    async deleteSessionsCreatedBefore(
        tenantId: string,
        cutoff: Date,
    ): Promise<number> {
        const result = await this.sessions.delete({
            tenantId,
            createdAt: LessThan(cutoff),
        });
        const affected = result.affected ?? 0;
        if (affected > 0)
            this.logger.log(
                `Deleted ${affected} sessions for tenant ${tenantId}`,
            );
        return affected;
    }

    async anonymizeSessionsCreatedBefore(
        tenantId: string,
        cutoff: Date,
    ): Promise<number> {
        const query = this.sessions.createQueryBuilder().update();
        const result = await query
            .set({
                credentials: () => "NULL",
                credentialPayload: () => "NULL",
                auth_queries: () => "NULL",
                offer: () => "NULL",
                requestObject: () => "NULL",
                responseEncryptionPrivateJwk: () => "NULL",
                // Otherwise TypeORM sets it to now; anonymizing keeps the timestamps.
                updatedAt: () => query.escape("updatedAt"),
            })
            .where("tenantId = :tenantId", { tenantId })
            .andWhere("createdAt < :cutoffDate", { cutoffDate: cutoff })
            .andWhere(
                "(credentials IS NOT NULL OR credentialPayload IS NOT NULL OR auth_queries IS NOT NULL OR offer IS NOT NULL OR requestObject IS NOT NULL OR responseEncryptionPrivateJwk IS NOT NULL)",
            )
            .execute();
        const affected = result.affected ?? 0;
        if (affected > 0)
            this.logger.log(
                `Anonymized ${affected} sessions for tenant ${tenantId}`,
            );
        return affected;
    }

    async deleteOrphanedSessionsCreatedBefore(
        knownTenantIds: string[],
        cutoff: Date,
    ): Promise<number> {
        if (knownTenantIds.length === 0) return 0;
        const result = await this.sessions
            .createQueryBuilder()
            .delete()
            .where("tenantId NOT IN (:...tenantIds)", {
                tenantIds: knownTenantIds,
            })
            .andWhere("createdAt < :cutoff", { cutoff })
            .execute();
        const affected = result.affected ?? 0;
        if (affected > 0)
            this.logger.log(`Deleted ${affected} orphaned sessions`);
        return affected;
    }

    async changeState(
        tenantId: string,
        sessionId: string,
        update: SessionStateUpdate,
    ): Promise<void> {
        await this.sessions.update({ id: sessionId, tenantId }, update);
    }

    async changeStateFrom(
        tenantId: string,
        sessionId: string,
        from: readonly SessionStatus[],
        update: SessionStateUpdate,
    ): Promise<boolean> {
        if (from.length === 0) return false;
        const result = await this.sessions.update(
            { id: sessionId, tenantId, status: In([...from]) },
            update,
        );
        return (result.affected ?? 0) > 0;
    }

    async findCredentialOffer(
        tenantId: string,
        sessionId: string,
    ): Promise<SessionCredentialOffer | null> {
        const session = await this.sessions.findOne({
            where: { id: sessionId, tenantId },
            select: { id: true, offer: true, status: true, expiresAt: true },
            loadEagerRelations: false,
        });
        return session
            ? {
                  offer: session.offer ?? null,
                  status: session.status,
                  ...(session.expiresAt
                      ? { expiresAt: session.expiresAt }
                      : {}),
              }
            : null;
    }

    async consumeCredentialOffer(
        tenantId: string,
        sessionId: string,
    ): Promise<boolean> {
        const result = await this.sessions.update(
            { id: sessionId, tenantId, offer: Not(IsNull()) },
            {
                offer: null,
                consumedAt: () => `COALESCE("consumedAt", CURRENT_TIMESTAMP)`,
            },
        );
        return (result.affected ?? 0) > 0;
    }
}
