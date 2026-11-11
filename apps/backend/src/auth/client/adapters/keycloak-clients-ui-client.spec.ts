import { describe, expect, it, vi } from "vitest";
import { KeycloakClientsProvider } from "./keycloak-clients.service.js";

/** A provider whose Keycloak has the UI client `existing`, with `env` as configuration. */
function provider(
    env: Record<string, string>,
    existing?: { id: string; redirectUris?: string[]; webOrigins?: string[] },
) {
    const kc = {
        clients: {
            find: vi.fn().mockResolvedValue(existing ? [existing] : []),
            create: vi.fn().mockResolvedValue({ id: "kc-ui" }),
            update: vi.fn().mockResolvedValue(undefined),
        },
        roles: {
            find: vi.fn().mockResolvedValue([]),
            create: vi.fn().mockResolvedValue(undefined),
        },
    };
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const clients = Object.assign(
        Object.create(KeycloakClientsProvider.prototype),
        {
            kc,
            logger,
            configService: { get: (key: string) => env[key] },
        },
    ) as KeycloakClientsProvider;
    return {
        kc,
        logger,
        ensureUiPublicClient: () => clients["ensureUiPublicClient"](),
        init: () => clients["init"](),
    };
}

describe("KeycloakClientsProvider.ensureUiPublicClient", () => {
    it("allows only the web client URLs as redirect URIs and web origins", async () => {
        const { kc, logger, ensureUiPublicClient } = provider(
            {
                OIDC_UI_CLIENT_ID: "custom-ui",
                OIDC_UI_URL: "https://console.example/",
            },
            { id: "kc-ui", redirectUris: ["*"], webOrigins: ["*"] },
        );

        await ensureUiPublicClient();

        expect(kc.clients.find).toHaveBeenCalledWith({ clientId: "custom-ui" });
        expect(kc.clients.update).toHaveBeenCalledWith(
            { id: "kc-ui" },
            expect.objectContaining({
                clientId: "custom-ui",
                publicClient: true,
                redirectUris: ["https://console.example/*"],
                webOrigins: ["https://console.example"],
            }),
        );
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("replaces the redirect URIs set in Keycloak with the web client URLs", async () => {
        const { kc, ensureUiPublicClient } = provider(
            { OIDC_UI_URL: "https://console.example" },
            {
                id: "kc-ui",
                redirectUris: ["https://old.example/*", "*"],
                webOrigins: ["https://old.example"],
            },
        );

        await ensureUiPublicClient();

        const [, payload] = kc.clients.update.mock.calls[0];
        expect(payload.redirectUris).toEqual(["https://console.example/*"]);
        expect(payload.webOrigins).toEqual(["https://console.example"]);
    });

    it("lets a logout return to the web client's redirect URIs", async () => {
        const { kc, ensureUiPublicClient } = provider(
            { OIDC_UI_URL: "https://console.example" },
            { id: "kc-ui", redirectUris: [], webOrigins: [] },
        );

        await ensureUiPublicClient();

        const [, payload] = kc.clients.update.mock.calls[0];
        expect(payload.attributes).toEqual({
            "post.logout.redirect.uris": "+",
        });
    });

    it("keeps the redirect URIs set in Keycloak without OIDC_UI_URL, except *", async () => {
        const { kc, logger, ensureUiPublicClient } = provider(
            {},
            {
                id: "kc-ui",
                redirectUris: ["*", "https://console.example/*"],
                webOrigins: ["*"],
            },
        );

        await ensureUiPublicClient();

        expect(kc.clients.update).toHaveBeenCalledWith(
            { id: "kc-ui" },
            expect.objectContaining({
                clientId: "eudiplo-ui",
                redirectUris: ["https://console.example/*"],
                webOrigins: ["+"],
            }),
        );
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("creates the client without redirect URIs and says that SSO needs OIDC_UI_URL", async () => {
        const { kc, logger, ensureUiPublicClient } = provider({});

        await ensureUiPublicClient();

        expect(kc.clients.create).toHaveBeenCalledWith(
            expect.objectContaining({
                clientId: "eudiplo-ui",
                redirectUris: [],
                webOrigins: ["+"],
            }),
        );
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Set OIDC_UI_URL"),
        );
    });

    it("creates the client with the web client URLs", async () => {
        const { kc, logger, ensureUiPublicClient } = provider({
            OIDC_UI_URL: "https://a.example, https://b.example/x/",
        });

        await ensureUiPublicClient();

        expect(kc.clients.create).toHaveBeenCalledWith(
            expect.objectContaining({
                clientId: "eudiplo-ui",
                redirectUris: ["https://a.example/*", "https://b.example/x/*"],
                webOrigins: ["https://a.example", "https://b.example"],
            }),
        );
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("says that SSO needs OIDC_UI_URL when only * was set", async () => {
        const { kc, logger, ensureUiPublicClient } = provider(
            {},
            { id: "kc-ui", redirectUris: ["*"], webOrigins: ["*"] },
        );

        await ensureUiPublicClient();

        expect(kc.clients.update).toHaveBeenCalledWith(
            { id: "kc-ui" },
            expect.objectContaining({ redirectUris: [], webOrigins: ["+"] }),
        );
        expect(logger.warn).toHaveBeenCalledOnce();
    });

    it("removes * also when the startup steps before it fail", async () => {
        const { kc, logger, init } = provider(
            { OIDC_UI_URL: "https://console.example" },
            { id: "kc-ui", redirectUris: ["*"], webOrigins: ["*"] },
        );
        (kc.roles.find as ReturnType<typeof vi.fn>).mockRejectedValue(
            new Error("forbidden"),
        );

        await init();

        expect(logger.error).toHaveBeenCalledWith(
            "Error initializing Keycloak roles",
            expect.any(Error),
        );
        expect(kc.clients.update).toHaveBeenCalledWith(
            { id: "kc-ui" },
            expect.objectContaining({
                redirectUris: ["https://console.example/*"],
            }),
        );
    });

    it("says to check the redirect URIs in Keycloak when the client cannot be updated", async () => {
        const { kc, logger, init } = provider(
            {},
            { id: "kc-ui", redirectUris: ["*"], webOrigins: ["*"] },
        );
        (kc.clients.update as ReturnType<typeof vi.fn>).mockRejectedValue(
            new Error("forbidden"),
        );

        await init();

        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining(
                "Check in Keycloak that its redirect URIs do not contain '*'",
            ),
            expect.any(Error),
        );
        expect(logger.error).toHaveBeenCalledOnce();
    });
});
