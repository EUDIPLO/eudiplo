import type { WebhookEndpointData } from "../domain/webhook-endpoint-data.js";

export const WEBHOOK_ENDPOINT_REPOSITORY = Symbol(
    "WEBHOOK_ENDPOINT_REPOSITORY",
);
export interface WebhookEndpointRepository {
    listForTenant(tenantId: string): Promise<WebhookEndpointData[]>;
    findForTenant(
        tenantId: string,
        id: string,
    ): Promise<WebhookEndpointData | null>;
    /** Whether the tenant has one with this ID, without loading it. */
    existsForTenant(tenantId: string, id: string): Promise<boolean>;
    /**
     * Stores a new one; never replaces a stored one, also not under
     * concurrent creates of the same ID.
     * @throws ResourceIdTaken when the tenant already has one with this ID.
     */
    create(config: WebhookEndpointData): Promise<WebhookEndpointData>;
    /** Stores it, replacing a stored one with the same ID. */
    save(config: WebhookEndpointData): Promise<WebhookEndpointData>;
    deleteForTenant(tenantId: string, id: string): Promise<void>;
}
