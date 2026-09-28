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
    save(config: WebhookEndpointData): Promise<WebhookEndpointData>;
    deleteForTenant(tenantId: string, id: string): Promise<void>;
}
