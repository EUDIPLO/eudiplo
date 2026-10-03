import { bindSessionToLogContext } from "../../platform/observability/log-context.js";
import type { SessionContext } from "../ports/session-context.js";

/** Binds the session to the request's log context and trace. */
export class RequestSessionContext implements SessionContext {
    bind(session: { id: string; tenantId: string }): void {
        bindSessionToLogContext(session);
    }
}
