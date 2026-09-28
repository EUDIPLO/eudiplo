import type { UpdateSessionForTenant } from "../../../session/application/update-session-for-tenant.js";
import type { SessionData } from "../../../session/domain/session-data.js";

export class RetrievePresentationRequest {
    constructor(
        private readonly updateSession: Pick<UpdateSessionForTenant, "execute">,
    ) {}

    async execute(
        session: SessionData,
        origin: string,
        noRedirect: boolean,
        generate: (
            sessionId: string,
            origin: string,
            noRedirect: boolean,
        ) => Promise<string>,
    ): Promise<string> {
        if (session.requestObject) {
            if (noRedirect) {
                await this.updateSession.execute(session.tenantId, session.id, {
                    redirectUri: null,
                });
            }
            return session.requestObject;
        }

        const requestObject = await generate(session.id, origin, noRedirect);
        await this.updateSession.execute(session.tenantId, session.id, {
            requestObject,
        });
        return requestObject;
    }
}
