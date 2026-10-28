// Claim field `constraints` patterns (`pattern`, `patternProperties` keys) are
// matched with RE2 instead of the backtracking RegExp engine (CredentialConfig
// v3). Patterns come from tenant configuration and claims from offers or
// attribute providers, so a pattern like `^(a+)+$` would otherwise block the
// backend's shared event loop. RE2 matches in linear time but does not support
// lookarounds or backreferences.
import { RE2JS } from "re2js";

/** Longest accepted claim pattern, in UTF-16 code units. */
export const MAX_CLAIM_PATTERN_LENGTH = 1000;
/** Largest accepted compiled RE2 program, which bounds memory and match cost. */
export const MAX_CLAIM_PATTERN_PROGRAM_SIZE = 10_000;

/**
 * A claim pattern that cannot be matched in linear time or exceeds the size
 * limits. RE2 syntax errors in the message can quote parts of the pattern.
 */
export class UnsupportedClaimPattern extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "UnsupportedClaimPattern";
    }
}

const TOO_COMPLEX =
    "the pattern is too complex, for example too many or too large repetitions";

// ECMAScript `\s`; RE2's `\s` only covers ASCII whitespace.
const JS_WHITESPACE =
    "\\t\\n\\v\\f\\r \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}";
// ECMAScript `.` without the `s` flag; RE2's `.` only excludes `\n`.
const JS_DOT = "[^\\n\\r\\x{2028}\\x{2029}]";
// Escapes with the same meaning in RE2 after RE2JS.translateRegExp.
const PASSTHROUGH_ESCAPES = new Set("dDwWbBnrtfv0cxupP");

/**
 * Rewrites an ECMAScript pattern so RE2 matches the same strings, and refuses
 * what RE2 would silently read differently: backreferences, unknown letter
 * escapes and inline flags. Lookarounds are left for RE2 to refuse.
 */
function toRe2Syntax(pattern: string): string {
    let result = "";
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === "\\") {
            const next = pattern[i + 1] ?? "";
            i++;
            if (/[1-9]/.test(next) || next === "k") {
                throw new UnsupportedClaimPattern(
                    "backreferences are not supported",
                );
            }
            if (next === "s") {
                result += inClass ? JS_WHITESPACE : `[${JS_WHITESPACE}]`;
            } else if (next === "S") {
                if (inClass) {
                    throw new UnsupportedClaimPattern(
                        "\\S inside a character class is not supported",
                    );
                }
                result += `[^${JS_WHITESPACE}]`;
            } else if (
                /[A-Za-z]/.test(next) &&
                !PASSTHROUGH_ESCAPES.has(next)
            ) {
                throw new UnsupportedClaimPattern(`unknown escape \\${next}`);
            } else {
                result += `\\${next}`;
            }
        } else if (inClass) {
            if (char === "]") inClass = false;
            result += char;
        } else if (char === "[") {
            // ECMAScript reads `[]` as empty and `[^]` as any character, RE2
            // reads the `]` as a literal.
            if (/^\^?\]/.test(pattern.slice(i + 1))) {
                throw new UnsupportedClaimPattern(
                    "empty character classes [] and [^] are not supported",
                );
            }
            inClass = true;
            result += char;
        } else if (char === ".") {
            result += JS_DOT;
        } else if (char === "(" && /^\?[a-zA-Z-]/.test(pattern.slice(i + 1))) {
            throw new UnsupportedClaimPattern("inline flags are not supported");
        } else {
            result += char;
        }
    }
    return result;
}

/**
 * Upper estimate of the RE2 program size: every atom counts once, multiplied by
 * the counted repetitions (`{n}`, `{n,m}`) around it. RE2 expands counted
 * repetitions when it compiles, so this refuses huge programs before they are
 * built.
 */
function estimateProgramSize(pattern: string): number {
    // One frame per open group: its cost so far and the cost of its last atom.
    const frames = [{ cost: 0, last: 0 }];
    const top = () => frames[frames.length - 1];
    const atom = (cost: number) => {
        top().cost += cost;
        top().last = cost;
    };
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === "\\") {
            i++;
            // \u{…}, \x{…}, \p{…} and \P{…} are one atom.
            if (/[uxpP]/.test(pattern[i] ?? "") && pattern[i + 1] === "{") {
                i = pattern.indexOf("}", i);
                if (i < 0) break;
            }
            atom(1);
        } else if (char === "[") {
            // Skip to the end of the class, past escaped characters.
            for (i++; i < pattern.length && pattern[i] !== "]"; i++) {
                if (pattern[i] === "\\") i++;
            }
            atom(1);
        } else if (char === "(") {
            frames.push({ cost: 0, last: 0 });
        } else if (char === ")" && frames.length > 1) {
            const group = frames.pop() as { cost: number };
            atom(group.cost);
        } else if (char === "{") {
            const repetition = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i));
            if (repetition) {
                const times = Number(repetition[2] || repetition[1]);
                top().cost += top().last * Math.max(times - 1, 0);
                top().last *= times;
                i += repetition[0].length - 1;
            } else {
                atom(1);
            }
        } else if (char !== "|" && char !== "*" && char !== "+" && char !== "?") {
            atom(1);
        }
    }
    return frames.reduce((sum, frame) => sum + frame.cost, 0);
}

/**
 * Compiles a claim pattern with RE2. `test` searches like `RegExp.test` with
 * the ECMAScript meaning of the pattern.
 * @throws UnsupportedClaimPattern
 */
export function compileClaimPattern(pattern: string): {
    test(input: string): boolean;
} {
    if (pattern.length > MAX_CLAIM_PATTERN_LENGTH) {
        throw new UnsupportedClaimPattern(
            `patterns are limited to ${MAX_CLAIM_PATTERN_LENGTH} characters`,
        );
    }
    if (estimateProgramSize(pattern) > MAX_CLAIM_PATTERN_PROGRAM_SIZE) {
        throw new UnsupportedClaimPattern(TOO_COMPLEX);
    }
    let compiled: RE2JS;
    try {
        compiled = RE2JS.compile(RE2JS.translateRegExp(toRe2Syntax(pattern)));
    } catch (error) {
        if (error instanceof UnsupportedClaimPattern) throw error;
        throw new UnsupportedClaimPattern(
            error instanceof Error ? error.message : String(error),
        );
    }
    if (compiled.programSize() > MAX_CLAIM_PATTERN_PROGRAM_SIZE) {
        throw new UnsupportedClaimPattern(TOO_COMPLEX);
    }
    return compiled;
}

/** Why a claim pattern cannot be used, or undefined when it can. */
export function claimPatternProblem(pattern: string): string | undefined {
    try {
        compileClaimPattern(pattern);
        return undefined;
    } catch (error) {
        return (error as Error).message;
    }
}

/** The message for a claim pattern RE2 cannot run, shared by save and upgrade. */
export function claimPatternMessage(pattern: string, problem: string): string {
    return `Pattern ${JSON.stringify(pattern)} is not supported: ${problem}. Claim patterns are matched with RE2: rewrite it without lookarounds, backreferences or inline flags.`;
}
