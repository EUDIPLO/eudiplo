import { describe, expect, it } from "vitest";
import {
    claimSelections,
    claimSetNotSatisfied,
    findMissingCredentials,
    hasClaimPath,
    matchesClaimSelection,
    matchesMdocClaimSelection,
    missingClaimsViolation,
    missingMdocClaims,
    sdJwtRequiredClaimKeys,
    UnknownClaimSetReferenceError,
} from "./dcql-claim-policy.js";

describe("findMissingCredentials", () => {
    const credentials = [{ id: "pid" }, { id: "mdl" }];

    it("requires every credential when there are no credential sets", () => {
        expect(findMissingCredentials(["pid", "mdl"], credentials)).toBe(
            undefined,
        );
        expect(findMissingCredentials(["pid"], credentials)).toEqual({
            message: "Missing required credentials: mdl",
            details: { missingCredentials: ["mdl"] },
        });
    });

    it("accepts any fully present option of each required credential set", () => {
        const sets = [{ options: [["pid"], ["mdl"]] }];
        expect(findMissingCredentials(["mdl"], credentials, sets)).toBe(
            undefined,
        );
    });

    it("reports unsatisfied required sets by index and skips optional sets", () => {
        const sets = [
            { options: [["pid", "mdl"]] },
            { options: [["other"]], required: false },
            { options: [["mdl"]], required: true },
        ];
        expect(findMissingCredentials(["pid"], credentials, sets)).toEqual({
            message: "Credential sets not satisfied: set[0], set[2]",
            details: { unsatisfiedCredentialSets: [0, 2] },
        });
    });
});

describe("sdJwtRequiredClaimKeys", () => {
    it("joins SD-JWT VC paths with dots", () => {
        expect(
            sdJwtRequiredClaimKeys([
                { path: ["address", "locality"] },
                { path: ["age"] },
            ]),
        ).toEqual(["address.locality", "age"]);
    });

    it("returns no keys without claims", () => {
        expect(sdJwtRequiredClaimKeys(undefined)).toEqual([]);
    });
});

describe("missing mdoc claims", () => {
    it("reports absent elements with their full path", () => {
        const missing = missingMdocClaims(
            [{ path: ["ns", "given_name"] }, { path: ["ns", "age"] }],
            { given_name: "Erika" },
        );
        expect(missing).toEqual(["ns.age"]);
        expect(missingClaimsViolation("pid", missing)).toEqual({
            message: "Missing required claims for credential 'pid': ns.age",
            details: { missingClaims: { pid: ["ns.age"] } },
        });
    });

    it("accepts present elements and empty claim queries", () => {
        expect(
            missingMdocClaims([{ path: ["ns", "age"] }], { age: 0 }),
        ).toEqual([]);
        expect(missingMdocClaims(undefined, {})).toEqual([]);
    });
});

describe("claimSelections", () => {
    const claims = [
        { id: "a", path: ["a"] },
        { id: "b", path: ["b"] },
    ];

    it("returns all claims as the single selection without claim sets", () => {
        expect(claimSelections({ id: "pid", claims })).toEqual([claims]);
        expect(claimSelections({ id: "pid" })).toEqual([[]]);
    });

    it("resolves each claim set option by claim id", () => {
        expect(
            claimSelections({ id: "pid", claims, claim_sets: [["b"], ["a"]] }),
        ).toEqual([[claims[1]], [claims[0]]]);
    });

    it("rejects unknown claim ids", () => {
        expect(() =>
            claimSelections({ id: "pid", claims, claim_sets: [["c"]] }),
        ).toThrow(new UnknownClaimSetReferenceError("c", "pid").message);
    });
});

describe("claim selection matching", () => {
    it("matches SD-JWT VC payloads on every selected path", () => {
        const payload = {
            address: { locality: "Berlin" },
            nationalities: ["DE"],
        };
        const all = [{ path: ["address", "locality"] }, { path: ["age"] }];
        expect(
            matchesClaimSelection(payload, all, [
                { path: ["address", "locality"] },
                { path: ["nationalities", "0"] },
            ]),
        ).toBe(true);
        expect(matchesClaimSelection(payload, all, [{ path: ["age"] }])).toBe(
            false,
        );
    });

    it("only matches an empty selection when the query has no claims", () => {
        expect(matchesClaimSelection({}, [], [])).toBe(true);
        expect(matchesClaimSelection({}, undefined, [{ path: ["a"] }])).toBe(
            false,
        );
    });

    it("matches mdoc claims on element names", () => {
        expect(
            matchesMdocClaimSelection({ age: 1 }, [{ path: ["ns", "age"] }]),
        ).toBe(true);
        expect(
            matchesMdocClaimSelection({ age: 1 }, [{ path: ["ns", "name"] }]),
        ).toBe(false);
    });

    it("reports all claim paths when no claim set is satisfied", () => {
        expect(
            claimSetNotSatisfied({
                id: "pid",
                claims: [{ path: ["a", "b"] }],
            }),
        ).toEqual({
            message: 'Credential "pid" does not satisfy any claim_set',
            details: { missingClaims: { pid: ["a.b"] } },
        });
    });
});

describe("hasClaimPath", () => {
    it("walks objects and array indices", () => {
        const value = { a: [{ b: null }], c: 0 };
        expect(hasClaimPath(value, ["a", "0", "b"])).toBe(true);
        expect(hasClaimPath(value, ["c"])).toBe(true);
    });

    it("rejects missing, undefined and non-traversable segments", () => {
        const value = { a: [1], b: undefined, c: "text" };
        expect(hasClaimPath(value, ["a", "x"])).toBe(false);
        expect(hasClaimPath(value, ["a", "-1"])).toBe(false);
        expect(hasClaimPath(value, ["b"])).toBe(false);
        expect(hasClaimPath(value, ["c", "length"])).toBe(false);
        expect(hasClaimPath(value, ["missing"])).toBe(false);
    });
});
