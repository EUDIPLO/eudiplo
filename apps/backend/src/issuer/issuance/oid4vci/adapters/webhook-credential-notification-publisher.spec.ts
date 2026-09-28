import { describe, expect, it, vi } from "vitest";
import { WebhookCredentialNotificationPublisher } from "./webhook-credential-notification-publisher.js";

describe("WebhookCredentialNotificationPublisher", () => {
    it("forwards the configured endpoint and persisted notification", async () => {
        const sendWebhookNotification = vi.fn().mockResolvedValue(undefined);
        const publisher = new WebhookCredentialNotificationPublisher({
            sendWebhookNotification,
        } as never);
        const configuration = {
            url: "https://notify.example",
            auth: { type: "none" },
        };
        const session = { id: "session-1", tenantId: "tenant-1" } as never;
        const notification = {
            id: "notification-1",
            event: "credential_accepted",
        } as never;

        await expect(
            publisher.publish(configuration, session, notification),
        ).resolves.toBeUndefined();
        expect(sendWebhookNotification).toHaveBeenCalledExactlyOnceWith(
            configuration,
            session,
            notification,
        );
    });

    it("preserves webhook delivery failures", async () => {
        const failure = new Error("delivery failed");
        const publisher = new WebhookCredentialNotificationPublisher({
            sendWebhookNotification: vi.fn().mockRejectedValue(failure),
        } as never);

        await expect(
            publisher.publish(
                { url: "https://notify.example", auth: { type: "none" } },
                { id: "session-1", tenantId: "tenant-1" } as never,
                { id: "notification-1" } as never,
            ),
        ).rejects.toBe(failure);
    });
});
