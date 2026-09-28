import { describe, expect, it, vi } from "vitest";
import { VerifiedLoteProvider } from "./adapters/verified-lote-provider.js";
import { CollectTrustedEntities } from "./application/collect-trusted-entities.js";
import { TrustStoreService } from "./trust-store.service.js";

describe("TrustStoreService cache isolation", () => {
    it("revalidates a list when its pinned verification certificate changes", async () => {
        const jwt = `e30.${Buffer.from(JSON.stringify({ LoTE: {} })).toString("base64url")}.c2ln`;
        const fetchJwt = vi.fn().mockResolvedValue(jwt);
        const verifyTrustListJwt = vi.fn().mockResolvedValue(undefined);
        const service = Object.assign(
            Object.create(TrustStoreService.prototype),
            {
                cache: new Map(),
                logger: { debug: vi.fn() },
                collectTrustedEntities: new CollectTrustedEntities(
                    new VerifiedLoteProvider(
                        { fetchJwt, verifyTrustListJwt },
                        { parse: () => ({ info: {}, entities: [] }) },
                    ),
                ),
            },
        ) as TrustStoreService;

        const source = {
            lotes: [
                {
                    url: "https://trust.example/list",
                    verifierX509Der: "certificate-a",
                },
            ],
        };
        await service.getTrustStore(source);
        await service.getTrustStore(source);
        expect(fetchJwt).toHaveBeenCalledTimes(1);

        const replacement = {
            lotes: [{ ...source.lotes[0], verifierX509Der: "certificate-b" }],
        };
        await service.getTrustStore(replacement);
        expect(fetchJwt).toHaveBeenCalledTimes(2);
        expect(verifyTrustListJwt).toHaveBeenLastCalledWith(
            replacement.lotes[0],
            jwt,
        );
    });

    it("uses the internal URL for managed trust-list references with public fallback", async () => {
        const jwt = `e30.${Buffer.from(JSON.stringify({ LoTE: {} })).toString("base64url")}.c2ln`;
        const fetchJwt = vi.fn().mockResolvedValue(jwt);
        const createService = (settings: {
            publicUrl: string;
            internalUrl?: string;
        }) =>
            Object.assign(Object.create(TrustStoreService.prototype), {
                cache: new Map(),
                logger: { debug: vi.fn() },
                settings,
                collectTrustedEntities: new CollectTrustedEntities(
                    new VerifiedLoteProvider(
                        {
                            fetchJwt,
                            verifyTrustListJwt: vi
                                .fn()
                                .mockResolvedValue(undefined),
                        },
                        { parse: () => ({ info: {}, entities: [] }) },
                    ),
                ),
                trustListService: {
                    getVerifierX509Der: vi
                        .fn()
                        .mockResolvedValue("certificate"),
                },
            }) as TrustStoreService;
        const source = {
            tenantId: "tenant/one",
            lotes: [{ trustListId: "list-1" }],
        };

        await createService({
            publicUrl: "https://public.example",
            internalUrl: "https://internal.example",
        }).getTrustStore(source);
        expect(fetchJwt).toHaveBeenLastCalledWith(
            "https://internal.example/issuers/tenant%2Fone/trust-list/list-1",
        );

        await createService({
            publicUrl: "https://public.example",
        }).getTrustStore(source);
        expect(fetchJwt).toHaveBeenLastCalledWith(
            "https://public.example/issuers/tenant%2Fone/trust-list/list-1",
        );
    });
});
