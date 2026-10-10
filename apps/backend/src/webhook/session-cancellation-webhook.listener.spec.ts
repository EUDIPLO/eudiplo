import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../session/domain/session-data.js";
import { SessionCancellationWebhookListener } from "./session-cancellation-webhook.listener.js";

const event = {
    sessionId: "session-1",
    tenantId: "tenant-1",
    reason: "sent to wrong recipient",
};

function setup(session: Partial<SessionData>) {
    const stored = { id: "session-1", tenantId: "tenant-1", ...session };
    const sessions = { getForTenant: vi.fn().mockResolvedValue(stored) };
    const webhooks = {
        sendSessionCancelledWebhook: vi.fn().mockResolvedValue(undefined),
    };
    const endpoints = {
        findForTenant: vi.fn().mockResolvedValue({
            url: "https://endpoint.example/hook",
            auth: { type: "none" },
        }),
    };
    const logger = { setContext: vi.fn(), warn: vi.fn() };
    const listener = new SessionCancellationWebhookListener(
        sessions as never,
        webhooks as never,
        endpoints as never,
        logger as never,
    );
    return { listener, stored, sessions, webhooks, endpoints, logger };
}

describe("SessionCancellationWebhookListener", () => {
    it("prefers the webhook passed with the presentation request", async () => {
        const parsedWebhook = {
            url: "https://request.example/hook",
            auth: { type: "none" as const },
        };
        const { listener, stored, webhooks, endpoints } = setup({
            parsedWebhook,
            webhookEndpointId: "endpoint-1",
        });

        await listener.handleSessionCancelled(event);

        expect(endpoints.findForTenant).not.toHaveBeenCalled();
        expect(webhooks.sendSessionCancelledWebhook).toHaveBeenCalledWith(
            parsedWebhook,
            stored,
            "sent to wrong recipient",
        );
    });

    it("falls back to the webhook endpoint of the session's tenant", async () => {
        const { listener, webhooks, endpoints } = setup({
            webhookEndpointId: "endpoint-1",
        });

        await listener.handleSessionCancelled(event);

        expect(endpoints.findForTenant).toHaveBeenCalledWith(
            "tenant-1",
            "endpoint-1",
        );
        expect(webhooks.sendSessionCancelledWebhook).toHaveBeenCalledWith(
            { url: "https://endpoint.example/hook", auth: { type: "none" } },
            expect.objectContaining({ id: "session-1" }),
            "sent to wrong recipient",
        );
    });

    it("sends nothing when the stored webhook endpoint was deleted", async () => {
        const { listener, webhooks, endpoints, logger } = setup({
            webhookEndpointId: "endpoint-1",
        });
        endpoints.findForTenant.mockResolvedValue(undefined);

        await listener.handleSessionCancelled(event);

        expect(webhooks.sendSessionCancelledWebhook).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("reads the session within the tenant of the event", async () => {
        const { listener, sessions } = setup({});

        await listener.handleSessionCancelled(event);

        expect(sessions.getForTenant).toHaveBeenCalledWith(
            "tenant-1",
            "session-1",
        );
    });

    it("sends nothing when the session has no webhook", async () => {
        const { listener, webhooks } = setup({});

        await listener.handleSessionCancelled(event);

        expect(webhooks.sendSessionCancelledWebhook).not.toHaveBeenCalled();
    });

    it("only logs a delivery error, since the cancellation is already persisted", async () => {
        const { listener, webhooks, logger } = setup({
            webhookEndpointId: "endpoint-1",
        });
        webhooks.sendSessionCancelledWebhook.mockRejectedValue(
            new Error("connection refused"),
        );

        await expect(
            listener.handleSessionCancelled(event),
        ).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledOnce();
    });
});
