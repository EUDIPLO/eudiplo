import type { Repository } from "typeorm";
import type { InteractiveAuthSessionEntity } from "../../entities/interactive-auth-session.entity.js";
import type { InteractiveAuthSession } from "../domain/interactive-auth-session.js";
import type {
    InteractiveAuthSessionRepository,
    InteractiveAuthSessionUpdate,
    NewInteractiveAuthSession,
} from "../ports/interactive-auth-session.repository.js";

export class TypeOrmInteractiveAuthSessionRepository
    implements InteractiveAuthSessionRepository
{
    constructor(
        private readonly sessions: Repository<InteractiveAuthSessionEntity>,
    ) {}

    async create(session: NewInteractiveAuthSession): Promise<void> {
        await this.sessions.save(session);
    }

    findForTenant(tenantId: string, authSession: string) {
        return this.sessions.findOne({ where: { authSession, tenantId } });
    }

    async update(
        id: string,
        changes: InteractiveAuthSessionUpdate,
    ): Promise<void> {
        await this.sessions.update(id, changes);
    }

    async updateForTenant(
        tenantId: string,
        authSession: string,
        changes: InteractiveAuthSessionUpdate,
    ): Promise<boolean> {
        const result = await this.sessions.update(
            { authSession, tenantId },
            changes,
        );
        return (result.affected ?? 0) > 0;
    }

    async delete(session: InteractiveAuthSession): Promise<void> {
        await this.sessions.remove(session as InteractiveAuthSessionEntity);
    }
}
