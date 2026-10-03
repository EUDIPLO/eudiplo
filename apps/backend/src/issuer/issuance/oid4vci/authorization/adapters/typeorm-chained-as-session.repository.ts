import { IsNull, LessThan, type Repository } from "typeorm";
import {
    type ChainedAsSession,
    ChainedAsSessionStatus,
} from "../domain/chained-as-session.js";
import { DEFAULT_REFRESH_TOKEN_LIFETIME_SECONDS } from "../domain/token-grant-rules.js";
import type {
    ChainedAsSessionRepository,
    NewChainedAsSession,
} from "../ports/chained-as-session.repository.js";
import type { ChainedAsSessionEntity } from "../shared/entities/chained-as-session.entity.js";

export class TypeOrmChainedAsSessionRepository
    implements ChainedAsSessionRepository
{
    constructor(
        private readonly sessions: Repository<ChainedAsSessionEntity>,
    ) {}

    create(session: NewChainedAsSession): ChainedAsSession {
        return this.sessions.create(session);
    }

    save(session: ChainedAsSession): Promise<ChainedAsSession> {
        return this.sessions.save(session as ChainedAsSessionEntity);
    }

    findForTenant(
        tenantId: string,
        id: string,
        status: ChainedAsSessionStatus,
    ) {
        return this.sessions.findOne({ where: { id, tenantId, status } });
    }

    findByUpstreamState(
        tenantId: string,
        upstreamState: string,
        status?: ChainedAsSessionStatus,
    ) {
        return this.sessions.findOne({
            where: status
                ? { tenantId, upstreamState, status }
                : { tenantId, upstreamState },
        });
    }

    findAuthorizedByCode(tenantId: string, authorizationCode: string) {
        return this.sessions.findOne({
            where: {
                tenantId,
                authorizationCode,
                status: ChainedAsSessionStatus.AUTHORIZED,
            },
        });
    }

    findByRefreshToken(tenantId: string, refreshToken: string) {
        return this.sessions.findOne({ where: { tenantId, refreshToken } });
    }

    findByIssuerState(tenantId: string, issuerState: string) {
        return this.sessions.findOne({ where: { tenantId, issuerState } });
    }

    async deleteExpired(now: Date): Promise<number> {
        const expired = LessThan(now);
        // Refresh tokens stored without an expiry (issued before EUDIPLO 9.0)
        // are kept for the default refresh token lifetime.
        const legacyRefreshCutoff = new Date(
            now.getTime() - DEFAULT_REFRESH_TOKEN_LIFETIME_SECONDS * 1000,
        );
        const result = await this.sessions.delete([
            { expiresAt: expired, refreshToken: IsNull() },
            { expiresAt: expired, refreshTokenExpiresAt: expired },
            {
                expiresAt: expired,
                refreshTokenExpiresAt: IsNull(),
                createdAt: LessThan(legacyRefreshCutoff),
            },
        ]);
        return result.affected || 0;
    }
}
