import type { InteractiveAuthSession } from "../domain/interactive-auth-session.js";

export type NewInteractiveAuthSession = Omit<
    InteractiveAuthSession,
    "id" | "createdAt" | "updatedAt"
>;

export type InteractiveAuthSessionUpdate = Partial<
    Omit<InteractiveAuthSession, "id" | "authSession" | "tenantId">
>;

/** Persistence of Interactive Authorization Endpoint sessions. */
export interface InteractiveAuthSessionRepository {
    create(session: NewInteractiveAuthSession): Promise<void>;
    findForTenant(
        tenantId: string,
        authSession: string,
    ): Promise<InteractiveAuthSession | null>;
    /** Update by primary key. */
    update(id: string, changes: InteractiveAuthSessionUpdate): Promise<void>;
    /** Update by `auth_session`; returns whether a session was updated. */
    updateForTenant(
        tenantId: string,
        authSession: string,
        changes: InteractiveAuthSessionUpdate,
    ): Promise<boolean>;
    delete(session: InteractiveAuthSession): Promise<void>;
}

export const INTERACTIVE_AUTH_SESSION_REPOSITORY = Symbol(
    "INTERACTIVE_AUTH_SESSION_REPOSITORY",
);
