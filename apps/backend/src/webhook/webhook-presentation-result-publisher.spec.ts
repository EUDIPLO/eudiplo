import { describe, expect, it, vi } from "vitest";
import { WebhookPresentationResultPublisher } from "./webhook-presentation-result-publisher.js";

describe("WebhookPresentationResultPublisher", () => {
    it("returns only the redirect consumed by presentation flows", async () => {
        const sendWebhook = vi.fn().mockResolvedValue({
            redirectUri: "https://wallet.example/done",
            extra: "ignored",
        });
        const publisher = new WebhookPresentationResultPublisher({
            sendWebhook,
        } as never);
        const values = {
            webhook: { url: "https://result.example", auth: { type: "none" } },
            session: { id: "session-1", tenantId: "tenant-1" },
            credentials: [{ id: "pid" }],
            rawPresentationPayload: { vp_token: "raw" },
        } as never;

        await expect(publisher.publish(values)).resolves.toEqual({
            redirectUri: "https://wallet.example/done",
        });
        expect(sendWebhook).toHaveBeenCalledWith({
            ...values,
            expectResponse: false,
        });
    });

    it("returns an empty result when the webhook has no redirect", async () => {
        const publisher = new WebhookPresentationResultPublisher({
            sendWebhook: vi.fn().mockResolvedValue({}),
        } as never);

        await expect(
            publisher.publish({
                webhook: {
                    url: "https://result.example",
                    auth: { type: "none" },
                },
                session: { id: "session-1", tenantId: "tenant-1" } as never,
            }),
        ).resolves.toEqual({});
    });
});
