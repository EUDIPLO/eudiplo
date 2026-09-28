import type { WebhookConfiguration } from "../../../../webhook/domain/webhook-configuration.js";

/** Stored tenant-owned webhook-endpoint configuration, without persistence relations. */
export interface WebhookEndpointData {
    id: string;
    tenantId: string;
    name: string;
    description?: string | null;
    url: string;
    auth: WebhookConfiguration["auth"];
}
