import type { OidcClient } from "../domain/oidc-client.js";

/**
 * Persistence of OpenID Connect clients. Every operation is scoped to a
 * tenant; lookups return `null` when nothing matches.
 */
export interface OidcClientRepository {
    listForTenant(tenantId: string): Promise<OidcClient[]>;
    findForTenant(tenantId: string, id: string): Promise<OidcClient | null>;
    /** Whether the tenant has at least one client. */
    existsForTenant(tenantId: string): Promise<boolean>;
    /** Clients whose scopes use the presentation config. */
    listUsingPresentationConfig(
        tenantId: string,
        presentationConfigId: string,
    ): Promise<OidcClient[]>;
    save(client: OidcClient): Promise<OidcClient>;
    deleteForTenant(tenantId: string, id: string): Promise<void>;
    /** Record the use of a secret without touching the rest of the client. */
    recordSecretUse(
        tenantId: string,
        clientId: string,
        secretId: string,
        at: Date,
    ): Promise<void>;
}

export const OIDC_CLIENT_REPOSITORY = Symbol("OIDC_CLIENT_REPOSITORY");
