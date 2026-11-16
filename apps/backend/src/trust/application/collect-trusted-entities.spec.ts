import { describe, expect, it, vi } from "vitest";
import { acceptedSequenceNumbersFake } from "../../../test/trust/accepted-trust-list-sequence-numbers.fake.js";
import {
    MAX_TRUST_LIST_CERTIFICATES,
    TooManyTrustListCertificatesError,
} from "../domain/trust-list-certificate-limit.js";
import {
    OutdatedTrustListsError,
    UnavailableTrustedListsError,
} from "../domain/trust-list-freshness.js";
import {
    MAX_FOLLOWED_TRUSTED_LISTS,
    TooManyTrustedListsError,
} from "../domain/trusted-list-services.js";
import type { AcceptedTrustListSequenceNumbers } from "../ports/accepted-trust-list-sequence-numbers.js";
import type {
    TrustListProvider,
    VerifiedTrustList,
} from "../ports/trust-list-provider.js";
import { CollectTrustedEntities } from "./collect-trusted-entities.js";

describe("CollectTrustedEntities", () => {
    const now = new Date("2026-11-06T12:00:00Z");
    const clock = () => now;
    const tenantId = "t";
    const later = "2026-12-01T00:00:00Z";
    const soon = "2026-11-10T00:00:00Z";
    const passed = "2026-11-01T00:00:00Z";
    const issuer = {
        entityId: "issuer",
        services: [
            {
                serviceTypeIdentifier: "urn:test/Issuance",
                certValue: "issuance",
            },
            {
                serviceTypeIdentifier: "urn:test/Revocation",
                certValue: "revocation",
            },
        ],
    };
    const other = {
        services: [{ serviceTypeIdentifier: "urn:other", certValue: "other" }],
    };
    const collect = (
        lists: TrustListProvider,
        numbers: AcceptedTrustListSequenceNumbers = acceptedSequenceNumbersFake(),
    ) => new CollectTrustedEntities(lists, numbers, clock);
    /** A verified list, current and numbered 1 unless given otherwise. */
    const list = (
        overrides: Partial<VerifiedTrustList> = {},
    ): VerifiedTrustList => ({
        entities: [issuer],
        nextUpdate: later,
        sequenceNumber: 1,
        ...overrides,
    });

    it("filters entities while retaining paired revocation services and source order", async () => {
        const loadVerified = vi
            .fn()
            .mockResolvedValueOnce(list({ entities: [issuer, other] }))
            .mockResolvedValueOnce(list({ nextUpdate: soon }));
        await expect(
            collect({ loadVerified }).execute({
                tenantId,
                lotes: [{ url: "one" }, { url: "two" }],
                acceptedServiceTypes: ["/Issuance"],
            }),
        ).resolves.toEqual({
            entities: [issuer, issuer],
            nextUpdate: soon,
            discarded: [],
        });
        expect(loadVerified.mock.calls).toEqual([
            [{ url: "one" }],
            [{ url: "two" }],
        ]);
    });

    it("keeps all entities without a filter and none with an empty filter", async () => {
        const useCase = collect({
            loadVerified: vi
                .fn()
                .mockResolvedValue(list({ entities: [issuer, other] })),
        });
        expect(
            (await useCase.execute({ tenantId, lotes: [{ url: "one" }] }))
                .entities,
        ).toEqual([issuer, other]);
        expect(
            (
                await useCase.execute({
                    tenantId,
                    lotes: [{ url: "one" }],
                    acceptedServiceTypes: [],
                })
            ).entities,
        ).toEqual([]);
    });

    it("propagates verification failures without returning a partial trust store", async () => {
        const loadVerified = vi
            .fn()
            .mockResolvedValueOnce(list())
            .mockRejectedValueOnce(new Error("bad signature"));
        await expect(
            collect({ loadVerified }).execute({
                tenantId,
                lotes: [{ url: "one" }, { url: "two" }],
            }),
        ).rejects.toThrow("bad signature");
    });

    // A replayed older list keeps its valid signature; only its NextUpdate
    // shows that a newer list may have removed or withdrawn an entity. It is
    // discarded on its own (ETSI TS 119 602 §6.3.15), the others still count.
    it.each([
        ["the first", [passed, later], "one"],
        ["the second", [later, passed], "two"],
    ] as const)(
        "discards only %s list when it is past its NextUpdate",
        async (_position, [first, second], outdatedUrl) => {
            const current = { entityId: "current", services: issuer.services };
            const replayed = {
                entityId: "replayed",
                services: issuer.services,
            };
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce(
                    list({
                        entities: [first === passed ? replayed : current],
                        nextUpdate: first,
                    }),
                )
                .mockResolvedValueOnce(
                    list({
                        entities: [second === passed ? replayed : current],
                        nextUpdate: second,
                    }),
                );

            await expect(
                collect({ loadVerified }).execute({
                    tenantId,
                    lotes: [{ url: "one" }, { url: "two" }],
                }),
            ).resolves.toEqual({
                entities: [current],
                nextUpdate: later,
                discarded: [{ list: outdatedUrl, nextUpdate: passed }],
            });
        },
    );

    it("rejects the source when every list is past its NextUpdate", async () => {
        const result = collect({
            loadVerified: vi
                .fn()
                .mockResolvedValue(list({ nextUpdate: passed })),
        }).execute({ tenantId, lotes: [{ url: "one" }, { url: "two" }] });

        await expect(result).rejects.toBeInstanceOf(OutdatedTrustListsError);
        await expect(result).rejects.toMatchObject({
            discarded: [
                { list: "one", nextUpdate: passed },
                { list: "two", nextUpdate: passed },
            ],
        });
        // The message can reach wallets: it names neither list nor date.
        await expect(result).rejects.toThrow(
            "No configured trust list is current: each has no valid NextUpdate or one that has passed, no valid LoTESequenceNumber, or a lower one than a list accepted before",
        );
        await expect(result).rejects.not.toThrow("2026");
    });

    it.each([
        ["no", undefined],
        ["a null (closed list)", null],
        ["an unreadable", "soon"],
        ["exactly the current", now.toISOString()],
    ])("discards a list with %s NextUpdate", async (_case, nextUpdate) => {
        const loadVerified = vi
            .fn()
            .mockResolvedValueOnce(list({ nextUpdate }))
            .mockResolvedValueOnce(list());
        await expect(
            collect({ loadVerified }).execute({
                tenantId,
                lotes: [{ url: "one" }, { url: "two" }],
            }),
        ).resolves.toMatchObject({
            entities: [issuer],
            discarded: [{ list: "one", nextUpdate }],
        });
    });

    it("keeps the earliest NextUpdate when it comes from the first list", async () => {
        const loadVerified = vi
            .fn()
            .mockResolvedValueOnce(list({ nextUpdate: soon }))
            .mockResolvedValueOnce(list());
        await expect(
            collect({ loadVerified }).execute({
                tenantId,
                lotes: [{ url: "one" }, { url: "two" }],
            }),
        ).resolves.toMatchObject({ nextUpdate: soon });
    });

    it("returns no NextUpdate for a source without lists", async () => {
        await expect(
            collect({ loadVerified: vi.fn() }).execute({ tenantId, lotes: [] }),
        ).resolves.toEqual({
            entities: [],
            nextUpdate: undefined,
            discarded: [],
        });
    });

    describe("sequence numbers", () => {
        const current = { entityId: "current", services: issuer.services };
        const removed = { entityId: "removed", services: issuer.services };

        // An older list replayed before its NextUpdate has passed still names
        // an issuer the newer list removed; its lower number gives it away.
        it("discards a list numbered lower than one accepted before from the same URL", async () => {
            const numbers = acceptedSequenceNumbersFake({ "t one": 5 });
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce(
                    list({ entities: [removed], sequenceNumber: 4 }),
                )
                .mockResolvedValueOnce(list({ entities: [current] }));

            await expect(
                collect({ loadVerified }, numbers).execute({
                    tenantId,
                    lotes: [{ url: "one" }, { url: "two" }],
                }),
            ).resolves.toEqual({
                entities: [current],
                nextUpdate: later,
                discarded: [
                    {
                        list: "one",
                        nextUpdate: later,
                        sequence: { number: 4, highestAccepted: 5 },
                    },
                ],
            });
            // The replayed list leaves the remembered number as it was.
            expect(numbers.record).not.toHaveBeenCalledWith(
                tenantId,
                "one",
                expect.anything(),
            );
        });

        it("accepts the list accepted before and remembers a newer one", async () => {
            const numbers = acceptedSequenceNumbersFake({ "t one": 5 });
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce(list({ sequenceNumber: 5 }))
                .mockResolvedValueOnce(list({ sequenceNumber: 6 }))
                .mockResolvedValueOnce(list({ sequenceNumber: 5 }));
            const useCase = collect({ loadVerified }, numbers);
            const source = { tenantId, lotes: [{ url: "one" }] };

            await expect(useCase.execute(source)).resolves.toMatchObject({
                discarded: [],
            });
            // The same number again is the same list: nothing to write.
            expect(numbers.record).not.toHaveBeenCalled();

            await expect(useCase.execute(source)).resolves.toMatchObject({
                discarded: [],
            });
            expect(numbers.record).toHaveBeenCalledWith(tenantId, "one", 6);

            // Once the newer list was accepted, the one before is older.
            await expect(useCase.execute(source)).rejects.toMatchObject({
                discarded: [
                    {
                        list: "one",
                        sequence: { number: 5, highestAccepted: 6 },
                    },
                ],
            });
        });

        it("remembers the first list accepted from a URL", async () => {
            const numbers = acceptedSequenceNumbersFake();
            await collect(
                { loadVerified: vi.fn().mockResolvedValue(list()) },
                numbers,
            ).execute({ tenantId, lotes: [{ url: "one" }] });
            expect(numbers.record).toHaveBeenCalledWith(tenantId, "one", 1);
        });

        it("compares a list only with the numbers of the same tenant and URL", async () => {
            const numbers = acceptedSequenceNumbersFake({
                "u one": 9,
                "t two": 9,
            });
            await expect(
                collect(
                    { loadVerified: vi.fn().mockResolvedValue(list()) },
                    numbers,
                ).execute({ tenantId, lotes: [{ url: "one" }] }),
            ).resolves.toMatchObject({ discarded: [] });
            expect(numbers.highest).toHaveBeenCalledWith(tenantId, "one");
        });

        // EUDIPLO numbers a managed list it creates again from 1; its stored
        // number decides, and nothing is remembered for its URL.
        it("compares a managed list with its stored number instead of the remembered ones", async () => {
            const numbers = acceptedSequenceNumbersFake({ "t managed": 7 });
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce(list({ sequenceNumber: 2 }))
                .mockResolvedValueOnce(list({ sequenceNumber: 1 }));
            const useCase = collect({ loadVerified }, numbers);

            await expect(
                useCase.execute({
                    tenantId,
                    lotes: [{ url: "managed", storedSequenceNumber: 2 }],
                }),
            ).resolves.toMatchObject({ discarded: [] });
            expect(numbers.highest).not.toHaveBeenCalled();
            expect(numbers.record).not.toHaveBeenCalled();

            // A list older than the stored one, for example from a cache in
            // front of PUBLIC_URL, is discarded.
            await expect(
                useCase.execute({
                    tenantId,
                    lotes: [{ url: "managed", storedSequenceNumber: 2 }],
                }),
            ).rejects.toMatchObject({
                discarded: [
                    {
                        list: "managed",
                        sequence: {
                            number: 1,
                            highestAccepted: 2,
                            stored: true,
                        },
                    },
                ],
            });
        });

        it.each([
            ["no", undefined],
            ["a zero", 0],
            ["a fractional", 1.5],
            ["a text", "3"],
        ])(
            "discards a list with %s LoTESequenceNumber",
            async (_case, sequenceNumber) => {
                const numbers = acceptedSequenceNumbersFake();
                const loadVerified = vi
                    .fn()
                    .mockResolvedValueOnce(list({ sequenceNumber }))
                    .mockResolvedValueOnce(list({ entities: [current] }));
                await expect(
                    collect({ loadVerified }, numbers).execute({
                        tenantId,
                        lotes: [{ url: "one" }, { url: "two" }],
                    }),
                ).resolves.toEqual({
                    entities: [current],
                    nextUpdate: later,
                    discarded: [
                        {
                            list: "one",
                            nextUpdate: later,
                            sequence: { number: sequenceNumber },
                        },
                    ],
                });
                expect(numbers.record).toHaveBeenCalledTimes(1);
                expect(numbers.record).toHaveBeenCalledWith(tenantId, "two", 1);
            },
        );

        it("names the passed NextUpdate of a list that is also numbered lower", async () => {
            const numbers = acceptedSequenceNumbersFake({ "t one": 5 });
            await expect(
                collect(
                    {
                        loadVerified: vi
                            .fn()
                            .mockResolvedValue(
                                list({ nextUpdate: passed, sequenceNumber: 4 }),
                            ),
                    },
                    numbers,
                ).execute({ tenantId, lotes: [{ url: "one" }] }),
            ).rejects.toMatchObject({
                discarded: [{ list: "one", nextUpdate: passed }],
            });
            expect(numbers.highest).not.toHaveBeenCalled();
        });

        it("rejects the source when its only list is numbered lower than one accepted before", async () => {
            const result = collect(
                {
                    loadVerified: vi
                        .fn()
                        .mockResolvedValue(list({ sequenceNumber: 1 })),
                },
                acceptedSequenceNumbersFake({ "t one": 2 }),
            ).execute({ tenantId, lotes: [{ url: "one" }] });

            await expect(result).rejects.toBeInstanceOf(
                OutdatedTrustListsError,
            );
        });
    });

    // Every certificate of the store is parsed and put in the path builder's
    // pool for each check against it, and a list may hold some 25,000.
    describe("certificate limit", () => {
        /** An entity with `count` certificates of `serviceType`. */
        const withCertificates = (
            entityId: string,
            count: number,
            serviceType = "urn:test/Issuance",
        ) => ({
            entityId,
            services: Array.from({ length: count }, (_, i) => ({
                serviceTypeIdentifier: serviceType,
                certValue: `${entityId}-${i}`,
            })),
        });

        it(`accepts lists with ${MAX_TRUST_LIST_CERTIFICATES} certificates together`, async () => {
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce(
                    list({ entities: [withCertificates("a", 600)] }),
                )
                .mockResolvedValueOnce(
                    list({ entities: [withCertificates("b", 400)] }),
                );

            await expect(
                collect({ loadVerified }).execute({
                    tenantId,
                    lotes: [{ url: "one" }, { url: "two" }],
                }),
            ).resolves.toMatchObject({
                entities: [{ entityId: "a" }, { entityId: "b" }],
            });
        });

        it(`rejects the source when its lists hold more than ${MAX_TRUST_LIST_CERTIFICATES}, without loading the lists after`, async () => {
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce(
                    list({ entities: [withCertificates("a", 600)] }),
                )
                .mockResolvedValueOnce(
                    list({ entities: [withCertificates("b", 401)] }),
                )
                .mockResolvedValueOnce(list());

            const result = collect({ loadVerified }).execute({
                tenantId,
                lotes: [{ url: "one" }, { url: "two" }, { url: "three" }],
            });

            await expect(result).rejects.toBeInstanceOf(
                TooManyTrustListCertificatesError,
            );
            await expect(result).rejects.toMatchObject({
                list: "two",
                certificates: 1001,
                message:
                    "Trust list two brings the certificates of its source to 1001; at most 1000 are accepted",
            });
            expect(loadVerified).toHaveBeenCalledTimes(2);
        });

        // The list that goes over the limit is signed and current: its
        // number is authentic, and an older version must not be replayed
        // once the source fits again.
        it("remembers the sequence number of the list that goes over the limit as well", async () => {
            const numbers = acceptedSequenceNumbersFake();
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce(
                    list({ entities: [withCertificates("a", 600)] }),
                )
                .mockResolvedValueOnce(
                    list({ entities: [withCertificates("b", 401)] }),
                );

            await expect(
                collect({ loadVerified }, numbers).execute({
                    tenantId,
                    lotes: [{ url: "one" }, { url: "two" }],
                }),
            ).rejects.toBeInstanceOf(TooManyTrustListCertificatesError);
            expect(numbers.record.mock.calls).toEqual([
                [tenantId, "one", 1],
                [tenantId, "two", 1],
            ]);
        });

        it("counts only the entities kept", async () => {
            const loadVerified = vi.fn().mockResolvedValue(
                list({
                    entities: [
                        withCertificates("kept", MAX_TRUST_LIST_CERTIFICATES),
                        withCertificates("left out", 500, "urn:other"),
                    ],
                }),
            );

            await expect(
                collect({ loadVerified }).execute({
                    tenantId,
                    lotes: [{ url: "one" }],
                    acceptedServiceTypes: ["/Issuance"],
                }),
            ).resolves.toMatchObject({ entities: [{ entityId: "kept" }] });
        });

        it("counts every certificate of an entity kept, also of the services not accepted", async () => {
            const kept = withCertificates("kept", MAX_TRUST_LIST_CERTIFICATES);
            kept.services.push({
                serviceTypeIdentifier: "urn:other",
                certValue: "other",
            });

            await expect(
                collect({
                    loadVerified: vi
                        .fn()
                        .mockResolvedValue(list({ entities: [kept] })),
                }).execute({
                    tenantId,
                    lotes: [{ url: "one" }],
                    acceptedServiceTypes: ["/Issuance"],
                }),
            ).rejects.toBeInstanceOf(TooManyTrustListCertificatesError);
        });

        it("leaves discarded lists out of the count", async () => {
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce(
                    list({
                        entities: [withCertificates("outdated", 600)],
                        nextUpdate: passed,
                    }),
                )
                .mockResolvedValueOnce(
                    list({ entities: [withCertificates("current", 600)] }),
                );

            await expect(
                collect({ loadVerified }).execute({
                    tenantId,
                    lotes: [{ url: "one" }, { url: "two" }],
                }),
            ).resolves.toMatchObject({
                entities: [{ entityId: "current" }],
            });
        });
    });

    // An ETSI TS 119 612 list of trusted lists names no issuers; the national
    // lists it points to are loaded and checked one by one.
    describe("lists of trusted lists", () => {
        const lotlRef = {
            format: "trusted-list" as const,
            url: "lotl",
            signingCertificates: ["lotl-signer"],
        };
        const pointer = (url: string) => ({
            format: "trusted-list" as const,
            url,
            signingCertificates: [`${url}-signer`],
        });
        const qtsp = (entityId: string) => ({
            entityId,
            services: [
                {
                    serviceTypeIdentifier:
                        "http://uri.etsi.org/TrstSvc/Svctype/EAA/Q",
                    certValue: entityId,
                },
            ],
        });
        const lotl = (
            pointers = [pointer("de"), pointer("fr")],
            overrides: Partial<VerifiedTrustList> = {},
        ) => list({ entities: [], pointers, ...overrides });
        const execute = (
            lists: TrustListProvider,
            numbers = acceptedSequenceNumbersFake(),
        ) =>
            collect(lists, numbers).execute({
                tenantId,
                lotes: [lotlRef],
            });

        it("follows the pointers of an accepted list, one level deep", async () => {
            const loadVerified = vi
                .fn()
                // QTSPs on the list of trusted lists itself are not trusted.
                .mockResolvedValueOnce(
                    lotl(undefined, {
                        nextUpdate: soon,
                        entities: [qtsp("in-lotl")],
                    }),
                )
                .mockResolvedValueOnce(
                    // A list it points to that points on is not followed.
                    list({
                        entities: [qtsp("qp-de")],
                        pointers: [pointer("nested")],
                    }),
                )
                .mockResolvedValueOnce(list({ entities: [qtsp("qp-fr")] }));

            await expect(execute({ loadVerified })).resolves.toEqual({
                entities: [qtsp("qp-de"), qtsp("qp-fr")],
                // The national lists are verified with certificates of the
                // LOTL, so the store ends with it.
                nextUpdate: soon,
                discarded: [],
            });
            expect(loadVerified.mock.calls).toEqual([
                [lotlRef],
                [pointer("de")],
                [pointer("fr")],
            ]);
        });

        it("discards a national list that cannot be loaded on its own", async () => {
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce(lotl())
                .mockRejectedValueOnce(new Error("bad signature"))
                .mockResolvedValueOnce(list({ entities: [qtsp("qp-fr")] }));

            await expect(execute({ loadVerified })).resolves.toEqual({
                entities: [qtsp("qp-fr")],
                nextUpdate: later,
                discarded: [
                    {
                        list: "de",
                        nextUpdate: undefined,
                        trustedList: true,
                        unavailable: "bad signature",
                    },
                ],
            });
        });

        it("discards an outdated or replayed national list on its own", async () => {
            const numbers = acceptedSequenceNumbersFake();
            await numbers.record(tenantId, "fr", 4);
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce(
                    lotl([pointer("de"), pointer("fr"), pointer("it")]),
                )
                .mockResolvedValueOnce(list({ nextUpdate: passed }))
                .mockResolvedValueOnce(list({ sequenceNumber: 3 }))
                .mockResolvedValueOnce(list({ entities: [qtsp("qp-it")] }));

            await expect(execute({ loadVerified }, numbers)).resolves.toEqual({
                entities: [qtsp("qp-it")],
                nextUpdate: later,
                discarded: [
                    { list: "de", nextUpdate: passed, trustedList: true },
                    {
                        list: "fr",
                        nextUpdate: later,
                        trustedList: true,
                        sequence: { number: 3, highestAccepted: 4 },
                    },
                ],
            });
            expect(await numbers.highest(tenantId, "it")).toBe(1);
        });

        it("does not follow a list of trusted lists numbered lower than one accepted before", async () => {
            const numbers = acceptedSequenceNumbersFake();
            await numbers.record(tenantId, "lotl", 5);
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce(lotl(undefined, { sequenceNumber: 3 }));

            await expect(
                execute({ loadVerified }, numbers),
            ).rejects.toBeInstanceOf(OutdatedTrustListsError);
            expect(loadVerified).toHaveBeenCalledTimes(1);
        });

        it("does not follow an outdated list of trusted lists", async () => {
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce(lotl(undefined, { nextUpdate: passed }));

            await expect(execute({ loadVerified })).rejects.toBeInstanceOf(
                OutdatedTrustListsError,
            );
            expect(loadVerified).toHaveBeenCalledTimes(1);
        });

        it("fails when every national list is left out and one could not be loaded", async () => {
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce(
                    lotl([
                        pointer("https://tl.example/de"),
                        pointer("https://tl.example/fr"),
                    ]),
                )
                .mockRejectedValueOnce(new Error("unreachable"))
                .mockResolvedValueOnce(list({ nextUpdate: passed }));

            const error = await execute({ loadVerified }).catch((e) => e);
            expect(error).toBeInstanceOf(UnavailableTrustedListsError);
            // Wallet-facing like OutdatedTrustListsError: names no list.
            expect(error.message).not.toContain("tl.example");
            expect(error.discarded).toHaveLength(2);
        });

        it("fails when every national list is outdated", async () => {
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce(lotl([pointer("de")]))
                .mockResolvedValueOnce(list({ nextUpdate: passed }));

            await expect(execute({ loadVerified })).rejects.toBeInstanceOf(
                OutdatedTrustListsError,
            );
        });

        it("trusts no issuer when no pointer is left to follow", async () => {
            const loadVerified = vi.fn().mockResolvedValueOnce(lotl([]));

            await expect(execute({ loadVerified })).resolves.toEqual({
                entities: [],
                nextUpdate: later,
                discarded: [],
            });
        });

        it("refuses a list of trusted lists that points to too many lists", async () => {
            const pointers = Array.from(
                { length: MAX_FOLLOWED_TRUSTED_LISTS + 1 },
                (_, i) => pointer(`list-${i}`),
            );
            const loadVerified = vi.fn().mockResolvedValueOnce(lotl(pointers));

            await expect(execute({ loadVerified })).rejects.toBeInstanceOf(
                TooManyTrustedListsError,
            );
            expect(loadVerified).toHaveBeenCalledTimes(1);
        });

        it("counts the certificates of the national lists toward the limit", async () => {
            const many = {
                entityId: "many",
                services: Array.from(
                    { length: MAX_TRUST_LIST_CERTIFICATES + 1 },
                    (_, i) => ({
                        serviceTypeIdentifier:
                            "http://uri.etsi.org/TrstSvc/Svctype/EAA/Q",
                        certValue: `c${i}`,
                    }),
                ),
            };
            const loadVerified = vi
                .fn()
                .mockResolvedValueOnce(lotl([pointer("de")]))
                .mockResolvedValueOnce(list({ entities: [many] }));

            await expect(execute({ loadVerified })).rejects.toBeInstanceOf(
                TooManyTrustListCertificatesError,
            );
        });
    });
});
