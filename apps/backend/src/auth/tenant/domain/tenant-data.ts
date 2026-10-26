import type { SessionCleanupMode } from "../../../session/domain/session-retention.js";
import { NotFoundError } from "../../../shared/domain/not-found-error.js";
import type { ClientData } from "../../client/domain/client-data.js";

/**
 * The tenant's key chain per usage type, used where no configuration names
 * one. Only `access` exists so far.
 */
export interface DefaultKeyChains {
    access?: string;
}

/** The usage types `defaultKeyChains` has an entry for. */
export const DEFAULT_KEY_CHAIN_ENTRIES = ["access"] as const;

/** The map, or null when it names no key chain. */
export function defaultKeyChainsOrNull(
    value: DefaultKeyChains | null | undefined,
): DefaultKeyChains | null {
    return value && Object.keys(value).length > 0 ? value : null;
}

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
    defaultKeyChains?: DefaultKeyChains | null;
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
 * `defaultKeyChains` removes them, so the tenant picks its key chains by rule
 * again; the other omitted fields keep their stored value.
 */
export function tenantDocumentUpdate<
    T extends { defaultKeyChains?: DefaultKeyChains | null },
>(spec: T): T & { defaultKeyChains: DefaultKeyChains | null } {
    return {
        ...spec,
        defaultKeyChains: defaultKeyChainsOrNull(spec.defaultKeyChains),
    };
}
