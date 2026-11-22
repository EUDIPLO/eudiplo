import type { SessionStatus } from "./session-state.js";

/** Presentation sessions have a `requestId`; issuance sessions have none. */
export type SessionType = "issuance" | "presentation";

/**
 * The {@link SessionType} of a session, from its `requestId`, as the session
 * store scopes them (`requestId IS NULL` for issuance).
 */
export function typeOfSession(session: {
    requestId?: string | null;
}): SessionType {
    return session.requestId == null ? "issuance" : "presentation";
}

/**
 * The configurations a client is limited to, per session type: its
 * `allowedPresentationConfigs` and `allowedIssuanceConfigs`. An absent or
 * empty list is no limit for that type, as for creating offers and requests.
 */
export interface SessionConfigLimits {
    /** Presentation configuration ids, the `requestId` of the sessions. */
    presentation?: readonly string[] | null;
    /** Credential configuration ids. */
    issuance?: readonly string[] | null;
}

/**
 * Whether a session is within the limits: a presentation session by its
 * `requestId`, an issuance session when every offered credential
 * configuration is allowed, as for creating the offer. An issuance session
 * without stored configuration ids (none or an empty list) is outside every
 * issuance limit.
 */
export function withinConfigLimits(
    session: {
        requestId?: string | null;
        credentialConfigurationIds?: readonly string[] | null;
    },
    limits?: SessionConfigLimits,
): boolean {
    const type = typeOfSession(session);
    const allowed = limits?.[type];
    if (!allowed?.length) return true;
    if (type === "presentation")
        return allowed.includes(session.requestId as string);
    const ids = session.credentialConfigurationIds;
    return !!ids?.length && ids.every((id) => allowed.includes(id));
}

/** Whether the limits leave out any session. */
export function hasConfigLimits(limits?: SessionConfigLimits): boolean {
    return !!(limits?.presentation?.length || limits?.issuance?.length);
}

export const SESSION_SORT_FIELDS = [
    "id",
    "status",
    "createdAt",
    "updatedAt",
    "requestId",
] as const;

export interface SessionListQuery {
    page: number;
    pageSize: number;
    /** Matches any of the listed statuses. */
    status?: SessionStatus[];
    type?: SessionType;
    createdFrom?: Date;
    createdTo?: Date;
    updatedFrom?: Date;
    updatedTo?: Date;
    /** Presentation configuration id, exact match. */
    requestId?: string;
    /** Credential configuration of an issuance session, exact match. */
    credentialConfigurationId?: string;
    failureCode?: string;
    /** Session id prefix. */
    id?: string;
    /** Free-text search, see {@link SessionSearch}. */
    q?: string;
    /**
     * Leaves out the sessions of these types that are open for a wallet
     * (`isOpenForWallet`), for callers that may only read them.
     */
    hideOpen?: readonly SessionType[];
    /** Leaves out the sessions outside the caller's limits, see {@link withinConfigLimits}. */
    configLimits?: SessionConfigLimits;
    sortBy?: (typeof SESSION_SORT_FIELDS)[number];
    sortOrder?: "asc" | "desc";
}

export interface SessionSummary {
    id: string;
    status: SessionStatus;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date | null;
    requestId: string | null;
    failureCode: string | null;
    reference: string | null;
}

export interface SessionPage {
    items: SessionSummary[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}
