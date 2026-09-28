import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { EvaluateFederationTrustChain } from "./application/evaluate-federation-trust-chain.js";
import {
    FEDERATION_RESOLVER,
    type FederationResolver,
} from "./ports/federation-resolver.js";
import { evaluateFederationTrustChainProvider } from "./trust.module.js";

describe("TrustModule wiring", () => {
    it("constructs EvaluateFederationTrustChain with the configured resolver", async () => {
        const resolver: FederationResolver = {
            resolveEntityConfiguration: async (entityId: string) => ({
                sub: entityId,
                authority_hints: ["https://anchor.example"],
            }),
        };

        const moduleRef = await Test.createTestingModule({
            providers: [
                { provide: FEDERATION_RESOLVER, useValue: resolver },
                evaluateFederationTrustChainProvider,
            ],
        }).compile();

        const evaluator = moduleRef.get(EvaluateFederationTrustChain);
        await expect(
            evaluator.execute({
                entityId: "https://leaf.example",
                trustAnchors: ["https://anchor.example"],
            }),
        ).resolves.toMatchObject({ trusted: true });
    });
});
