import type { SessionStatus } from "./session-state.js";

/** Presentation sessions have a `requestId`; issuance sessions have none. */
export type SessionType = "issuance" | "presentation";

export interface SessionListQuery {
    page: number;
    pageSize: number;
    status?: SessionStatus;
    type?: SessionType;
    sortBy?: "id" | "status" | "createdAt" | "requestId";
    sortOrder?: "asc" | "desc";
}

export interface SessionSummary {
    id: string;
    status: SessionStatus;
    createdAt: Date;
    requestId: string | null;
}

export interface SessionPage {
    items: SessionSummary[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}
