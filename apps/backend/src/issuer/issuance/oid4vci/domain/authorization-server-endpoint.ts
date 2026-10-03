import type { ManagedAuthorizationServerData } from "../../../configuration/issuance/domain/issuance-configuration.js";

/** An authorization server hosted by EUDIPLO for the tenant. */
export type HostedAuthorizationServer =
    | { kind: "built-in" }
    | { kind: "oid4vp"; id: string }
    | { kind: "chained-as" };

/** An authorization server entry that can be advertised to wallets. */
export type AuthorizationServerEndpoint =
    | { kind: "external"; issuer: string }
    | HostedAuthorizationServer;

type ConfiguredServer = ManagedAuthorizationServerData & {
    issuer?: unknown;
    upstream?: unknown;
};

/**
 * Classifies a configured authorization server entry. Returns `undefined` for
 * entries that cannot be advertised (for example a chained server without
 * upstream configuration). The `enabled` flag is not evaluated here.
 */
export function toAuthorizationServerEndpoint(
    server: ManagedAuthorizationServerData,
): AuthorizationServerEndpoint | undefined {
    const entry = server as ConfiguredServer;
    switch (entry.type) {
        case "external":
            return typeof entry.issuer === "string" && entry.issuer.length > 0
                ? { kind: "external", issuer: entry.issuer }
                : undefined;
        case "oid4vp":
            return typeof entry.id === "string" && entry.id.length > 0
                ? { kind: "oid4vp", id: entry.id }
                : undefined;
        case "built-in":
            return { kind: "built-in" };
        case "chained":
            return entry.upstream ? { kind: "chained-as" } : undefined;
        default:
            return undefined;
    }
}

/**
 * The issuer identifier wallets use for an authorization server.
 * @param credentialIssuer The tenant's credential issuer URL
 *   (`<PUBLIC_URL>/issuers/<tenantId>`), which is also the built-in AS issuer.
 */
export function authorizationServerIssuer(
    endpoint: AuthorizationServerEndpoint,
    credentialIssuer: string,
): string {
    switch (endpoint.kind) {
        case "external":
            return endpoint.issuer;
        case "built-in":
            return credentialIssuer;
        case "oid4vp":
            return `${credentialIssuer}/authorization-servers/${endpoint.id}`;
        case "chained-as":
            return `${credentialIssuer}/chained-as`;
    }
}
