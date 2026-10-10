import { describe, expect, it } from "vitest";
import { missingTrustedAuthorities } from "./trusted-authority-requirement.js";

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
        expect(violation).toContain("SKIP_TRUST_AUTHORITY=true");
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

    it("accepts every query when SKIP_TRUST_AUTHORITY is set", () => {
        expect(
            missingTrustedAuthorities([{ id: "pid" }], true),
        ).toBeUndefined();
    });
});
