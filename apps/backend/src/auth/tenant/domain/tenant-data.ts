import type { SessionCleanupMode } from "../../../session/domain/session-retention.js";
import { NotFoundError } from "../../../shared/domain/not-found-error.js";
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
    defaultAccessKeyChainId?: string | null;
    clients?: ClientData[];
}
export type TenantUpdate = Partial<Omit<TenantData, "id" | "clients">>;
export class TenantNotFound extends NotFoundError {
    constructor(readonly tenantId: string) {
        super(`Tenant '${tenantId}' not found`);
        this.name = "TenantNotFound";
    }
}

/**
 * The tenant fields a configuration document writes. A document without
 * `defaultAccessKeyChainId` removes it, so the tenant picks its access key
 * chain by rule again; the other omitted fields keep their stored value.
 */
export function tenantDocumentUpdate<
    T extends { defaultAccessKeyChainId?: string | null },
>(spec: T): T & { defaultAccessKeyChainId: string | null } {
    return {
        ...spec,
        defaultAccessKeyChainId: spec.defaultAccessKeyChainId ?? null,
    };
}
