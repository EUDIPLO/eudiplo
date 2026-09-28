import { describe, expect, it, vi } from "vitest";
import { CollectTrustedEntities } from "./collect-trusted-entities.js";

describe("CollectTrustedEntities", () => {
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
            .mockResolvedValueOnce({ entities: [issuer, other] })
            .mockResolvedValueOnce({ entities: [issuer], nextUpdate: "next" });
        const useCase = new CollectTrustedEntities({ loadVerified });
        await expect(
            useCase.execute({
                lotes: [{ url: "one" }, { url: "two" }],
                acceptedServiceTypes: ["/Issuance"],
            }),
        ).resolves.toEqual({ entities: [issuer, issuer], nextUpdate: "next" });
        expect(loadVerified.mock.calls).toEqual([
            [{ url: "one" }],
            [{ url: "two" }],
        ]);
    });
    it("keeps all entities without a filter and none with an empty filter", async () => {
        const useCase = new CollectTrustedEntities({
            loadVerified: vi
                .fn()
                .mockResolvedValue({ entities: [issuer, other] }),
        });
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
            .mockResolvedValueOnce({ entities: [issuer] })
            .mockRejectedValueOnce(new Error("bad signature"));
        await expect(
            new CollectTrustedEntities({ loadVerified }).execute({
                lotes: [{ url: "one" }, { url: "two" }],
            }),
        ).rejects.toThrow("bad signature");
    });
});
