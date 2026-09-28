import { describe, expect, it, vi } from "vitest";
import { EvaluateFederationTrustChain } from "./evaluate-federation-trust-chain.js";

describe("EvaluateFederationTrustChain", () => {
    it("follows authority hints through intermediate entities", async () => {
        const resolver = {
            resolveEntityConfiguration: async (entityId: string) => {
                if (entityId === "https://leaf.example") {
                    return {
                        sub: entityId,
                        authority_hints: ["https://intermediate.example"],
                    };
                }
                return {
                    sub: entityId,
                    authority_hints: ["https://anchor.example"],
                };
            },
        };

        await expect(
            new EvaluateFederationTrustChain(resolver).execute({
                entityId: "https://leaf.example",
                trustAnchors: ["https://anchor.example"],
            }),
        ).resolves.toEqual({
            trusted: true,
            reason: "entity authority_hints chain to configured trust anchor",
        });
    });

    it("rejects cycles instead of following them forever", async () => {
        const resolver = {
            resolveEntityConfiguration: async (entityId: string) => ({
                sub: entityId,
                authority_hints: [
                    entityId === "https://a.example"
                        ? "https://b.example"
                        : "https://a.example",
                ],
            }),
        };

        await expect(
            new EvaluateFederationTrustChain(resolver).execute({
                entityId: "https://a.example",
                trustAnchors: ["https://anchor.example"],
            }),
        ).resolves.toEqual({
            trusted: false,
            reason: "federation authority_hints chain contains a cycle",
        });
    });
    it("accepts a direct anchor regardless of hint order without fetching unrelated hints", async () => {
        const resolveEntityConfiguration = vi.fn(async (entityId: string) => ({
            sub: entityId,
            authority_hints: [
                "https://dead-end.example",
                "https://anchor.example/",
            ],
        }));
        expect(
            await new EvaluateFederationTrustChain({
                resolveEntityConfiguration,
            }).execute({
                entityId: "https://leaf.example",
                trustAnchors: ["https://anchor.example"],
            }),
        ).toMatchObject({ trusted: true });
        expect(resolveEntityConfiguration).toHaveBeenCalledExactlyOnceWith(
            "https://leaf.example",
        );
    });

    it.each(["dead-end", "cycle", "fetch-error", "subject-mismatch"])(
        "continues past a %s branch to a valid alternate path",
        async (failure) => {
            const resolver = {
                resolveEntityConfiguration: async (id: string) => {
                    if (id === "leaf")
                        return { sub: id, authority_hints: ["bad", "good"] };
                    if (id === "good")
                        return { sub: id, authority_hints: ["anchor"] };
                    if (failure === "fetch-error") throw new Error("offline");
                    if (failure === "cycle")
                        return { sub: id, authority_hints: ["leaf"] };
                    if (failure === "subject-mismatch")
                        return { sub: "wrong", authority_hints: ["anchor"] };
                    return { sub: id, authority_hints: [] };
                },
            };
            expect(
                await new EvaluateFederationTrustChain(resolver).execute({
                    entityId: "leaf",
                    trustAnchors: ["anchor"],
                }),
            ).toMatchObject({ trusted: true });
        },
    );

    it("preserves fetch failures when no alternative succeeds", async () => {
        const error = new Error("offline");
        const resolver = {
            resolveEntityConfiguration: async (id: string) => {
                if (id === "leaf")
                    return { sub: id, authority_hints: ["bad", "dead"] };
                if (id === "bad") throw error;
                return { sub: id, authority_hints: [] };
            },
        };
        await expect(
            new EvaluateFederationTrustChain(resolver).execute({
                entityId: "leaf",
                trustAnchors: ["anchor"],
            }),
        ).rejects.toBe(error);
    });

    it("retains the depth limit and explores a shorter path to a shared intermediate", async () => {
        const resolver = {
            resolveEntityConfiguration: async (id: string) => ({
                sub: id,
                authority_hints:
                    id === "leaf"
                        ? ["0", "shared"]
                        : id === "shared"
                          ? ["anchor"]
                          : Number(id) < 6
                            ? [String(Number(id) + 1)]
                            : ["shared"],
            }),
        };
        expect(
            await new EvaluateFederationTrustChain(resolver).execute({
                entityId: "leaf",
                trustAnchors: ["anchor"],
            }),
        ).toMatchObject({ trusted: true });
        const deep = {
            resolveEntityConfiguration: async (id: string) => ({
                sub: id,
                authority_hints: [String(Number(id) + 1)],
            }),
        };
        expect(
            await new EvaluateFederationTrustChain(deep).execute({
                entityId: "0",
                trustAnchors: ["9"],
            }),
        ).toMatchObject({
            trusted: false,
            reason: "federation authority_hints chain exceeded maximum depth",
        });
        expect(
            await new EvaluateFederationTrustChain(deep).execute({
                entityId: "0",
                trustAnchors: ["8"],
            }),
        ).toMatchObject({ trusted: true });
    });

    it("bounds the total number of resolutions for a hostile fan-out", async () => {
        // Every entity advertises many fresh, never-anchored superiors.
        let counter = 0;
        const resolveEntityConfiguration = vi.fn(async (entityId: string) => ({
            sub: entityId,
            authority_hints: Array.from(
                { length: 50 },
                () => `https://hint-${counter++}.example`,
            ),
        }));

        const result = await new EvaluateFederationTrustChain({
            resolveEntityConfiguration,
        }).execute({
            entityId: "https://leaf.example",
            trustAnchors: ["https://anchor.example"],
        });

        expect(result.trusted).toBe(false);
        expect(resolveEntityConfiguration).toHaveBeenCalledTimes(32);
    });

    it("follows only the first hints of an entity", async () => {
        const resolveEntityConfiguration = vi.fn(async (entityId: string) =>
            entityId === "https://leaf.example"
                ? {
                      sub: entityId,
                      authority_hints: [
                          "https://dead-end-1.example",
                          "https://dead-end-2.example",
                          "https://intermediate.example",
                      ],
                  }
                : entityId === "https://intermediate.example"
                  ? {
                        sub: entityId,
                        authority_hints: ["https://anchor.example"],
                    }
                  : { sub: entityId, authority_hints: [] },
        );
        const evaluate = (maxHintsPerEntity: number) =>
            new EvaluateFederationTrustChain(
                { resolveEntityConfiguration },
                { maxDepth: 8, maxHintsPerEntity, maxResolutions: 32 },
            ).execute({
                entityId: "https://leaf.example",
                trustAnchors: ["https://anchor.example"],
            });

        await expect(evaluate(2)).resolves.toMatchObject({ trusted: false });
        await expect(evaluate(3)).resolves.toMatchObject({ trusted: true });
    });
});
