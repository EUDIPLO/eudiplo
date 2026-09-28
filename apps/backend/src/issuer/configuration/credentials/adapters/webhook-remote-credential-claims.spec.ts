import { describe, expect, it, vi } from "vitest";
import type { RemoteCredentialClaimsRequest } from "../ports/remote-credential-claims.js";
import { WebhookRemoteCredentialClaims } from "./webhook-remote-credential-claims.js";

describe("WebhookRemoteCredentialClaims", () => {
    const request: RemoteCredentialClaimsRequest = {
        webhook: { url: "https://claims.example", auth: { type: "none" } },
        session: "session-1",
        credentialConfigurationId: "pid",
        identity: {
            iss: "https://as.example",
            sub: "wallet",
            token_claims: {},
        },
        credentials: [{ id: "presented" }],
    };

    it("forwards delivery context and selects only the requested credential", async () => {
        const sendClaimsWebhook = vi.fn().mockResolvedValue({
            pid: { name: "Alice" },
            other: { name: "Bob" },
        });
        const adapter = new WebhookRemoteCredentialClaims({
            sendClaimsWebhook,
        });
        await expect(adapter.fetchClaims(request)).resolves.toEqual({
            deferred: false,
            claims: { name: "Alice" },
        });
        expect(sendClaimsWebhook).toHaveBeenCalledWith(request);
    });

    it.each([undefined, 0, 12])(
        "preserves deferred interval %s with a default of five",
        async (interval) => {
            const adapter = new WebhookRemoteCredentialClaims({
                sendClaimsWebhook: vi
                    .fn()
                    .mockResolvedValue({ deferred: true, interval }),
            });
            await expect(adapter.fetchClaims(request)).resolves.toEqual({
                deferred: true,
                interval: interval ?? 5,
            });
        },
    );

    it("preserves missing claims and delivery failures", async () => {
        const sendClaimsWebhook = vi.fn().mockResolvedValue({ other: {} });
        const adapter = new WebhookRemoteCredentialClaims({
            sendClaimsWebhook,
        });
        await expect(adapter.fetchClaims(request)).resolves.toEqual({
            deferred: false,
            claims: undefined,
        });
        const error = new Error("delivery failed");
        sendClaimsWebhook.mockRejectedValue(error);
        await expect(adapter.fetchClaims(request)).rejects.toBe(error);
    });
});
