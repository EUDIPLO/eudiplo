import type { IssuanceConfiguration } from "../../../../configuration/issuance/domain/issuance-configuration.js";

/** Tenant configuration the built-in authorization server depends on. */
export interface BuiltInAuthorizationServerConfiguration {
    issuanceConfiguration(tenantId: string): Promise<IssuanceConfiguration>;
    /** Whether the tenant's status list configuration enables aggregation. */
    statusListAggregationEnabled(tenantId: string): Promise<boolean>;
}

export const BUILT_IN_AUTHORIZATION_SERVER_CONFIGURATION = Symbol(
    "BUILT_IN_AUTHORIZATION_SERVER_CONFIGURATION",
);
