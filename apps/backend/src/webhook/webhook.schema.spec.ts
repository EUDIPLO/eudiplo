import { describe, expect, it } from "vitest";
import { WebhookConfigSchema } from "./webhook.schema.js";

describe("WebhookConfigSchema", () => {
    const apiKey = (headerName: string, value: string) => ({
        url: "https://hooks.example/result",
        auth: { type: "apiKey", config: { headerName, value } },
    });

    it("accepts a webhook with an API key", () => {
        expect(
            WebhookConfigSchema.safeParse(apiKey("x-api-key", "secret"))
                .success,
        ).toBe(true);
    });

    it.each([
        ["an empty URL", { url: "", auth: { type: "none" } }],
        ["an empty header name", apiKey("", "secret")],
        ["an empty API key", apiKey("x-api-key", "")],
        ["no auth", { url: "https://hooks.example/result" }],
    ])("rejects %s", (_, webhook) => {
        expect(WebhookConfigSchema.safeParse(webhook).success).toBe(false);
    });
});
