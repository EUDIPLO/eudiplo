import { describe, expect, it } from "vitest";
import { verifierTrustOptions } from "./verifier-trust-options.js";

const trustList = { url: "https://trust.example/lote.jwt" };
const federation = {
    type: "openid_federation" as const,
    values: ["https://ta.example.org/"],
};

describe("verifierTrustOptions", () => {
    it("lets an openid_federation authority decide when no trust list is configured", () => {
        const options = verifierTrustOptions({
            trustLists: [],
            authorities: [federation],
            skewSeconds: undefined,
        });

        expect(options.federationTrustSource).toEqual({
            mode: "federation-only",
            trustAnchors: [
                {
                    entityId: "https://ta.example.org/",
                    entityConfigurationUri:
                        "https://ta.example.org/.well-known/openid-federation",
                },
            ],
        });
    });

    it("keeps the trust list deciding when the query also has an etsi_tl entry", () => {
        const options = verifierTrustOptions({
            trustLists: [trustList],
            authorities: [federation, { type: "etsi_tl", values: [trustList] }],
            skewSeconds: undefined,
        });

        expect(options.federationTrustSource).toBeUndefined();
        expect(options.trustListSource?.lotes).toEqual([trustList]);
    });

    it("configures no federation check without federation trust anchors", () => {
        for (const authorities of [
            undefined,
            [{ type: "openid_federation" as const, values: [] }],
        ]) {
            expect(
                verifierTrustOptions({
                    trustLists: [],
                    authorities,
                    skewSeconds: undefined,
                }).federationTrustSource,
            ).toBeUndefined();
        }
    });
});
