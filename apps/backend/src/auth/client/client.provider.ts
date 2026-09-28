import type { ClientData, CreatedClient } from "./domain/client-data.js";
import type { CreateClient, UpdateClient } from "./schemas/client.schema.js";

export const CLIENTS_PROVIDER = "CLIENTS_PROVIDER";

export abstract class ClientsProvider {
    abstract updateClient(
        tenantId: string,
        clientId: string,
        updateClientDto: UpdateClient,
    ): unknown;

    /**
     * Rotate (regenerate) a client's secret.
     * Returns the new plain secret for one-time display.
     * @param tenantId - The tenant ID (optional for tenant managers who can rotate any client's secret)
     * @param clientId - The client ID to rotate the secret for
     */
    abstract rotateClientSecret(
        tenantId: string | null,
        clientId: string,
    ): Promise<string>;
    abstract setClientSecret(
        tenantId: string,
        clientId: string,
        secret: string,
    ): Promise<void>;

    abstract getClients(tenantId: string): Promise<ClientData[]>;
    abstract getClient(tenantId: string, clientId: string): Promise<ClientData>;

    /**
     * Get a client by its clientId only (without tenant context).
     * Used for JWT validation where we need to fetch the client's restrictions.
     * @param clientId The client ID (may be namespaced with tenant prefix for Keycloak)
     * @returns The client entity or null if not found
     */
    abstract getClientById(clientId: string): Promise<ClientData | null>;

    abstract addClient(
        tenantId: string,
        dto: CreateClient,
    ): Promise<CreatedClient>;
    abstract removeClient(tenantId: string, clientId: string): Promise<void>;
    abstract importForTenant(tenantId: string): Promise<void>;

    // Only for internal backend (not used with KC; you’ll validate JWTs instead)
    validateClientCredentials?(
        clientId: string,
        clientSecret: string,
    ): Promise<ClientData | null>;
}
