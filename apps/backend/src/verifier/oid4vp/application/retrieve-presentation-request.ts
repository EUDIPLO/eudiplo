import type { ChangeSessionState } from "../../../session/application/change-session-state.js";
import type { SessionStore } from "../../../session/application/session-store.js";
import type { SessionData } from "../../../session/domain/session-data.js";
import { SessionStatus } from "../../../session/domain/session-state.js";
import { assertSessionUsable } from "../../../session/domain/session-usability.js";

export class RetrievePresentationRequest {
    constructor(
        private readonly updateSession: Pick<SessionStore, "updateForTenant">,
        private readonly state: Pick<ChangeSessionState, "executeFrom">,
    ) {}

    /**
     * Serves the request object to the wallet and marks an active session as
     * fetched.
     * @throws SessionNotUsable when the request expired or is already finished
     */
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
        assertSessionUsable(session, new Date());

        let requestObject = session.requestObject;
        if (requestObject) {
            if (noRedirect) {
                await this.updateSession.updateForTenant(
                    session.tenantId,
                    session.id,
                    {
                        redirectUri: null,
                    },
                );
            }
        } else {
            requestObject = await generate(session.id, origin, noRedirect);
            await this.updateSession.updateForTenant(
                session.tenantId,
                session.id,
                {
                    requestObject,
                },
            );
        }

        await this.state.executeFrom(
            session,
            [SessionStatus.Active],
            SessionStatus.Fetched,
        );
        return requestObject;
    }
}
