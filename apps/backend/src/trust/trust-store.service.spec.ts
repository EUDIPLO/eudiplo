import { afterEach, describe, expect, it, vi } from "vitest";
import { VerifiedLoteProvider } from "./adapters/verified-lote-provider.js";
import { CollectTrustedEntities } from "./application/collect-trusted-entities.js";
import { OutdatedTrustListsError } from "./domain/trust-list-freshness.js";
import { TrustStoreService } from "./trust-store.service.js";

const CURRENT = { nextUpdate: new Date(Date.now() + 86_400_000).toISOString() };

describe("TrustStoreService cache isolation", () => {
    it("revalidates a list when its pinned verification certificate changes", async () => {
        const jwt = `e30.${Buffer.from(JSON.stringify({ LoTE: {} })).toString("base64url")}.c2ln`;
        const fetchJwt = vi.fn().mockResolvedValue(jwt);
        const verifyTrustListJwt = vi.fn().mockResolvedValue(undefined);
        const service = Object.assign(
            Object.create(TrustStoreService.prototype),
            {
                cache: new Map(),
                outdated: new Map(),
                logger: { debug: vi.fn() },
                collectTrustedEntities: new CollectTrustedEntities(
                    new VerifiedLoteProvider(
                        { fetchJwt, verifyTrustListJwt },
                        { parse: () => ({ info: CURRENT, entities: [] }) },
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

        const pinnedKey = {
            lotes: [{ url: source.lotes[0].url, verifierKeyPem: "key-a" }],
        };
        await service.getTrustStore(pinnedKey);
        await service.getTrustStore(pinnedKey);
        expect(fetchJwt).toHaveBeenCalledTimes(3);
        await service.getTrustStore({
            lotes: [{ ...pinnedKey.lotes[0], verifierKeyPem: "key-b" }],
        });
        expect(fetchJwt).toHaveBeenCalledTimes(4);
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
                outdated: new Map(),
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
                        { parse: () => ({ info: CURRENT, entities: [] }) },
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

describe("TrustStoreService.getListedEntities", () => {
    const entities = [
        {
            entityId: "Issuer",
            services: [
                {
                    serviceTypeIdentifier:
                        "http://uri.etsi.org/19602/SvcType/EAA/Issuance",
                    certValue: "cert",
                },
            ],
        },
    ];
    const lote = {
        ListAndSchemeInformation: { NextUpdate: CURRENT.nextUpdate },
        TrustedEntitiesList: [],
    };

    function createService(data: object | undefined) {
        const fetchJwt = vi.fn();
        const findOne = vi.fn().mockResolvedValue({ data });
        const parse = vi.fn().mockReturnValue({ info: CURRENT, entities });
        const logger = { debug: vi.fn(), warn: vi.fn() };
        const service = Object.assign(
            Object.create(TrustStoreService.prototype),
            {
                cache: new Map(),
                outdated: new Map(),
                logger,
                trustListService: { findOne },
                loteParser: { parse },
                collectTrustedEntities: new CollectTrustedEntities(
                    new VerifiedLoteProvider(
                        {
                            fetchJwt: fetchJwt.mockResolvedValue(
                                `e30.${Buffer.from(JSON.stringify({ LoTE: lote })).toString("base64url")}.c2ln`,
                            ),
                            verifyTrustListJwt: vi
                                .fn()
                                .mockResolvedValue(undefined),
                        },
                        { parse },
                    ),
                ),
            },
        ) as TrustStoreService;
        return { service, fetchJwt, findOne, parse, logger };
    }

    it("reads managed lists from their stored content without fetching", async () => {
        const { service, fetchJwt, findOne, parse } = createService({
            LoTE: lote,
        });

        await expect(
            service.getListedEntities(
                { trustListId: " list-1 ", url: "" },
                "t",
            ),
        ).resolves.toEqual(entities);
        expect(findOne).toHaveBeenCalledWith("t", "list-1");
        expect(parse).toHaveBeenCalledWith(lote);
        expect(fetchJwt).not.toHaveBeenCalled();
    });

    it("rejects an outdated managed list, so the request names none of its issuers", async () => {
        const nextUpdate = new Date(Date.now() - 86_400_000).toISOString();
        const outdated = {
            ...lote,
            ListAndSchemeInformation: { NextUpdate: nextUpdate },
        };
        const { service, parse } = createService({ LoTE: outdated });

        await expect(
            service.getListedEntities({ trustListId: "list-1", url: "" }, "t"),
        ).rejects.toMatchObject({
            discarded: [{ list: "list-1", nextUpdate }],
        });
        expect(parse).not.toHaveBeenCalled();
    });

    it("accepts stored lists without the LoTE wrapper", async () => {
        const { service, parse } = createService(lote);
        await service.getListedEntities(
            { trustListId: "list-1", url: "" },
            "t",
        );
        expect(parse).toHaveBeenCalledWith(lote);
    });

    it("fetches and verifies external lists", async () => {
        const { service, fetchJwt, findOne } = createService(undefined);
        const ref = {
            url: "https://trust.example/list",
            verifierX509Der: "certificate",
        };

        await expect(service.getListedEntities(ref, "t")).resolves.toEqual(
            entities,
        );
        expect(fetchJwt).toHaveBeenCalledWith(ref.url);
        expect(findOne).not.toHaveBeenCalled();
    });
});

describe("TrustStoreService list freshness", () => {
    const now = new Date("2026-11-06T12:00:00Z");
    const source = {
        lotes: [
            { url: "https://trust.example/one", verifierX509Der: "a" },
            { url: "https://trust.example/two", verifierX509Der: "b" },
        ],
    };
    const list = (nextUpdate: Date) => ({
        entities: [],
        nextUpdate: nextUpdate.toISOString(),
    });

    // External lists only, so the managed-list collaborators are not used.
    function createService(loadVerified: ReturnType<typeof vi.fn>) {
        const service = new TrustStoreService(
            new CollectTrustedEntities({ loadVerified }),
            {} as never,
            {} as never,
            {} as never,
        );
        const internals = service as unknown as {
            logger: { warn: () => void; debug: () => void };
            outdated: Map<string, unknown>;
        };
        vi.spyOn(internals.logger, "debug").mockImplementation(() => {});
        const warn = vi
            .spyOn(internals.logger, "warn")
            .mockImplementation(() => {});
        return { service, logger: { warn }, outdated: internals.outdated };
    }

    afterEach(() => {
        vi.useRealTimers();
    });

    it("refetches a cached store when its earliest list reaches NextUpdate within the cache time", async () => {
        vi.useFakeTimers({ now });
        const soon = new Date(now.getTime() + 60_000);
        const later = new Date(now.getTime() + 86_400_000);
        const loadVerified = vi
            .fn()
            .mockResolvedValueOnce(list(later))
            .mockResolvedValueOnce(list(soon))
            // The operator of the second list replays the same old version.
            .mockResolvedValueOnce(list(later))
            .mockResolvedValueOnce(list(soon));
        const { service, logger } = createService(loadVerified);

        await expect(service.getTrustStore(source)).resolves.toMatchObject({
            nextUpdate: soon.toISOString(),
            discarded: [],
        });
        vi.setSystemTime(now.getTime() + 30_000);
        await service.getTrustStore(source);
        expect(loadVerified).toHaveBeenCalledTimes(2);

        vi.setSystemTime(now.getTime() + 120_000);
        await expect(service.getTrustStore(source)).resolves.toMatchObject({
            nextUpdate: later.toISOString(),
            discarded: [
                {
                    list: "https://trust.example/two",
                    nextUpdate: soon.toISOString(),
                },
            ],
        });
        expect(loadVerified).toHaveBeenCalledTimes(4);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                `using the current lists: https://trust.example/two (NextUpdate "${soon.toISOString()}")`,
            ),
        );
    });

    it("answers an outdated source for a minute without fetching its lists again", async () => {
        vi.useFakeTimers({ now });
        const past = new Date(now.getTime() - 60_000);
        const later = new Date(now.getTime() + 86_400_000);
        const loadVerified = vi.fn().mockResolvedValue(list(past));
        const { service, logger } = createService(loadVerified);

        await expect(service.getTrustStore(source)).rejects.toBeInstanceOf(
            OutdatedTrustListsError,
        );
        expect(loadVerified).toHaveBeenCalledTimes(2);
        vi.setSystemTime(now.getTime() + 59_000);
        await expect(service.getTrustStore(source)).rejects.toBeInstanceOf(
            OutdatedTrustListsError,
        );
        expect(loadVerified).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledTimes(1);

        loadVerified.mockResolvedValue(list(later));
        vi.setSystemTime(now.getTime() + 61_000);
        await expect(service.getTrustStore(source)).resolves.toMatchObject({
            nextUpdate: later.toISOString(),
        });
        expect(loadVerified).toHaveBeenCalledTimes(4);
    });

    it("fetches a source again at once after an error that is not about freshness", async () => {
        vi.useFakeTimers({ now });
        const later = new Date(now.getTime() + 86_400_000);
        const loadVerified = vi
            .fn()
            .mockRejectedValueOnce(new Error("unreachable"))
            .mockResolvedValue(list(later));
        const { service, logger } = createService(loadVerified);

        await expect(service.getTrustStore(source)).rejects.toThrow(
            "unreachable",
        );
        await expect(service.getTrustStore(source)).resolves.toMatchObject({
            nextUpdate: later.toISOString(),
        });
        expect(loadVerified).toHaveBeenCalledTimes(3);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("drops remembered rejections once their minute has run out", async () => {
        vi.useFakeTimers({ now });
        const loadVerified = vi
            .fn()
            .mockResolvedValue(list(new Date(now.getTime() - 60_000)));
        const { service, outdated } = createService(loadVerified);
        const other = { lotes: [source.lotes[0]] };

        await expect(service.getTrustStore(source)).rejects.toThrow();
        expect(outdated.size).toBe(1);
        vi.setSystemTime(now.getTime() + 61_000);
        await expect(service.getTrustStore(other)).rejects.toThrow();
        expect(outdated.size).toBe(1);
    });

    it("fetches an outdated source again at once after the cache is cleared", async () => {
        vi.useFakeTimers({ now });
        const loadVerified = vi
            .fn()
            .mockResolvedValue(list(new Date(now.getTime() - 60_000)));
        const { service } = createService(loadVerified);

        await expect(service.getTrustStore(source)).rejects.toThrow();
        service.clearCache();
        await expect(service.getTrustStore(source)).rejects.toThrow();
        expect(loadVerified).toHaveBeenCalledTimes(4);
    });

    it("uses a renewed list fetched after the cached one reached NextUpdate", async () => {
        vi.useFakeTimers({ now });
        const soon = new Date(now.getTime() + 60_000);
        const later = new Date(now.getTime() + 86_400_000);
        const loadVerified = vi
            .fn()
            .mockResolvedValueOnce(list(later))
            .mockResolvedValueOnce(list(soon))
            .mockResolvedValueOnce(list(later))
            .mockResolvedValueOnce(list(later));
        const { service } = createService(loadVerified);

        await service.getTrustStore(source);
        vi.setSystemTime(now.getTime() + 120_000);

        await expect(service.getTrustStore(source)).resolves.toMatchObject({
            nextUpdate: later.toISOString(),
        });
    });
});
