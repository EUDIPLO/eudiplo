import type { SessionData } from "../../../../../session/domain/session-data.js";
import { SessionStatus } from "../../../../../session/domain/session-state.js";
import {
    assertSessionUsable,
    SessionNotUsable,
} from "../../../../../session/domain/session-usability.js";
import { OAuthError, type OAuthErrorCode } from "./oauth-error.js";

/**
 * Rejects redeeming a credential offer (PAR with `issuer_state`, the
 * authorization endpoint, the code exchange) once the offer lifetime passed or
 * the session is finished. Tokens already issued are not affected.
 * @throws OAuthError with the given error code
 */
export function assertOfferRedeemable(
    session: Pick<SessionData, "status" | "expiresAt">,
    now: Date,
    code: OAuthErrorCode,
): void {
    try {
        assertSessionUsable(session, now);
    } catch (error) {
        if (!(error instanceof SessionNotUsable)) throw error;
        throw new OAuthError(
            code,
            error.reason === SessionStatus.Expired
                ? "The credential offer has expired"
                : "The credential offer is no longer valid",
        );
    }
}
