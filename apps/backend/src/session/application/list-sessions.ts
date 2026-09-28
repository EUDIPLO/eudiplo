import type { SessionListQuery, SessionPage } from "../domain/session-list.js";
import type { SessionRepository } from "../ports/session.repository.js";

export class ListSessions {
    constructor(
        private readonly sessions: Pick<SessionRepository, "listForTenant">,
    ) {}

    async execute(
        tenantId: string,
        query: SessionListQuery,
    ): Promise<SessionPage> {
        const { items, total } = await this.sessions.listForTenant(
            tenantId,
            query,
        );
        return {
            items,
            total,
            page: query.page,
            pageSize: query.pageSize,
            totalPages: Math.ceil(total / query.pageSize),
        };
    }
}
