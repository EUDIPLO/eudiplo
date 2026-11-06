import { describe, expect, it, vi } from "vitest";
import { OutdatedTrustListsError } from "../domain/trust-list-freshness.js";
import { CollectTrustedEntities } from "./collect-trusted-entities.js";

describe("CollectTrustedEntities", () => {
    const now = new Date("2026-11-06T12:00:00Z");
    const clock = () => now;
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
    it("filters entities while retaining paired revocation services and source order", async () => {
        const loadVerified = vi
            .fn()
            .mockResolvedValueOnce({
                entities: [issuer, other],
                nextUpdate: later,
            })
            .mockResolvedValueOnce({ entities: [issuer], nextUpdate: soon });
        const useCase = new CollectTrustedEntities({ loadVerified }, clock);
        await expect(
            useCase.execute({
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
        const useCase = new CollectTrustedEntities(
            {
                loadVerified: vi.fn().mockResolvedValue({
                    entities: [issuer, other],
                    nextUpdate: later,
                }),
            },
            clock,
        );
        expect(
            (await useCase.execute({ lotes: [{ url: "one" }] })).entities,
        ).toEqual([issuer, other]);
        expect(
            (
                await useCase.execute({
                    lotes: [{ url: "one" }],
                    acceptedServiceTypes: [],
                })
            ).entities,
        ).toEqual([]);
    });
    it("propagates verification failures without returning a partial trust store", async () => {
        const loadVerified = vi
            .fn()
            .mockResolvedValueOnce({ entities: [issuer], nextUpdate: later })
            .mockRejectedValueOnce(new Error("bad signature"));
        await expect(
            new CollectTrustedEntities({ loadVerified }, clock).execute({
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
                .mockResolvedValueOnce({
                    entities: [first === passed ? replayed : current],
                    nextUpdate: first,
                })
                .mockResolvedValueOnce({
                    entities: [second === passed ? replayed : current],
                    nextUpdate: second,
                });

            await expect(
                new CollectTrustedEntities({ loadVerified }, clock).execute({
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
        const result = new CollectTrustedEntities(
            {
                loadVerified: vi.fn().mockResolvedValue({
                    entities: [issuer],
                    nextUpdate: passed,
                }),
            },
            clock,
        ).execute({ lotes: [{ url: "one" }, { url: "two" }] });

        await expect(result).rejects.toBeInstanceOf(OutdatedTrustListsError);
        await expect(result).rejects.toMatchObject({
            discarded: [
                { list: "one", nextUpdate: passed },
                { list: "two", nextUpdate: passed },
            ],
        });
        // The message can reach wallets: it names neither list nor date.
        await expect(result).rejects.toThrow(
            "No configured trust list is current: each has no valid NextUpdate or one that has passed",
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
            .mockResolvedValueOnce({ entities: [issuer], nextUpdate })
            .mockResolvedValueOnce({ entities: [issuer], nextUpdate: later });
        await expect(
            new CollectTrustedEntities({ loadVerified }, clock).execute({
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
            .mockResolvedValueOnce({ entities: [issuer], nextUpdate: soon })
            .mockResolvedValueOnce({ entities: [issuer], nextUpdate: later });
        await expect(
            new CollectTrustedEntities({ loadVerified }, clock).execute({
                lotes: [{ url: "one" }, { url: "two" }],
            }),
        ).resolves.toMatchObject({ nextUpdate: soon });
    });

    it("returns no NextUpdate for a source without lists", async () => {
        await expect(
            new CollectTrustedEntities(
                { loadVerified: vi.fn() },
                clock,
            ).execute({ lotes: [] }),
        ).resolves.toEqual({
            entities: [],
            nextUpdate: undefined,
            discarded: [],
        });
    });
});
