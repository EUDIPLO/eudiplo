import { describe, expect, it } from "vitest";
import { ServiceTypeIdentifiers } from "../../../trust/types.js";
import { verifierTrustOptions } from "./verifier-trust-options.js";

const trustList = { url: "https://trust.example/lote.jwt" };
const federation = {
    type: "openid_federation" as const,
    values: ["https://ta.example.org/"],
};

describe("verifierTrustOptions", () => {
    it("accepts PID, Pub-EAA and EAA issuance services as credential issuers", () => {
        const options = verifierTrustOptions({
            trustLists: [trustList],
            authorities: undefined,
            skewSeconds: undefined,
        });

        expect(options.trustListSource?.acceptedServiceTypes).toEqual([
            ServiceTypeIdentifiers.PIDIssuance,
            ServiceTypeIdentifiers.PubEaaIssuance,
            ServiceTypeIdentifiers.EaaIssuance,
        ]);
    });

    it("lets an openid_federation authority decide when no trust list is configured", () => {
        const options = verifierTrustOptions({
            trustLists: [],
            tenantId: "tenant",
            authorities: [federation],
            skewSeconds: undefined,
        });

        // The tenant's registered trust anchors provide the pinned keys.
        expect(options.federationTrustSource).toEqual({
            tenantId: "tenant",
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

    it("requires x5c only when a trust list decides", () => {
        const federationOnly = verifierTrustOptions({
            trustLists: [],
            authorities: [federation],
            skewSeconds: undefined,
        });
        const withTrustList = verifierTrustOptions({
            trustLists: [trustList],
            authorities: [federation, { type: "etsi_tl", values: [trustList] }],
            skewSeconds: undefined,
        });

        expect(federationOnly.policy.requireX5c).toBe(false);
        expect(withTrustList.policy.requireX5c).toBe(true);
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
