import { describe, expect, it } from "vitest";
import { claimPatternProblem } from "./claim-patterns.js";
import {
    findUnsupportedClaimPatterns,
    sanitizeClaimConstraints,
    sanitizeClaimFields,
} from "./claim-constraints.js";

describe("sanitizeClaimConstraints", () => {
    it("keeps allow-listed keywords and subschemas unchanged", () => {
        const constraints = {
            minItems: 1,
            items: { type: "string", pattern: "^[A-Z]{2}$" },
            contains: true,
            anyOf: [{ maxItems: 3 }, false],
            properties: { note: { type: "string" } },
        };

        expect(sanitizeClaimConstraints(constraints)).toEqual({
            constraints,
            removed: [],
        });
    });

    it.each([
        ["an unknown keyword", { widget: {} }, ["/widget"]],
        ["a subschema that is no object", { items: "string" }, ["/items"]],
        ["a list keyword that is no array", { anyOf: {} }, ["/anyOf"]],
        ["a map keyword that is no object", { properties: [] }, ["/properties"]],
        [
            "an unknown keyword in a list entry",
            { oneOf: [{ minLength: 1, $ref: "#" }, 3] },
            ["/oneOf/0/$ref", "/oneOf/1"],
        ],
        [
            "an unknown keyword in a map entry, escaping the pointer",
            { patternProperties: { "a/b~c": { "x-ui": 1 } } },
            ["/patternProperties/a~1b~0c/x-ui"],
        ],
    ])("removes %s", (_, constraints, removed) => {
        expect(sanitizeClaimConstraints(constraints).removed).toEqual(removed);
    });

    it("returns an empty object for constraints that are no object", () => {
        expect(sanitizeClaimConstraints("pattern")).toEqual({
            constraints: {},
            removed: [""],
        });
    });

    it("keeps a __proto__ property name as data", () => {
        const { constraints } = sanitizeClaimConstraints(
            JSON.parse('{"properties":{"__proto__":{"type":"string"}}}'),
        );
        const properties = constraints.properties as Record<string, unknown>;

        expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
        expect(
            Object.getOwnPropertyDescriptor(properties, "__proto__")?.value,
        ).toEqual({ type: "string" });
    });
});

describe("sanitizeClaimFields", () => {
    it("sanitizes nested children and returns pointers from the given path", () => {
        const fields = [
            {
                path: ["nationalities"],
                type: "array",
                constraints: { minItems: 1 },
                children: [
                    {
                        path: [null],
                        type: "string",
                        constraints: { minLength: 2, format: "iso-3166" },
                    },
                ],
            },
        ];

        expect(sanitizeClaimFields(fields, "/spec/fields")).toEqual({
            fields: [
                {
                    ...fields[0],
                    children: [
                        {
                            path: [null],
                            type: "string",
                            constraints: { minLength: 2 },
                        },
                    ],
                },
            ],
            removed: ["/spec/fields/0/children/0/constraints/format"],
        });
    });

    it("passes entries and constraints that are no object through", () => {
        const fields = [1, { path: ["a"], type: "string", constraints: "x" }];

        expect(sanitizeClaimFields(fields)).toEqual({ fields, removed: [] });
    });

    it("returns fields without unsupported keywords unchanged", () => {
        const fields = [
            { path: ["name"], type: "string", constraints: { minLength: 1 } },
        ];
        const result = sanitizeClaimFields(fields);

        expect(result.removed).toEqual([]);
        expect(result.fields[0]).toBe(fields[0]);
    });
});

describe("findUnsupportedClaimPatterns", () => {
    it("reports patterns and patternProperties keys RE2 cannot run, with their path", () => {
        const fields = [
            {
                path: ["name"],
                type: "string",
                constraints: { pattern: "^(?=a)a+$", const: { pattern: "(?=x)" } },
            },
            {
                path: ["extras"],
                type: "object",
                constraints: {
                    patternProperties: { "(a)\\1": { pattern: "^ok$" } },
                    anyOf: [{ propertyNames: { pattern: "(?i)a" } }],
                },
                children: [
                    {
                        path: ["inner"],
                        type: "string",
                        constraints: { pattern: "[" },
                    },
                ],
            },
        ];

        expect(
            findUnsupportedClaimPatterns(fields, "/spec/fields").map(
                ({ path }) => path,
            ),
        ).toEqual([
            "/spec/fields/0/constraints/pattern",
            "/spec/fields/1/constraints/patternProperties/(a)\\1",
            "/spec/fields/1/constraints/anyOf/0/propertyNames/pattern",
            "/spec/fields/1/children/0/constraints/pattern",
        ]);
    });

    it("accepts patterns RE2 runs, including catastrophic ones", () => {
        const fields = [
            {
                path: ["name"],
                type: "string",
                constraints: { pattern: "^(a+)+$", items: { pattern: "^\\p{L}+$" } },
            },
        ];

        expect(findUnsupportedClaimPatterns(fields)).toEqual([]);
    });
});

describe("claimPatternProblem", () => {
    // RE2 expands counted repetitions when it compiles: this one would build
    // about a million instructions before the program size could be checked.
    it("refuses a huge program before compiling it", () => {
        const started = performance.now();

        expect(claimPatternProblem(`(?:${"a".repeat(990)}){1000}`)).toBe(
            "the pattern is too complex, for example too many or too large repetitions",
        );
        expect(performance.now() - started).toBeLessThan(50);
    });

    it.each([
        "^[a-z]{1,255}$",
        "^\\u{1F600}{3}$",
        "^\\p{L}{2,64}$",
        "^(?:[A-Z]{2}-){0,10}\\d{4}$",
    ])("accepts the ordinary repetition %s", (pattern) => {
        expect(claimPatternProblem(pattern)).toBeUndefined();
    });
});
