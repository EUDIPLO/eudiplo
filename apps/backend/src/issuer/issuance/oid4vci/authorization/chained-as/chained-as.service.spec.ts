import type { MetricService } from "nestjs-otel";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
