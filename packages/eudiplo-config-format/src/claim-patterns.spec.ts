import { describe, expect, it } from "vitest";
import {
    claimPatternMessage,
    claimPatternProblem,
    compileClaimPattern,
} from "./claim-patterns.js";

describe("compileClaimPattern", () => {
    // RE2 searches like RegExp.test and keeps the ECMAScript meaning.
    it.each([
        ["\\u00e9", "café", "cafe"],
        ["^(?<y>\\d{4})-", "2024-01", "24-01"],
        ["a/b", "xa/bx", "ab"],
        ["\\d", "a1b", "ab"],
        ["^\\s$", " ", "x"],
        ["^\\S$", "x", " "],
        ["^[\\s,]+$", " , ", " ,x"],
        ["^.$", "x", "\r"],
        ["^[.]$", ".", "x"],
        ["^\\p{L}+$", "café", "1"],
        ["^\\P{L}+$", "1", "a"],
    ])("matches %s like ECMAScript", (pattern, accepted, rejected) => {
        const compiled = compileClaimPattern(pattern);

        expect(compiled.test(accepted)).toBe(true);
        expect(compiled.test(rejected)).toBe(false);
    });

    it("matches a catastrophic pattern in linear time", () => {
        const compiled = compileClaimPattern("^(a+)+$");
        const started = performance.now();

        expect(compiled.test(`${"a".repeat(100_000)}!`)).toBe(false);
        expect(performance.now() - started).toBeLessThan(1000);
    });
});

describe("claimPatternProblem", () => {
    it.each([
        ["a lookahead", "^(?=a)a$"],
        ["a backreference", "^(a)\\1$"],
        ["a two-digit backreference RE2 reads as octal", "^(a)\\12$"],
        ["a named backreference", "^(?<a>x)\\k<a>$"],
        ["an RE2-only escape", "^a\\z"],
        ["inline flags", "(?i)abc"],
        ["\\S inside a character class", "[\\S]"],
        ["an empty character class", "^[]a$"],
        ["a negated empty character class", "^[^][a]$"],
        ["a trailing backslash", "a\\"],
        ["an invalid pattern", "["],
        ["an overlong pattern", "a".repeat(1001)],
        ["a pattern with a large program", ".{1000}".repeat(20)],
    ])("refuses %s", (_case, pattern) => {
        expect(claimPatternProblem(pattern)).toBeDefined();
    });

    it("names the pattern and the rule in the message", () => {
        const pattern = "^(?=a)a$";

        expect(
            claimPatternMessage(pattern, claimPatternProblem(pattern) ?? ""),
        ).toMatch(
            /^Pattern "\^\(\?=a\)a\$" is not supported: .+\. Claim patterns are matched with RE2/,
        );
    });
});
