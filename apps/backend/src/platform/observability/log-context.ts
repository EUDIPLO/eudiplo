import { AsyncLocalStorage } from "node:async_hooks";
import { type Span, trace } from "@opentelemetry/api";

/** Fields added to every log line of a request once it is bound to a session. */
export interface LogContextFields {
    sessionId?: string;
    tenantId?: string;
}

interface LogContext {
    fields: LogContextFields;
    /** The span of the incoming request, i.e. the root of the request's trace. */
    requestSpan?: Span;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Run `fn` with an empty log context. Everything `fn` starts asynchronously
 * shares the context, so a session bound later in the request applies to all
 * following log lines of that request.
 */
export function runWithLogContext<T>(fn: () => T): T {
    return storage.run({ fields: {}, requestSpan: trace.getActiveSpan() }, fn);
}

/**
 * Bind the request to a session: later log lines carry `sessionId` and
 * `tenantId`, and the request span and the current span get `session.id` and
 * `session.tenantId`. A request stays bound to the first session it resolved,
 * e.g. the issuance session of a chained authorization; the current span
 * still gets the session it handles.
 */
export function bindSessionToLogContext(session: {
    id: string;
    tenantId: string;
}): void {
    const attributes = {
        "session.id": session.id,
        "session.tenantId": session.tenantId,
    };
    const context = storage.getStore();
    const activeSpan = trace.getActiveSpan();
    if (context && !context.fields.sessionId) {
        context.fields = { sessionId: session.id, tenantId: session.tenantId };
        context.requestSpan?.setAttributes(attributes);
    }
    if (activeSpan && activeSpan !== context?.requestSpan)
        activeSpan.setAttributes(attributes);
}

/** Pino `mixin`: the session fields of the current request, if bound. */
export function logContextMixin(): LogContextFields {
    return { ...storage.getStore()?.fields };
}
