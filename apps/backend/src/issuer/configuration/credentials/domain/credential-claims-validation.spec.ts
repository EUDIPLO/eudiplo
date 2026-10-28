import { UnsupportedClaimPattern } from "@eudiplo/config-format/claim-patterns.js";
import { describe, expect, it } from "vitest";
import {
    assertClaimsMatchConfiguration,
    InvalidCredentialClaims,
} from "./credential-claims-validation.js";

const configuration = {
    id: "citizen",
    fields: [
        {
            path: ["town"],
            type: "string",
            mandatory: true,
            defaultValue: "BERLIN",
        },
        {
            path: ["address"],
            type: "object",
            children: [{ path: ["street"], type: "string", mandatory: true }],
        },
    ],
};

describe("assertClaimsMatchConfiguration", () => {
    it("accepts claims that match the configuration", () => {
        expect(() =>
            assertClaimsMatchConfiguration(configuration, {
                town: "Köln",
                address: { street: "Main St" },
            }),
        ).not.toThrow();
    });

    it.each([
        ["a wrong type", { town: 5 }, "/town: must be string"],
        ["a missing required claim", {}, "/town: missing required claim"],
        [
            "an unexpected claim",
            { town: "Köln", nickname: "x" },
            "/nickname: unexpected claim",
        ],
        [
            "an invalid nested claim",
            { town: "Köln", address: {} },
            "/address/street: missing required claim",
        ],
    ])("rejects %s", (_case, claims, message) => {
        expect(() =>
            assertClaimsMatchConfiguration(configuration, claims),
        ).toThrow(message);
    });

    it("names claim paths without exposing claim values", () => {
        try {
            assertClaimsMatchConfiguration(configuration, {
                town: 42,
                secret: "Kölsche Geheimnis",
            });
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(InvalidCredentialClaims);
            expect((error as Error).message).toContain("/secret");
            expect((error as Error).message).not.toContain("Kölsche");
            expect((error as Error).message).not.toContain("42");
        }
    });

    // `^(a+)+$` backtracks exponentially in the default RegExp engine: seconds
    // to a minute at 30 characters, so a regression fails instead of hanging.
    it.each([
        ["pattern", { pattern: "^(a+)+$" }, { name: "a".repeat(30) + "!" }],
        [
            "patternProperties",
            {
                patternProperties: { "^(a+)+$": { type: "string" } },
                additionalProperties: false,
            },
            { name: { ["a".repeat(30) + "!"]: "x" } },
        ],
        [
            "patternProperties next to properties",
            {
                properties: { ["a".repeat(30) + "!"]: { type: "string" } },
                patternProperties: { "^(a+)+$": { type: "string" } },
                additionalProperties: false,
            },
            { name: { other: "x" } },
        ],
        [
            "propertyNames",
            { propertyNames: { pattern: "^(a+)+$" } },
            { name: { ["a".repeat(30) + "!"]: "x" } },
        ],
    ])(
        "matches a catastrophic %s in linear time",
        (_keyword, constraints, claims) => {
            const type = "pattern" in constraints ? "string" : "object";
            const started = performance.now();
            expect(() =>
                assertClaimsMatchConfiguration(
                    {
                        id: "redos",
                        fields: [{ path: ["name"], type, constraints }],
                    },
                    claims,
                ),
            ).toThrow(InvalidCredentialClaims);
            expect(performance.now() - started).toBeLessThan(1000);
        },
    );

    it("still applies ordinary patterns", () => {
        const withPattern = {
            id: "plate",
            fields: [
                {
                    path: ["plate"],
                    type: "string",
                    constraints: { pattern: "^[A-Z]{2}\\d{3}$" },
                },
            ],
        };
        expect(() =>
            assertClaimsMatchConfiguration(withPattern, { plate: "AB123" }),
        ).not.toThrow();
        expect(() =>
            assertClaimsMatchConfiguration(withPattern, { plate: "AB123x" }),
        ).toThrow("/plate: must match pattern");
    });

    const withPattern = (pattern: string) => ({
        id: "patterned",
        fields: [{ path: ["value"], type: "string", constraints: { pattern } }],
    });

    // Patterns keep their ECMAScript meaning and search semantics under RE2.
    it.each([
        ["\\u00e9", "café", "cafe"],
        ["^(?<y>\\d{4})-", "2024-01", "24-01"],
        ["a/b", "xa/bx", "ab"],
        ["\\d", "a1b", "ab"],
        ["^\\s$", "\u00a0", "x"],
        ["^\\S$", "x", "\u00a0"],
        ["^[\\s,]+$", " ,\u2028", " ,x"],
        ["^.$", "x", "\r"],
        ["^[.]$", ".", "x"],
        ["^\\p{L}+$", "café", "1"],
    ])("matches %s like ECMAScript", (pattern, accepted, rejected) => {
        expect(() =>
            assertClaimsMatchConfiguration(withPattern(pattern), {
                value: accepted,
            }),
        ).not.toThrow();
        expect(() =>
            assertClaimsMatchConfiguration(withPattern(pattern), {
                value: rejected,
            }),
        ).toThrow(InvalidCredentialClaims);
    });

    it.each(["^(?=secret)\\w+$", "^(secret"])(
        "refuses a stored pattern RE2 cannot run without quoting it: %s",
        (pattern) => {
            try {
                assertClaimsMatchConfiguration(withPattern(pattern), {
                    value: "x",
                });
                expect.unreachable();
            } catch (error) {
                expect(error).toBeInstanceOf(UnsupportedClaimPattern);
                expect((error as Error).message).toBe(
                    "Credential configuration with id patterned has a claim pattern that cannot be used",
                );
            }
        },
    );

    it("does not validate configurations without fields", () => {
        expect(() =>
            assertClaimsMatchConfiguration(
                { id: "free", fields: [] },
                { anything: true },
            ),
        ).not.toThrow();
    });

    it("rejects a __proto__ claim of a stored configuration without polluting Object.prototype", () => {
        const stored = {
            id: "stored",
            fields: [
                { path: ["__proto__", "x"], type: "string", mandatory: true },
            ],
        };

        // Ajv ignores `__proto__` property schemas, so the claim fails closed
        const call = () =>
            assertClaimsMatchConfiguration(
                stored,
                JSON.parse('{"__proto__":{"x":"v"}}'),
            );
        expect(call).toThrow(InvalidCredentialClaims);
        expect(call).toThrow("/__proto__: unexpected claim");
        expect(Object.hasOwn(Object.prototype, "x")).toBe(false);
        expect(({} as Record<string, unknown>).required).toBeUndefined();
    });
});
