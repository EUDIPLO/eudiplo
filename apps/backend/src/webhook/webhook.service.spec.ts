import { of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../session/domain/session-data.js";
import { WebhookService } from "./webhook.service.js";

describe("WebhookService presentation payloads", () => {
    const webhook = {
        url: "https://result.example/hook",
        auth: { type: "none" as const },
        includeRawTokensFor: ["pid"],
    };
    const session = {
        id: "session-1",
        tenantId: "tenant-1",
        transaction_data: [{ type: "payment" }],
    } as unknown as SessionData;

    function setup() {
        const post = vi.fn().mockReturnValue(of({ data: {} }));
        const policy = {
            assertSafeUrl: vi.fn().mockResolvedValue(undefined),
            safeLookup: vi.fn(),
        };
        const service = new WebhookService(
            { post } as never,
            policy as never,
            { setContext: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
        );
        return { service, post, policy };
    }

    it("adds status and outcome to a completed presentation, keeping the existing fields", async () => {
        const { service, post } = setup();
        const outcome = {
            result: "success" as const,
            credentials: [{ id: "pid", verified: true }],
        };

        await service.sendWebhook({
            webhook,
            session,
            credentials: [{ id: "pid", values: [{ given_name: "Erika" }] }],
            rawPresentationPayload: { vp_token: { pid: ["raw-sd-jwt"] } },
            result: { status: "completed", outcome },
        });

        expect(post.mock.calls[0][1]).toEqual({
            status: "completed",
            outcome,
            credentials: [
                {
                    id: "pid",
                    values: [{ given_name: "Erika" }],
                    rawToken: "raw-sd-jwt",
                },
            ],
            session: "session-1",
            transaction_data: [{ type: "payment" }],
        });
    });

    it("sends a failed presentation without credentials", async () => {
        const { service, post } = setup();
        const outcome = {
            result: "failed" as const,
            error: "trust_chain_not_trusted",
            message: "The credential issuer is not in the trusted list.",
        };

        await service.sendWebhook({
            webhook,
            session,
            result: { status: "failed", outcome },
        });

        const payload = JSON.parse(JSON.stringify(post.mock.calls[0][1]));
        expect(payload).toEqual({
            status: "failed",
            outcome,
            session: "session-1",
            transaction_data: [{ type: "payment" }],
        });
    });

    it("leaves the claims webhook payload unchanged", async () => {
        const { service, post } = setup();

        await service.sendWebhook({
            webhook,
            session,
        });

        expect(Object.keys(post.mock.calls[0][1])).toEqual([
            "credentials",
            "session",
            "transaction_data",
        ]);
    });

    it("adds the caller reference to every webhook of a session that has one", async () => {
        const { service, post } = setup();
        const referenced = {
            ...session,
            reference: "order-4711",
        } as unknown as SessionData;

        await service.sendWebhook({
            webhook,
            session: referenced as never,
        });
        await service.sendWebhookNotification(webhook, referenced as never, {
            id: "n-1",
            credentialConfigurationId: "pid",
        });
        await service.sendClaimsWebhook({
            webhook,
            session: "session-1",
            reference: "order-4711",
            credentialConfigurationId: "pid",
        });

        for (const [, payload] of post.mock.calls)
            expect(payload).toMatchObject({
                session: "session-1",
                reference: "order-4711",
            });
    });

    it("omits the reference when the session has none", async () => {
        const { service, post } = setup();

        await service.sendWebhookNotification(webhook, session as never, {
            id: "n-1",
            credentialConfigurationId: "pid",
        });
        await service.sendClaimsWebhook({
            webhook,
            session: "session-1",
            credentialConfigurationId: "pid",
        });

        for (const [, payload] of post.mock.calls)
            expect(payload).not.toHaveProperty("reference");
    });

    it("reports a cancelled session with its reference and reason", async () => {
        const { service, post } = setup();

        await service.sendSessionCancelledWebhook(
            webhook,
            { ...session, reference: "order-4711" } as SessionData,
            "sent to wrong recipient",
        );

        expect(post.mock.calls[0][1]).toEqual({
            status: "cancelled",
            session: "session-1",
            reference: "order-4711",
            reason: "sent to wrong recipient",
        });
    });

    it("bounds every webhook request and follows redirects itself", async () => {
        const { service, post, policy } = setup();
        const webhook = {
            url: "https://result.example/hook",
            auth: {
                type: "apiKey" as const,
                config: { headerName: "x-api-key", value: "secret" },
            },
        };

        await service.sendWebhook({ webhook, session });
        await service.sendWebhookNotification(webhook, session, {
            id: "n-1",
            credentialConfigurationId: "pid",
        });
        await service.sendSessionCancelledWebhook(webhook, session);
        await service.sendClaimsWebhook({
            webhook,
            session: "session-1",
            credentialConfigurationId: "pid",
        });

        expect(post).toHaveBeenCalledTimes(4);
        for (const [, , options] of post.mock.calls)
            expect(options).toMatchObject({
                headers: { "x-api-key": "secret" },
                lookup: policy.safeLookup,
                maxRedirects: 0,
                signal: expect.any(AbortSignal),
                maxContentLength: 5 * 1024 * 1024,
                httpAgent: false,
                httpsAgent: false,
            });
    });

    it("omits the reason of a cancelled session when none was given", async () => {
        const { service, post } = setup();

        await service.sendSessionCancelledWebhook(webhook, session);

        expect(post.mock.calls[0][1]).toEqual({
            status: "cancelled",
            session: "session-1",
        });
    });
});
