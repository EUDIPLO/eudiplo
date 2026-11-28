import type { MetricService } from "nestjs-otel";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubSecretReferences } from "../../../../../../test/secrets/secret-test-sources.js";
import { SecretReferences } from "../../../../../platform/secrets/application/secret-references.js";
import { ChainedAsService } from "./chained-as.service.js";
import type { OidcDiscoveryResolver } from "./ports/oidc-discovery-resolver.js";

describe("ChainedAsService upstream discovery caching & deduplication", () => {
    let service: ChainedAsService;
    let discoveryResolver: OidcDiscoveryResolver;
    let metricService: MetricService;
    const addCounterMock = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        discoveryResolver = { resolve: vi.fn() };

        metricService = {
            getCounter: vi.fn(() => ({
                add: addCounterMock,
            })),
        } as unknown as MetricService;

        service = Object.assign(
            Object.create(ChainedAsService.prototype) as ChainedAsService,
            {
                oidcDiscoveryResolver: discoveryResolver,
                metricService,
                discoveryCache: new Map(),
                inFlightDiscoveryRequests: new Map(),
                logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
                issuanceService: {
                    getIssuanceConfiguration: vi.fn().mockResolvedValue({}),
                },
                assertFederationTrustForUpstreamIssuer: vi
                    .fn()
                    .mockResolvedValue(undefined),
                discoveryHitsCounter: metricService.getCounter(),
                discoveryMissesCounter: metricService.getCounter(),
                discoveryStaleCounter: metricService.getCounter(),
                discoveryFetchesCounter: metricService.getCounter(),
            },
        );
    });

    it("fetches upstream OIDC discovery and caches the result", async () => {
        vi.mocked(discoveryResolver.resolve).mockResolvedValue({
            issuer: "https://upstream.example.org",
            authorization_endpoint: "https://upstream.example.org/auth",
            token_endpoint: "https://upstream.example.org/token",
            jwks_uri: "https://upstream.example.org/jwks",
        });

        const doc1 = await service.getUpstreamDiscovery(
            "tenant-1",
            "https://upstream.example.org",
        );

        expect(doc1.issuer).toBe("https://upstream.example.org");
        expect(discoveryResolver.resolve).toHaveBeenCalledTimes(1);

        // Second call hits cache
        const doc2 = await service.getUpstreamDiscovery(
            "tenant-1",
            "https://upstream.example.org",
        );

        expect(doc2.issuer).toBe("https://upstream.example.org");
        expect(discoveryResolver.resolve).toHaveBeenCalledTimes(1);
    });

    it("deduplicates concurrent in-flight discovery requests", async () => {
        vi.mocked(discoveryResolver.resolve).mockResolvedValue({
            issuer: "https://upstream.example.org",
            authorization_endpoint: "https://upstream.example.org/auth",
            token_endpoint: "https://upstream.example.org/token",
            jwks_uri: "https://upstream.example.org/jwks",
        });

        const [d1, d2, d3] = await Promise.all([
            service.getUpstreamDiscovery(
                "tenant-1",
                "https://upstream.example.org",
            ),
            service.getUpstreamDiscovery(
                "tenant-1",
                "https://upstream.example.org",
            ),
            service.getUpstreamDiscovery(
                "tenant-1",
                "https://upstream.example.org",
            ),
        ]);

        expect(d1.issuer).toBe("https://upstream.example.org");
        expect(d2.issuer).toBe("https://upstream.example.org");
        expect(d3.issuer).toBe("https://upstream.example.org");
        expect(discoveryResolver.resolve).toHaveBeenCalledTimes(1);
    });

    it("returns stale cached discovery document if re-fetch fails", async () => {
        vi.mocked(discoveryResolver.resolve)
            .mockResolvedValueOnce({
                issuer: "https://upstream.example.org",
                authorization_endpoint: "https://upstream.example.org/auth",
                token_endpoint: "https://upstream.example.org/token",
                jwks_uri: "https://upstream.example.org/jwks",
            })
            .mockRejectedValueOnce(new Error("Network unreachable"));

        // First fetch -> populates cache
        await service.getUpstreamDiscovery(
            "tenant-1",
            "https://upstream.example.org",
        );

        // Expire the item
        const cached = (service as any).discoveryCache.get(
            "https://upstream.example.org",
        );
        cached.expiresAt = Date.now() - 1000;

        // Second fetch -> fresh fetch fails, return stale doc
        const staleDoc = await service.getUpstreamDiscovery(
            "tenant-1",
            "https://upstream.example.org",
        );

        expect(staleDoc.issuer).toBe("https://upstream.example.org");
        expect(discoveryResolver.resolve).toHaveBeenCalledTimes(2);
        expect((service as any).logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("returning stale discovery document"),
        );
    });
});

describe("ChainedAsService upstream identity lookup", () => {
    const withRepository = (sessionRepository: object): ChainedAsService =>
        Object.assign(Object.create(ChainedAsService.prototype), {
            sessionRepository,
        });

    it("looks up the chained session within the issuance session's tenant", async () => {
        const findByIssuerState = vi.fn().mockResolvedValue({
            upstreamIdTokenClaims: { iss: "https://idp", sub: "user" },
        });
        const service = withRepository({ findByIssuerState });

        const identity = await service.getUpstreamIdentityByIssuerState(
            "tenant-1",
            "issuer-state",
        );

        expect(findByIssuerState).toHaveBeenCalledWith(
            "tenant-1",
            "issuer-state",
        );
        expect(identity).toEqual({
            iss: "https://idp",
            sub: "user",
            token_claims: { iss: "https://idp", sub: "user" },
        });
    });

    it("returns undefined when the tenant has no chained session for the issuer state", async () => {
        const service = withRepository({
            findByIssuerState: vi.fn().mockResolvedValue(null),
        });

        await expect(
            service.getUpstreamIdentityByIssuerState(
                "tenant-2",
                "issuer-state",
            ),
        ).resolves.toBeUndefined();
    });
});

