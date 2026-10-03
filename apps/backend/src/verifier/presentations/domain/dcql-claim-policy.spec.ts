import { describe, expect, it } from "vitest";
import {
    CLAIM_VALUE_MISMATCH,
    claimSelections,
    claimSetNotSatisfied,
    claimValueMismatchViolation,
    evaluateClaimSelection,
    evaluateMdocClaimSelection,
    findMissingCredentials,
    isClaimSelectionSatisfied,
    missingClaimsViolation,
    sdJwtRequiredClaimKeys,
    selectClaimValues,
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

describe("mdoc claim evaluation", () => {
    it("reports absent elements with their full path", () => {
        const result = evaluateMdocClaimSelection({ given_name: "Erika" }, [
            { path: ["ns", "given_name"] },
            { path: ["ns", "age"] },
        ]);
        expect(result).toEqual({ missing: ["ns.age"], mismatched: [] });
        expect(missingClaimsViolation("pid", result.missing)).toEqual({
            message: "Missing required claims for credential 'pid': ns.age",
            details: { missingClaims: { pid: ["ns.age"] } },
        });
    });

    it("accepts present elements and empty claim queries", () => {
        expect(
            evaluateMdocClaimSelection({ age: 0 }, [{ path: ["ns", "age"] }]),
        ).toEqual({ missing: [], mismatched: [] });
        expect(evaluateMdocClaimSelection({}, [])).toEqual({
            missing: [],
            mismatched: [],
        });
    });

    it("does not treat inherited properties as disclosed elements", () => {
        expect(
            evaluateMdocClaimSelection({}, [{ path: ["ns", "toString"] }])
                .missing,
        ).toEqual(["ns.toString"]);
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

describe("claim selection evaluation", () => {
    it("matches SD-JWT VC payloads on every selected path", () => {
        const payload = {
            address: { locality: "Berlin" },
            nationalities: ["DE"],
        };
        const satisfied = evaluateClaimSelection(payload, [
            { path: ["address", "locality"] },
            { path: ["nationalities", "0"] },
        ]);
        expect(satisfied).toEqual({ missing: [], mismatched: [] });
        expect(isClaimSelectionSatisfied(satisfied)).toBe(true);

        const missing = evaluateClaimSelection(payload, [{ path: ["age"] }]);
        expect(missing).toEqual({ missing: ["age"], mismatched: [] });
        expect(isClaimSelectionSatisfied(missing)).toBe(false);
    });

    it("matches mdoc claims on element names", () => {
        expect(
            evaluateMdocClaimSelection({ age: 1 }, [{ path: ["ns", "age"] }]),
        ).toEqual({ missing: [], mismatched: [] });
        expect(
            evaluateMdocClaimSelection({ age: 1 }, [{ path: ["ns", "name"] }]),
        ).toEqual({ missing: ["ns.name"], mismatched: [] });
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

describe("claim value constraints", () => {
    const over18 = (values: Array<string | number | boolean>) => [
        { path: ["age_equal_or_over", "18"], values },
    ];
    const mdocOver18 = (values: Array<string | number | boolean>) => [
        { path: ["eu.europa.ec.eudi.pid.1", "age_over_18"], values },
    ];

    it("accepts a disclosed value that is one of the requested values", () => {
        expect(
            evaluateClaimSelection(
                { age_equal_or_over: { "18": true } },
                over18([true]),
            ),
        ).toEqual({ missing: [], mismatched: [] });
        expect(
            evaluateClaimSelection({ level: "gold" }, [
                { path: ["level"], values: ["gold", "platinum"] },
            ]),
        ).toEqual({ missing: [], mismatched: [] });
        expect(
            evaluateMdocClaimSelection(
                { age_over_18: true },
                mdocOver18([true]),
            ),
        ).toEqual({ missing: [], mismatched: [] });
    });

    it("rejects a disclosed value that is not requested", () => {
        expect(
            evaluateClaimSelection(
                { age_equal_or_over: { "18": false } },
                over18([true]),
            ),
        ).toEqual({ missing: [], mismatched: ["age_equal_or_over.18"] });
        expect(
            evaluateMdocClaimSelection(
                { age_over_18: false },
                mdocOver18([true]),
            ),
        ).toEqual({
            missing: [],
            mismatched: ["eu.europa.ec.eudi.pid.1.age_over_18"],
        });
    });

    it("requires the requested type, not only an equal rendering", () => {
        const sdJwt = (value: unknown) =>
            evaluateClaimSelection({ age_equal_or_over: { "18": value } }, [
                { path: ["age_equal_or_over", "18"], values: [true, 18] },
            ]).mismatched;
        expect(sdJwt("true")).toEqual(["age_equal_or_over.18"]);
        expect(sdJwt("18")).toEqual(["age_equal_or_over.18"]);
        expect(sdJwt(1)).toEqual(["age_equal_or_over.18"]);
        expect(sdJwt(null)).toEqual(["age_equal_or_over.18"]);
        expect(sdJwt(18)).toEqual([]);

        expect(
            evaluateMdocClaimSelection(
                { age_over_18: "true" },
                mdocOver18([true]),
            ).mismatched,
        ).toEqual(["eu.europa.ec.eudi.pid.1.age_over_18"]);
        expect(
            evaluateMdocClaimSelection(
                { age_over_18: true },
                mdocOver18(["true"]),
            ).mismatched,
        ).toEqual(["eu.europa.ec.eudi.pid.1.age_over_18"]);
    });

    it("reports an undisclosed constrained claim as missing", () => {
        expect(evaluateClaimSelection({}, over18([true]))).toEqual({
            missing: ["age_equal_or_over.18"],
            mismatched: [],
        });
        expect(evaluateMdocClaimSelection({}, mdocOver18([true]))).toEqual({
            missing: ["eu.europa.ec.eudi.pid.1.age_over_18"],
            mismatched: [],
        });
    });

    it("matches when one value selected by a null segment is requested", () => {
        // OID4VP JSON form; configured paths have no null segments.
        const claims = JSON.parse(
            '[{ "path": ["nationalities", null], "values": ["DE"] }]',
        );
        expect(
            evaluateClaimSelection({ nationalities: ["FR", "DE"] }, claims),
        ).toEqual({ missing: [], mismatched: [] });
        expect(
            evaluateClaimSelection({ nationalities: ["FR"] }, claims)
                .mismatched,
        ).toHaveLength(1);
    });

    it("reports the mismatch without the disclosed value", () => {
        const violation = claimValueMismatchViolation("pid", [
            "age_equal_or_over.18",
        ]);
        expect(violation).toEqual({
            code: CLAIM_VALUE_MISMATCH,
            message:
                "Disclosed claim values do not match the requested values for credential 'pid': age_equal_or_over.18",
            details: { mismatchedClaims: { pid: ["age_equal_or_over.18"] } },
        });
        expect(CLAIM_VALUE_MISMATCH).toBe("claim_value_mismatch");
    });
});

describe("selectClaimValues", () => {
    it("walks objects and array indices", () => {
        const value = { a: [{ b: null }], c: 0 };
        expect(selectClaimValues(value, ["a", "0", "b"])).toEqual([null]);
        expect(selectClaimValues(value, ["a", 0, "b"])).toEqual([null]);
        expect(selectClaimValues(value, ["c"])).toEqual([0]);
    });

    it("selects every array element for a null segment", () => {
        const value = { degrees: [{ type: "BSc" }, { type: "MSc" }, {}] };
        expect(selectClaimValues(value, ["degrees", null, "type"])).toEqual([
            "BSc",
            "MSc",
        ]);
        expect(selectClaimValues({ a: {} }, ["a", null])).toEqual([]);
    });

    it("selects nothing for missing, undefined and non-traversable segments", () => {
        const value = { a: [1], b: undefined, c: "text" };
        expect(selectClaimValues(value, ["a", "x"])).toEqual([]);
        expect(selectClaimValues(value, ["a", "-1"])).toEqual([]);
        expect(selectClaimValues(value, ["a", ""])).toEqual([]);
        expect(selectClaimValues(value, ["a", "1"])).toEqual([]);
        expect(selectClaimValues(value, ["b"])).toEqual([]);
        expect(selectClaimValues(value, ["c", "length"])).toEqual([]);
        expect(selectClaimValues(value, ["missing"])).toEqual([]);
        expect(selectClaimValues(value, ["toString"])).toEqual([]);
    });
});
