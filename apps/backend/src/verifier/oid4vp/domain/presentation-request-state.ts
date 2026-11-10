import type { SessionData } from "../../../session/domain/session-data.js";

/**
 * The `state` of the session's OID4VP request, which the response must
 * return: the wallet-facing id (walletNonce, or the session ID for sessions
 * from before it existed). Requests over the DC API carry no `state`.
 */
export function presentationRequestState(
    session: Pick<SessionData, "id" | "walletNonce" | "useDcApi">,
): string | undefined {
    return session.useDcApi ? undefined : (session.walletNonce ?? session.id);
}
