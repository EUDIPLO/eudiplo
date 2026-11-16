import { describe, expect, it } from "vitest";
import {
    folderEnvironment,
    maskFilledText,
    maskFilledValues,
} from "../src/commands/config/portability/folder-bundle.js";

describe("folderEnvironment", () => {
    it("hands out only variables named in --allow-env and records them", () => {
        const { env, filled, withheld } = folderEnvironment(
            "ACME_A,ACME_EMPTY",
            {
                EUDIPLO_TOKEN: "t",
                ACME_A: "a",
                OTHER: "o",
                ACME_EMPTY: "",
            },
        );

        expect(env.EUDIPLO_TOKEN).toBeUndefined();
        expect(env.OTHER).toBeUndefined();
        expect(env.ACME_A).toBe("a");
        expect(env.ACME_EMPTY).toBe("");
        expect([...filled]).toEqual([["ACME_A", "a"]]);
        expect(withheld("OTHER")).toBe("not named in --allow-env");
        expect(withheld("ACME_A")).toBeUndefined();
    });

    it("refuses the CLI's own credentials", () => {
        expect(() => folderEnvironment("EUDIPLO_CLIENT_SECRET", {})).toThrow(
            "holds the CLI's own credentials",
        );
    });
});

describe("maskFilledValues", () => {
    it("masks a short value only where it is the whole string", () => {
        expect(maskFilledText("abc", new Map([["V", "abc"]]))).toBe("${V}");
        expect(maskFilledText("xabcx", new Map([["V", "abc"]]))).toBe("xabcx");
    });

    it("masks field values and messages, never kinds, IDs, actions or the fingerprint", () => {
        const filled = new Map([["V", "portal"]]);
        expect(
            maskFilledValues(
                {
                    planFingerprint: "portal",
                    items: [
                        {
                            kind: "Client",
                            id: "portal",
                            action: "update",
                            changes: [
                                {
                                    path: "/spec/x",
                                    before: "portal",
                                    after: ["portal"],
                                },
                            ],
                            issues: [{ code: "X", message: "portal" }],
                        },
                    ],
                },
                filled,
            ),
        ).toEqual({
            planFingerprint: "portal",
            items: [
                {
                    kind: "Client",
                    id: "portal",
                    action: "update",
                    changes: [
                        { path: "/spec/x", before: "${V}", after: ["${V}"] },
                    ],
                    issues: [{ code: "X", message: "${V}" }],
                },
            ],
        });
    });

    it("masks the longest value first, so a value containing another is masked whole", () => {
        expect(
            maskFilledText(
                "x secretvalue1-long y",
                new Map([
                    ["A", "secretvalue1"],
                    ["B", "secretvalue1-long"],
                ]),
            ),
        ).toBe("x ${B} y");
    });

    it("leaves values unchanged when nothing was filled in", () => {
        const plan = { items: [{ after: "secretvalue1" }] };
        expect(maskFilledValues(plan, new Map())).toBe(plan);
    });
});
