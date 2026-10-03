import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../session/domain/session-data.js";
import { SessionStatus } from "../session/domain/session-state.js";
import { WebhookPresentationResultPublisher } from "./webhook-presentation-result-publisher.js";

describe("WebhookPresentationResultPublisher", () => {
    const webhook = {
        url: "https://result.example",
        auth: { type: "none" as const },
    };
    const session = { id: "session-1", tenantId: "tenant-1" } as SessionData;

    it("returns only the redirect consumed by presentation flows", async () => {
        const sendWebhook = vi.fn().mockResolvedValue({
            redirectUri: "https://wallet.example/done",
            extra: "ignored",
        });
        const publisher = new WebhookPresentationResultPublisher({
            sendWebhook,
        } as never);
        const outcome = {
            result: "success" as const,
            credentials: [{ id: "pid", verified: true }],
        };

        await expect(
            publisher.publish({
                webhook,
                session,
                status: SessionStatus.Completed,
                outcome,
                credentials: [{ id: "pid" }],
                rawPresentationPayload: { vp_token: "raw" },
            }),
        ).resolves.toEqual({ redirectUri: "https://wallet.example/done" });
        expect(sendWebhook).toHaveBeenCalledWith({
            webhook,
            session,
            result: { status: "completed", outcome },
            credentials: [{ id: "pid" }],
            rawPresentationPayload: { vp_token: "raw" },
            expectResponse: false,
        });
    });

    it("sends failures with status and outcome but without credentials", async () => {
        const sendWebhook = vi.fn().mockResolvedValue({});
        const publisher = new WebhookPresentationResultPublisher({
            sendWebhook,
        } as never);
        const outcome = {
            result: "failed" as const,
            error: "access_denied",
            message: "Wallet error: access_denied",
        };

        await expect(
            publisher.publish({
                webhook,
                session,
                status: SessionStatus.Failed,
                outcome,
                // Ignored even if a caller bypasses the type.
                ...({ credentials: [{ id: "pid" }] } as object),
            }),
        ).resolves.toEqual({});
        expect(sendWebhook).toHaveBeenCalledExactlyOnceWith({
            webhook,
            session,
            result: { status: "failed", outcome },
            expectResponse: false,
        });
    });
});
