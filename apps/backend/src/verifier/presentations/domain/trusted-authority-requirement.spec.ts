import { describe, expect, it } from "vitest";
import {
    federationTrustAnchorIds,
    missingTrustedAuthorities,
} from "./trusted-authority-requirement.js";

const trustList = {
    type: "etsi_tl" as const,
    values: [{ trustListId: "pid-issuers" }],
};
const federation = {
    type: "openid_federation" as const,
    values: ["https://ta.example.org/"],
};

describe("missingTrustedAuthorities", () => {
    it("accepts credential queries with a trust list or federation trust anchor", () => {
        expect(
            missingTrustedAuthorities(
                [
                    { id: "pid", trusted_authorities: [trustList] },
                    { id: "mdl", trusted_authorities: [federation] },
                ],
                false,
            ),
        ).toBeUndefined();
    });

    it("names every credential query without a trusted authority", () => {
        const violation = missingTrustedAuthorities(
            [
                { id: "pid" },
                { id: "mdl", trusted_authorities: [] },
                { id: "diploma", trusted_authorities: [trustList] },
            ],
            false,
        );

        expect(violation).toContain(
            "Credential queries without trusted_authorities: pid, mdl.",
        );
        expect(violation).toContain("allowUntrustedIssuers");
    });

    it("does not count an entry without values", () => {
        expect(
            missingTrustedAuthorities(
                [
                    {
                        id: "pid",
                        trusted_authorities: [{ ...trustList, values: [] }],
                    },
                ],
                false,
            ),
        ).toContain("without trusted_authorities: pid.");
    });

    it("requires trusted authorities when allowUntrustedIssuers is null or unset", () => {
        for (const allow of [null, undefined]) {
            expect(missingTrustedAuthorities([{ id: "pid" }], allow)).toContain(
                "without trusted_authorities: pid.",
            );
        }
    });

    it("accepts every query when the config sets allowUntrustedIssuers", () => {
        expect(
            missingTrustedAuthorities([{ id: "pid" }], true),
        ).toBeUndefined();
    });
});

describe("federationTrustAnchorIds", () => {
    it("returns the openid_federation values of queries that federation decides", () => {
        expect(
            federationTrustAnchorIds([
                {
                    trusted_authorities: [
                        {
                            type: "openid_federation",
                            values: ["https://ta.example.org", 42],
                        },
                    ],
                },
                {
                    // The trust list decides; federation keys are never used.
                    trusted_authorities: [
                        { type: "etsi_tl", values: [{ trustListId: "pid" }] },
                        {
                            type: "openid_federation",
                            values: ["https://ignored.example.org"],
                        },
                    ],
                },
                {},
            ]),
        ).toEqual(["https://ta.example.org"]);
    });
});
