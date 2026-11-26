import { describe, expect, it } from "vitest";
import {
    configChanges,
    escapeConfigPlaceholders,
    readConfigFileValues,
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
            // A prefix that looks like a reference and is none.
            ["${a:${A}}", "${a:a}"],
            ["${a:b${A}}", "${a:ba}"],
            ["${vault:kv/a#t}${A}", "${vault:kv/a#t}a"],
            ["${env:X}:${A}", "${env:X}:a"],
        ];
        for (const [input, expected] of cases) {
            // Without the escaped form, as a kms.json is read.
            expect(resolveConfigVariables(input, env, "none").value).toBe(
                expected,
            );
            if (!input.includes("$${"))
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
        // Each scan timed on its own, so that the bound of one scan does not
        // depend on the other on a loaded runner.
        const timed = (scan: () => void) => {
            const started = performance.now();
            scan();
            return performance.now() - started;
        };
        expect(
            timed(() =>
                expect(resolveConfigVariables(input, {}).value).toBe(input),
            ),
        ).toBeLessThan(1000);
        expect(
            timed(() =>
                expect(readConfigFileValues(input).placeholders).toEqual([]),
            ),
        ).toBeLessThan(1000);
    });
    it("reads $${ as the two characters ${ and never as a placeholder", () => {
        const env = { A: "a" };
        const cases: Array<[string, string]> = [
            ["$${A}", "${A}"],
            ["x$${A}y${A}z", "x${A}yaz"],
            ["$${A:fallback}", "${A:fallback}"],
            ["$$${A}", "$${A}"],
            ["$${A}$${A}", "${A}${A}"],
            ["${A}$${A}", "a${A}"],
            ["$${", "${"],
            ["$${${A}}", "${a}"],
            // An escaped form after a placeholder that never closes.
            ["${A:open $${A", "${A:open ${A"],
            ["$ ${A}", "$ a"],
        ];
        for (const [input, expected] of cases)
            expect(resolveConfigVariables(input, env).value).toBe(expected);
    });
    it("escapes stored text so that a file gives it back unchanged", () => {
        const stored = {
            name: "Hook ${OTHER_KEY}",
            whole: "${OTHER_KEY}",
            withDefault: "${OTHER_KEY:fallback}",
            alreadyEscaped: "$${OTHER_KEY}",
            dollars: "$$${OTHER_KEY} $ {x} ${",
            plain: ["no placeholder", 5, null],
        };
        const file = escapeConfigPlaceholders(stored);
        expect(file.name).toBe("Hook $${OTHER_KEY}");
        expect(file.alreadyEscaped).toBe("$$${OTHER_KEY}");
        // The environment holds the variable and is never read.
        const env = new Proxy(
            {},
            {
                get: (_target, name) => {
                    throw new Error(`read ${String(name)}`);
                },
            },
        );
        expect(resolveConfigVariables(file, env)).toEqual({
            value: stored,
            issues: [],
        });
        expect(readConfigFileValues(file)).toEqual({
            value: stored,
            placeholders: [],
            references: [],
        });
    });
    it("lists the placeholders of a file without an escaped form and changes no value", () => {
        expect(
            readConfigFileValues(
                { token: "${A}", text: "$${B}", other: "x${C}" },
                "none",
            ),
        ).toEqual({
            value: { token: "${A}", text: "$${B}", other: "x${C}" },
            placeholders: [
                { path: "/token", placeholder: "${A}", whole: true },
                { path: "/text", placeholder: "${B}", whole: false },
                { path: "/other", placeholder: "${C}", whole: false },
            ],
            references: [],
        });
    });
    it("lists the placeholders of a file and leaves them as they are", () => {
        expect(
            readConfigFileValues({
                secret: "${CLIENT_SECRET}",
                url: "https://example.com/?k=${KEY:none}&literal=$${KEY}",
                "a/b": ["${ONE}${TWO}"],
            }),
        ).toEqual({
            value: {
                secret: "${CLIENT_SECRET}",
                url: "https://example.com/?k=${KEY:none}&literal=${KEY}",
                "a/b": ["${ONE}${TWO}"],
            },
            placeholders: [
                {
                    path: "/secret",
                    placeholder: "${CLIENT_SECRET}",
                    whole: true,
                },
                { path: "/url", placeholder: "${KEY:none}", whole: false },
                { path: "/a~1b/0", placeholder: "${ONE}", whole: false },
                { path: "/a~1b/0", placeholder: "${TWO}", whole: false },
            ],
            references: [],
        });
    });
    it("lets a value it fills in form no placeholder with the text next to it", () => {
        const sent = resolveConfigVariables(
            { joined: "${A}{B}", twice: "${A}${C}", literal: "${lower}" },
            { A: "$", C: "{B}" },
            "keep",
        ).value;
        // The next reader gets the text and finds nothing to resolve.
        expect(readConfigFileValues(sent)).toEqual({
            value: { joined: "${B}", twice: "${B}", literal: "${lower}" },
            placeholders: [],
            references: [],
        });
    });
    it("keeps the escaped form and escapes the values it fills in when the result is sent on as a file", () => {
        const result = resolveConfigVariables(
            {
                filled: "${SET}",
                tricky: "${TEMPLATE}",
                fallback: "${MISSING:${x}",
                literal: "$${SET}",
                open: "${MISSING}",
            },
            { SET: "value", TEMPLATE: "pa${SET}ss" },
            "keep",
        );
        expect(result.value).toEqual({
            filled: "value",
            tricky: "pa$${SET}ss",
            fallback: "$${x",
            literal: "$${SET}",
            open: "${MISSING}",
        });
        // The reader of that file gets the values, and one open placeholder.
        expect(readConfigFileValues(result.value)).toEqual({
            value: {
                filled: "value",
                tricky: "pa${SET}ss",
                fallback: "${x",
                literal: "${SET}",
                open: "${MISSING}",
            },
            placeholders: [
                { path: "/open", placeholder: "${MISSING}", whole: true },
            ],
            references: [],
        });
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