describe("ChainedAsService metadata", () => {
    const withToken = (token?: Record<string, unknown>): ChainedAsService =>
        Object.assign(Object.create(ChainedAsService.prototype), {
            settings: { publicUrl: "https://issuer.example" },
            issuanceService: {
                getIssuanceConfiguration: vi.fn().mockResolvedValue({
                    authorizationServers: [
                        {
                            type: "chained",
                            id: "chained-auth",
                            upstream: {
                                issuer: "https://idp.example",
                                clientId: "eudiplo",
                            },
                            token,
                        },
                    ],
                }),
            },
        });

    it("advertises the refresh_token grant unless refresh tokens are disabled", async () => {
        await expect(
            withToken().getMetadata("tenant-1"),
        ).resolves.toMatchObject({
            grant_types_supported: ["authorization_code", "refresh_token"],
        });
        await expect(
            withToken({ refreshTokenEnabled: false }).getMetadata("tenant-1"),
        ).resolves.toMatchObject({
            grant_types_supported: ["authorization_code"],
        });
    });
});

describe("ChainedAsService wallet attestation settings", () => {
    it("keeps the chained server's status check mode", async () => {
        const service = Object.assign(
            Object.create(ChainedAsService.prototype) as ChainedAsService,
            {
                issuanceService: {
                    getIssuanceConfiguration: vi.fn().mockResolvedValue({
                        walletAttestationStatusCheckMode: "best_effort",
                        authorizationServers: [
                            {
                                type: "chained",
                                id: "chained",
                                upstream: {
                                    issuer: "https://upstream.example.org",
                                },
                                walletAttestationStatusCheckMode: "strict",
                            },
                        ],
                    }),
                },
            },
        );

        const config = await service.getChainedAsConfig("tenant-1");

        expect(config.walletAttestationStatusCheckMode).toBe("strict");
    });
});

describe("ChainedAsService upstream client secret", () => {
    function exchange(
        clientSecret: string,
        secrets: SecretReferences,
        tokenEndpoint = "https://idp.example/token",
    ) {
        const exchanger = {
            exchange: vi.fn().mockResolvedValue({ accessToken: "a.b.c" }),
        };
        const service = Object.assign(
            Object.create(ChainedAsService.prototype),
            { oidcTokenExchanger: exchanger, secrets },
        ) as unknown as {
            exchangeUpstreamCode(...args: unknown[]): Promise<void>;
        };
        const run = service.exchangeUpstreamCode(
            { tenantId: "tenant-1", upstreamCodeVerifier: "v" },
            "code",
            {
                upstream: {
                    issuer: "https://idp.example",
                    clientId: "client",
                    clientSecret,
                },
            },
            { token_endpoint: tokenEndpoint },
            "https://eudiplo.example/callback",
        );
        return { run, exchanger };
    }

    it("sends the value of a granted reference to the token endpoint", async () => {
        const { secrets, vault } = stubSecretReferences();
        vault.values.set("kv/eudiplo/tenant-1/idp#secret", "from-vault");
        const { run, exchanger } = exchange(
            "${vault:kv/eudiplo/tenant-1/idp#secret}",
            secrets,
        );

        await run;

        expect(exchanger.exchange).toHaveBeenCalledWith(
            expect.objectContaining({
                clientId: "client",
                clientSecret: "from-vault",
            }),
        );
    });

    it("sends a bound secret only when the token endpoint's origin is granted too", async () => {
        const { secrets, vault } = stubSecretReferences({
            tenants: {
                "tenant-1": {
                    bound: [
                        {
                            ref: "${vault:kv/operator/idp#secret}",
                            fields: [
                                "IssuanceConfig:authorizationServers.*.upstream.clientSecret",
                            ],
                            destinations: ["https://idp.example"],
                        },
                    ],
                },
            },
        });
        vault.values.set("kv/operator/idp#secret", "operator");
        const bound = "${vault:kv/operator/idp#secret}";

        const same = exchange(bound, secrets);
        await same.run;
        expect(same.exchanger.exchange).toHaveBeenCalledWith(
            expect.objectContaining({ clientSecret: "operator" }),
        );

        const elsewhere = exchange(
            bound,
            secrets,
            "https://attacker.example/token",
        );
        await expect(elsewhere.run).rejects.toThrow(/refused/);
        expect(elsewhere.exchanger.exchange).not.toHaveBeenCalled();
    });

    it("sends a literal secret as it is, and no secret of another tenant", async () => {
        const literal = exchange("literal", new SecretReferences());
        await literal.run;
        expect(literal.exchanger.exchange).toHaveBeenCalledWith(
            expect.objectContaining({ clientSecret: "literal" }),
        );

        const { secrets, vault } = stubSecretReferences();
        vault.values.set("kv/eudiplo/other/idp#secret", "foreign");
        const foreign = exchange(
            "${vault:kv/eudiplo/other/idp#secret}",
            secrets,
        );
        await expect(foreign.run).rejects.toThrow(/no grant of tenant/);
        expect(foreign.exchanger.exchange).not.toHaveBeenCalled();
        expect(vault.reads).toBe(0);
    });
});
