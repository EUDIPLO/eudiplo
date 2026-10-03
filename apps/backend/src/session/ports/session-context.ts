export const SESSION_CONTEXT = Symbol("SESSION_CONTEXT");

/**
 * Correlates the current request with the session it resolved, so its logs
 * and traces can be found by session id.
 */
export interface SessionContext {
    bind(session: { id: string; tenantId: string }): void;
}

/** For flows without request correlation, e.g. tests. */
export const NO_SESSION_CONTEXT: SessionContext = { bind: () => undefined };
