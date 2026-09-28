import type { SessionCleanupMode } from "../../../session/domain/session-retention.js";
import type { ClientData } from "../../client/domain/client-data.js";

export interface TenantData {
    id: string;
    name: string;
    description?: string | null;
    status: "active" | null;
    sessionConfig?: {
        ttlSeconds?: number;
        cleanupMode?: SessionCleanupMode;
    } | null;
    statusListConfig?: {
        capacity?: number;
        bits?: 1 | 2 | 4 | 8;
        ttl?: number;
        immediateUpdate?: boolean;
        enableAggregation?: boolean;
    } | null;
    clients?: ClientData[];
}
export type TenantUpdate = Partial<Omit<TenantData, "id" | "clients">>;
export class TenantNotFound extends Error {
    constructor(readonly tenantId: string) {
        super(`Tenant '${tenantId}' not found`);
        this.name = "TenantNotFound";
    }
}
