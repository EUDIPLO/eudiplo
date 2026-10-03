import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
    type FindOptionsWhere,
    In,
    IsNull,
    LessThan,
    MoreThan,
    Not,
    Repository,
} from "typeorm";
import type { QueryDeepPartialEntity } from "typeorm/query-builder/QueryPartialEntity.js";
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
    OPEN_SESSION_STATUSES,
    type SessionLifecycleContext,
    type SessionStateUpdate,
    SessionStatus,
} from "../domain/session-state.js";
import { Session } from "../entities/session.entity.js";
import type {
    SessionCount,
    SessionCredentialOffer,
    SessionRepository,
} from "../ports/session.repository.js";

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
    findByAuthorizationCode(tenantId: string, authorization_code: string) {
        return this.findSession({ tenantId, authorization_code });
    }
    findByRefreshToken(tenantId: string, refresh_token: string) {
        return this.findSession({ tenantId, refresh_token });
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
        const { page, pageSize, status, type, sortBy, sortOrder } = query;
        const where: FindOptionsWhere<Session> = {
            tenantId,
            ...typeWhere(type),
        };
        if (status) where.status = status;
        const sessions = await this.sessions.find({
            select: {
                id: true,
                status: true,
                createdAt: true,
                requestId: true,
            },
            where,
            order: {
                [sortBy ?? "updatedAt"]: sortOrder === "asc" ? "ASC" : "DESC",
            },
            skip: (page - 1) * pageSize,
            take: pageSize,
            loadEagerRelations: false,
        });
        // Count rows independently: projected nullable columns can be excluded
        // by TypeORM's DISTINCT count for findAndCount.
        const total = await this.sessions.countBy(where);
        return {
            items: sessions.map(({ id, status, createdAt, requestId }) => ({
                id,
                status,
                createdAt,
                requestId: requestId ?? null,
            })),
            total,
        };
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
        const rows: {
            tenantId: string;
            issuance: number | string | boolean;
            status: SessionStatus;
            count: number | string;
        }[] = await this.sessions
            .createQueryBuilder("s")
            .select("s.tenantId", "tenantId")
            .addSelect(
                "CASE WHEN s.requestId IS NULL THEN 1 ELSE 0 END",
                "issuance",
            )
            .addSelect("s.status", "status")
            .addSelect("COUNT(*)", "count")
            .groupBy("s.tenantId")
            .addGroupBy("CASE WHEN s.requestId IS NULL THEN 1 ELSE 0 END")
            .addGroupBy("s.status")
            .getRawMany();
        return rows.map((row) => ({
            tenantId: row.tenantId,
            kind: Number(row.issuance) === 1 ? "issuance" : "verification",
            status: row.status,
            count: Number(row.count),
        }));
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
        const result = await this.sessions
            .createQueryBuilder()
            .update()
            .set({
                credentials: () => "NULL",
                credentialPayload: () => "NULL",
                auth_queries: () => "NULL",
                offer: () => "NULL",
                requestObject: () => "NULL",
                responseEncryptionPrivateJwk: () => "NULL",
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
