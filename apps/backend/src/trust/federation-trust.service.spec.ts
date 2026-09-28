import type { MetricService } from "nestjs-otel";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvaluateFederationTrustChain } from "./application/evaluate-federation-trust-chain.js";
import { FederationTrustService } from "./federation-trust.service.js";
import type { FederationResolver } from "./ports/federation-resolver.js";
import type { FederationTrustSource } from "./types.js";

describe("FederationTrustService caching & deduplication", () => {
    let service: FederationTrustService;
    let resolver: FederationResolver;
    let metricService: MetricService;
    const addCounterMock = vi.fn();

    const trustSource: FederationTrustSource = {
        mode: "federation-only",
        trustAnchors: [{ entityId: "https://anchor.example.org" }],
        cacheTtlSeconds: 60,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        resolver = {
            resolveEntityConfiguration: vi.fn(),
        } as unknown as FederationResolver;

        metricService = {
            getCounter: vi.fn(() => ({
                add: addCounterMock,
            })),
        } as unknown as MetricService;

        service = new FederationTrustService(
            new EvaluateFederationTrustChain(resolver),
            metricService,
        );
    });

    it("returns trusted: true immediately if entity is a configured trust anchor", async () => {
        const result = await service.evaluateEntityTrust(
            "https://anchor.example.org/",
            trustSource,
        );

        expect(result).toEqual({
            trusted: true,
            reason: "entity is a configured federation trust anchor",
        });
        expect(resolver.resolveEntityConfiguration).not.toHaveBeenCalled();
    });

    it("fetches entity configuration and caches the evaluation result", async () => {
        vi.spyOn(resolver, "resolveEntityConfiguration").mockResolvedValue({
            sub: "https://entity.example.org",
            authority_hints: ["https://anchor.example.org"],
        });

        const result1 = await service.evaluateEntityTrust(
            "https://entity.example.org",
            trustSource,
        );

        expect(result1.trusted).toBe(true);
        expect(resolver.resolveEntityConfiguration).toHaveBeenCalledTimes(1);

        // Second call should hit the cache
        const result2 = await service.evaluateEntityTrust(
            "https://entity.example.org",
            trustSource,
        );

        expect(result2.trusted).toBe(true);
        expect(resolver.resolveEntityConfiguration).toHaveBeenCalledTimes(1);
        expect(addCounterMock).toHaveBeenCalledWith(
            1,
            expect.objectContaining({ entity: "https://entity.example.org" }),
        );
    });

    it("deduplicates in-flight concurrent requests for the same entity", async () => {
        vi.spyOn(resolver, "resolveEntityConfiguration").mockResolvedValue({
            sub: "https://entity.example.org",
            authority_hints: ["https://anchor.example.org"],
        });

        const [r1, r2, r3] = await Promise.all([
            service.evaluateEntityTrust(
                "https://entity.example.org",
                trustSource,
            ),
            service.evaluateEntityTrust(
                "https://entity.example.org",
                trustSource,
            ),
            service.evaluateEntityTrust(
                "https://entity.example.org",
                trustSource,
            ),
        ]);

        expect(r1.trusted).toBe(true);
        expect(r2.trusted).toBe(true);
        expect(r3.trusted).toBe(true);
        expect(resolver.resolveEntityConfiguration).toHaveBeenCalledTimes(1);
    });

    it("returns stale cached evaluation if re-fetch fails", async () => {
        vi.spyOn(resolver, "resolveEntityConfiguration").mockResolvedValueOnce({
            sub: "https://entity.example.org",
            authority_hints: ["https://anchor.example.org"],
        });

        // Initial fetch -> populate cache
        await service.evaluateEntityTrust(
            "https://entity.example.org",
            trustSource,
        );

        // Expire the primary cache item artificially
        const cacheKey =
            "https://entity.example.org::" +
            JSON.stringify(trustSource.trustAnchors);
        const internalCache = (service as any).trustCache.get(cacheKey);
        internalCache.expiresAt = Date.now() - 1000;

        // Next fetch fails
        vi.spyOn(resolver, "resolveEntityConfiguration").mockRejectedValueOnce(
            new Error("Network error"),
        );

        const staleResult = await service.evaluateEntityTrust(
            "https://entity.example.org",
            trustSource,
        );

        expect(staleResult.trusted).toBe(true);
        expect(resolver.resolveEntityConfiguration).toHaveBeenCalledTimes(2);
    });

    it("clears cache via clearTrustCache", async () => {
        vi.spyOn(resolver, "resolveEntityConfiguration").mockResolvedValue({
            sub: "https://entity.example.org",
            authority_hints: ["https://anchor.example.org"],
        });

        await service.evaluateEntityTrust(
            "https://entity.example.org",
            trustSource,
        );
        expect(resolver.resolveEntityConfiguration).toHaveBeenCalledTimes(1);

        service.clearTrustCache();

        await service.evaluateEntityTrust(
            "https://entity.example.org",
            trustSource,
        );
        expect(resolver.resolveEntityConfiguration).toHaveBeenCalledTimes(2);
    });
});
