import { describe, expect, it, vi } from "vitest";
import { WebhookWalletUnitRevocationNotifier } from "./wallet-unit-revocation.adapters.js";

const event = {
    tenantId: "tenant-1",
    sessionId: "session-1",
    credentialConfigurationId: "pid",
    statusEntries: [{ uri: "https://issuer.example/status/list-1", idx: 3 }],
};

function setup(options: {
    configurationEndpoint?: string;
    session?: Record<string, unknown> | null;
    deliveryError?: Error;
    missingEndpoints?: string[];
}) {
    const webhooks = {
        sendCredentialsRevokedWebhook: vi.fn(async () => {
            if (options.deliveryError) throw options.deliveryError;
        }),
    };
    const endpoints = {
        findForTenant: vi.fn(async (_tenant: string, id: string) =>
            options.missingEndpoints?.includes(id)
                ? null
                : { url: `https://hooks.example/${id}`, auth: undefined },
        ),
    };
    const configurations = {
        findForTenant: vi.fn(async () => ({
            webhookEndpointId: options.configurationEndpoint,
        })),
    };
    const sessions = {
        getForTenant: vi.fn(async () => {
            if (options.session === null) throw new Error("not found");
            return options.session ?? {};
        }),
    };
    const notifier = new WebhookWalletUnitRevocationNotifier(
        webhooks,
        endpoints as never,
        configurations as never,
        sessions as never,
    );
    return { notifier, webhooks };
}

describe("WebhookWalletUnitRevocationNotifier", () => {
    it("sends to the webhook endpoint of the credential configuration", async () => {
        const { notifier, webhooks } = setup({
            configurationEndpoint: "lifecycle",
            session: { webhookEndpointId: "offer", reference: "order-4711" },
        });

        await notifier.credentialsRevoked(event);

        expect(webhooks.sendCredentialsRevokedWebhook).toHaveBeenCalledWith(
            { url: "https://hooks.example/lifecycle", auth: undefined },
            {
                session: "session-1",
                reference: "order-4711",
                credentialConfigurationId: "pid",
                statusEntries: event.statusEntries,
            },
        );
    });

    it("falls back to the webhook endpoint of the offer", async () => {
        const { notifier, webhooks } = setup({
            session: { webhookEndpointId: "offer" },
        });

        await notifier.credentialsRevoked(event);

        expect(webhooks.sendCredentialsRevokedWebhook).toHaveBeenCalledWith(
            { url: "https://hooks.example/offer", auth: undefined },
            expect.not.objectContaining({ reference: expect.anything() }),
        );
    });

    it("sends nothing once the session is gone and the configuration has no endpoint", async () => {
        const { notifier, webhooks } = setup({ session: null });

        await notifier.credentialsRevoked(event);

        expect(webhooks.sendCredentialsRevokedWebhook).not.toHaveBeenCalled();
    });

    it("does not throw when the delivery fails", async () => {
        const { notifier } = setup({
            configurationEndpoint: "lifecycle",
            deliveryError: new Error("HTTP 500"),
        });

        await expect(
            notifier.credentialsRevoked(event),
        ).resolves.toBeUndefined();
    });

    it("falls back to the offer's endpoint when the configuration's no longer exists", async () => {
        const { notifier, webhooks } = setup({
            configurationEndpoint: "deleted",
            missingEndpoints: ["deleted"],
            session: { webhookEndpointId: "offer" },
        });

        await notifier.credentialsRevoked(event);

        expect(webhooks.sendCredentialsRevokedWebhook).toHaveBeenCalledWith(
            { url: "https://hooks.example/offer", auth: undefined },
            expect.anything(),
        );
    });
});
