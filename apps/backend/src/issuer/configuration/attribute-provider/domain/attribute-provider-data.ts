import type { WebhookConfiguration } from "../../../../webhook/domain/webhook-configuration.js";

/** Stored tenant-owned attribute-provider configuration, without persistence relations. */
export interface AttributeProviderData {
    id: string;
    tenantId: string;
    name: string;
    description?: string | null;
    url: string;
    auth: WebhookConfiguration["auth"];
}
