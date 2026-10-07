import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../../../session/domain/session-data.js";
import { ConfiguredCredentialClaimsProvider } from "./configured-credential-claims.provider.js";

describe("ConfiguredCredentialClaimsProvider", () => {
    const session = (credentialClaims?: Record<string, unknown>) =>
        ({
            id: "session-1",
            tenantId: "tenant-1",
            credentialPayload: { credentialClaims },
        }) as SessionData;

    it("returns inline claims without loading configuration or calling a webhook", async () => {
        const credentialConfigs = { findForTenant: vi.fn() };
        const attributeProviders = { findForTenant: vi.fn() };
        const fetchClaims = vi.fn();
        const provider = new ConfiguredCredentialClaimsProvider(
            credentialConfigs,
            attributeProviders,
            { fetchClaims },
        );

        await expect(
            provider.resolveClaims({
                credentialConfigurationId: "pid",
                session: session({
                    pid: { type: "inline", claims: { town: "Turin" } },
                }),
            }),
        ).resolves.toEqual({ deferred: false, claims: { town: "Turin" } });
        expect(credentialConfigs.findForTenant).not.toHaveBeenCalled();
        expect(fetchClaims).not.toHaveBeenCalled();
    });

    it("uses the offer-time webhook and returns the remote result", async () => {
        const fetchClaims = vi
            .fn()
            .mockResolvedValue({ deferred: true, interval: 5 });
        const provider = new ConfiguredCredentialClaimsProvider(
            { findForTenant: vi.fn() },
            { findForTenant: vi.fn() },
            { fetchClaims },
        );
        const webhook = {
            url: "https://claims.example",
            auth: { type: "none" },
        };

        await expect(
            provider.resolveClaims({
                credentialConfigurationId: "pid",
                session: session({ pid: { type: "webhook", webhook } }),
            }),
        ).resolves.toEqual({ deferred: true, interval: 5 });
        expect(fetchClaims).toHaveBeenCalledWith(
            expect.objectContaining({ webhook, session: "session-1" }),
        );
    });

    it("requires a provider only when requested and preserves the existing error", async () => {
        const provider = new ConfiguredCredentialClaimsProvider(
            { findForTenant: vi.fn().mockResolvedValue({}) },
            { findForTenant: vi.fn() },
            { fetchClaims: vi.fn() },
        );

        await expect(
            provider.resolveClaims({
                credentialConfigurationId: "pid",
                session: session(),
                requireProvider: true,
            }),
        ).rejects.toMatchObject({
            name: "CredentialClaimsResolutionError",
            code: "provider_required",
        });
    });

    it("resolves the credential's configured attribute provider with tenant scope", async () => {
        const credentialConfigs = {
            findForTenant: vi
                .fn()
                .mockResolvedValue({ attributeProviderId: "claims-1" }),
        };
        const attributeProviders = {
            findForTenant: vi.fn().mockResolvedValue({
                url: "https://claims.example",
                auth: { type: "none" },
            }),
        };
        const fetchClaims = vi
            .fn()
            .mockResolvedValue({ deferred: false, claims: { town: "Turin" } });
        const provider = new ConfiguredCredentialClaimsProvider(
            credentialConfigs,
            attributeProviders,
            { fetchClaims },
        );
        const identity = {
            iss: "https://as.example",
            sub: "wallet-1",
            token_claims: { scope: "credential" },
        };

        await expect(
            provider.resolveClaims({
                credentialConfigurationId: "pid",
                session: session(),
                identity,
                credentials: [{ id: "presented" }],
            }),
        ).resolves.toEqual({ deferred: false, claims: { town: "Turin" } });
        expect(credentialConfigs.findForTenant).toHaveBeenCalledWith(
            "tenant-1",
            "pid",
        );
        expect(attributeProviders.findForTenant).toHaveBeenCalledWith(
            "tenant-1",
            "claims-1",
        );
        expect(fetchClaims).toHaveBeenCalledWith(
            expect.objectContaining({
                identity,
                credentials: [{ id: "presented" }],
                credentialConfigurationId: "pid",
            }),
        );
    });

    it("reports missing credential configurations and attribute providers", async () => {
        const missingConfigProvider = new ConfiguredCredentialClaimsProvider(
            { findForTenant: vi.fn().mockResolvedValue(null) },
            { findForTenant: vi.fn() },
            { fetchClaims: vi.fn() },
        );
        await expect(
            missingConfigProvider.resolveClaims({
                credentialConfigurationId: "missing",
                session: session(),
            }),
        ).rejects.toMatchObject({
            name: "CredentialClaimsResolutionError",
            code: "credential_configuration_not_found",
            message: "Credential configuration 'missing' not found",
        });

        const missingProvider = new ConfiguredCredentialClaimsProvider(
            {
                findForTenant: vi.fn().mockResolvedValue({
                    attributeProviderId: "missing-provider",
                }),
            },
            { findForTenant: vi.fn().mockResolvedValue(null) },
            { fetchClaims: vi.fn() },
        );
        await expect(
            missingProvider.resolveClaims({
                credentialConfigurationId: "pid",
                session: session(),
            }),
        ).rejects.toMatchObject({
            name: "CredentialClaimsResolutionError",
            code: "attribute_provider_not_found",
            message: "Attribute provider 'missing-provider' not found",
        });
    });
    it("prefers an offer-time provider and propagates remote failures", async () => {
        const credentialConfigs = { findForTenant: vi.fn() };
        const attributeProviders = {
            findForTenant: vi.fn().mockResolvedValue({
                url: "https://claims.example",
                auth: { type: "none" },
            }),
        };
        const error = new Error("remote failure");
        const remote = { fetchClaims: vi.fn().mockRejectedValue(error) };
        const provider = new ConfiguredCredentialClaimsProvider(
            credentialConfigs,
            attributeProviders,
            remote,
        );
        await expect(
            provider.resolveClaims({
                credentialConfigurationId: "pid",
                session: session({
                    pid: {
                        type: "attributeProvider",
                        attributeProviderId: "offer-provider",
                    },
                }),
            }),
        ).rejects.toBe(error);
        expect(credentialConfigs.findForTenant).not.toHaveBeenCalled();
        expect(attributeProviders.findForTenant).toHaveBeenCalledWith(
            "tenant-1",
            "offer-provider",
        );
    });

    it("allows absent optional providers without remote delivery", async () => {
        const remote = { fetchClaims: vi.fn() };
        const provider = new ConfiguredCredentialClaimsProvider(
            { findForTenant: vi.fn().mockResolvedValue({}) },
            { findForTenant: vi.fn() },
            remote,
        );
        await expect(
            provider.resolveClaims({
                credentialConfigurationId: "pid",
                session: session(),
            }),
        ).resolves.toBeUndefined();
        expect(remote.fetchClaims).not.toHaveBeenCalled();
    });

    describe("a dynamic source that answers without claims", () => {
        const webhook = {
            url: "https://claims.example",
            auth: { type: "none" },
        };
        const sources: Array<[string, Record<string, unknown> | undefined]> = [
            ["an offer webhook", { pid: { type: "webhook", webhook } }],
            [
                "an offer attribute provider",
                {
                    pid: {
                        type: "attributeProvider",
                        attributeProviderId: "offer-provider",
                    },
                },
            ],
            ["the configuration's attribute provider", undefined],
        ];

        function setup(answer: unknown) {
            const fetchClaims = vi.fn().mockResolvedValue(answer);
            const provider = new ConfiguredCredentialClaimsProvider(
                {
                    findForTenant: vi
                        .fn()
                        .mockResolvedValue({ attributeProviderId: "claims-1" }),
                },
                { findForTenant: vi.fn().mockResolvedValue(webhook) },
                { fetchClaims },
            );
            return { provider, fetchClaims };
        }

        it.each(sources)(
            "fails the request for %s instead of using the static defaults",
            async (_source, credentialClaims) => {
                const test = setup({ deferred: false, claims: undefined });
                await expect(
                    test.provider.resolveClaims({
                        credentialConfigurationId: "pid",
                        session: session(credentialClaims),
                    }),
                ).rejects.toMatchObject({
                    name: "CredentialClaimsResolutionError",
                    code: "claims_missing",
                    message:
                        "The claim source returned no claims for credential configuration 'pid'",
                });
                expect(test.fetchClaims).toHaveBeenCalledOnce();
            },
        );

        it.each([null, "Max", ["Max"]])(
            "treats %j under the configuration ID as no claims",
            async (claims) => {
                const test = setup({ deferred: false, claims });
                await expect(
                    test.provider.resolveClaims({
                        credentialConfigurationId: "pid",
                        session: session(),
                    }),
                ).rejects.toMatchObject({ code: "claims_missing" });
            },
        );

        it("fails for tokens of an external authorization server too", async () => {
            const test = setup({ deferred: false, claims: undefined });
            await expect(
                test.provider.resolveClaims({
                    credentialConfigurationId: "pid",
                    session: session(),
                    requireProvider: true,
                }),
            ).rejects.toMatchObject({ code: "claims_missing" });
        });

        it("keeps a deferred answer deferred", async () => {
            const test = setup({ deferred: true, interval: 5 });
            await expect(
                test.provider.resolveClaims({
                    credentialConfigurationId: "pid",
                    session: session(),
                }),
            ).resolves.toEqual({ deferred: true, interval: 5 });
        });
    });
});
