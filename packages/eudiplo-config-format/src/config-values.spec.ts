import { describe, expect, it } from "vitest";
import {
    configChanges,
    resolveConfigVariables,
    stableConfigJson,
} from "./config-values.js";

describe("shared configuration values", () => {
    it("resolves defaults once and reports escaped paths without values", () => {
        const input = {
            "a/b~c": ["${MISSING}", "${EMPTY:fallback}", "${SET}", "${BLANK:}"],
        };
        const result = resolveConfigVariables(input, {
            EMPTY: "",
            SET: "${NESTED:private-value}",
        });
        expect(result.value["a/b~c"]).toEqual([
            "${MISSING}",
            "fallback",
            "${NESTED:private-value}",
            "",
        ]);
        expect(result.issues).toEqual([
            expect.objectContaining({
                path: "/a~1b~0c/0",
                variable: "MISSING",
            }),
        ]);
        expect(JSON.stringify(result.issues)).not.toContain("private-value");
        expect(input["a/b~c"][1]).toBe("${EMPTY:fallback}");
    });
    it("matches the placeholder grammar on edge cases", () => {
        const env = { A: "a", B_1: "b" };
        const cases: Array<[string, string]> = [
            ["x${A}y${B_1}z", "xaybz"],
            ["${A:ignored}", "a"],
            ["${MISSING:fall:back}", "fall:back"],
            ["${MISSING:${A}}", "${A}"],
            ["${${A}", "${a"],
            ["${a}", "${a}"],
            ["${}", "${}"],
            ["${A", "${A"],
            ["${A:no-close", "${A:no-close"],
            ["$${A}", "$a"],
            ["${A-}${A}", "${A-}a"],
        ];
        for (const [input, expected] of cases) {
            expect(resolveConfigVariables(input, env).value).toBe(expected);
            // Reference: the original regex-based implementation.
            expect(
                input.replace(
                    /\$\{([A-Z0-9_]+)(?::([^}]*))?\}/g,
                    (match, variable: string, fallback?: string) =>
                        (env as Record<string, string>)[variable] ??
                        fallback ??
                        match,
                ),
            ).toBe(expected);
        }
    });
    it("resolves unterminated placeholders in linear time", () => {
        const input = "${A:".repeat(100_000);
        const started = performance.now();
        expect(resolveConfigVariables(input, {}).value).toBe(input);
        expect(performance.now() - started).toBeLessThan(1000);
    });
    it("preserves array order but ignores object key order", () => {
        expect(stableConfigJson({ b: 2, a: 1 })).toBe(
            stableConfigJson({ a: 1, b: 2 }),
        );
        expect(configChanges([1, 2], [2, 1])).toHaveLength(2);
    });
    it("redacts nested credentials on additions, deletions and type changes", () => {
        const changes = configChanges(
            {
                spec: {
                    providers: [{ auth: { password: "old-secret" } }],
                    custom: "old-custom",
                },
            },
            {
                spec: {
                    providers: [{ auth: "new-secret" }],
                    custom: "new-custom",
                    apiKey: "api-secret",
                },
            },
            ["custom"],
        );
        const text = JSON.stringify(changes);
        for (const value of [
            "old-secret",
            "new-secret",
            "old-custom",
            "new-custom",
            "api-secret",
        ])
            expect(text).not.toContain(value);
        expect(changes.every((change) => change.redacted)).toBe(true);
        expect(
            JSON.stringify(
                configChanges(
                    { credentials: { password: "hidden" } },
                    { credentials: "replacement" },
                ),
            ),
        ).not.toContain("hidden");
    });
});
