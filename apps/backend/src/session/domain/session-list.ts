import type { SessionStatus } from "./session-state.js";

/** Presentation sessions have a `requestId`; issuance sessions have none. */
export type SessionType = "issuance" | "presentation";

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
