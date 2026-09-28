export const WebhookAuthType = {
    API_KEY: "apiKey",
    NONE: "none",
} as const;
export type WebhookAuthType =
    (typeof WebhookAuthType)[keyof typeof WebhookAuthType];
export interface WebhookConfiguration {
    url: string;
    auth:
        | {
              type: typeof WebhookAuthType.API_KEY;
              config: { headerName: string; value: string };
          }
        | { type: typeof WebhookAuthType.NONE };
    includeRawTokensFor?: string[];
}
