import { describe, expect, test } from "vitest";
import { disclosurePolicyChanged } from "./disclosure-policy-change.js";

const allowList = (values: string[]) => ({ policy: "allowList", values });

describe("disclosurePolicyChanged", () => {
    test.each([
        ["the update leaves the policy out", allowList(["a"]), undefined],
        ["no policy was stored and none is set", undefined, null],
        ["the stored policy is null and the update clears it", null, null],
        ["the same policy is set again", allowList(["a"]), allowList(["a"])],
        [
            "the keys come in another order",
            { policy: "allowList", values: ["a"] },
            { values: ["a"], policy: "allowList" },
        ],
        [
            "only $schema differs",
            { $schema: "https://example.com/a", ...allowList(["a"]) },
            allowList(["a"]),
        ],
    ])("is unchanged when %s", (_case, stored, requested) => {
        expect(disclosurePolicyChanged(stored, requested)).toBe(false);
    });

    test.each([
        ["a policy is added", undefined, allowList(["a"])],
        ["a policy is added to a null one", null, allowList(["a"])],
        ["the policy is deleted", allowList(["a"]), null],
        ["an allowed value changes", allowList(["a"]), allowList(["b"])],
        ["a value is added", allowList(["a"]), allowList(["a", "b"])],
        [
            "the values are reordered",
            allowList(["a", "b"]),
            allowList(["b", "a"]),
        ],
        ["the policy type changes", allowList(["a"]), { policy: "none" }],
    ])("is changed when %s", (_case, stored, requested) => {
        expect(disclosurePolicyChanged(stored, requested)).toBe(true);
    });
});
