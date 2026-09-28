import type { SessionData } from "../domain/session-data.js";
import type { SessionRepository } from "../ports/session.repository.js";
import { SessionNotFound } from "./session-errors.js";

export class GetSessionForWalletRequest {
    constructor(
        private readonly sessions: Pick<
            SessionRepository,
            "findForWalletRequest"
        >,
    ) {}

    async execute(walletNonce: string): Promise<SessionData> {
        const session = await this.sessions.findForWalletRequest(walletNonce);
        if (!session) throw new SessionNotFound();
        return session;
    }
}
