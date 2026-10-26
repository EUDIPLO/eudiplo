import { compileClaimPattern } from "@eudiplo/config-format/claim-patterns.js";
import type { RegExpEngine } from "ajv/dist/types/index.js";

/**
 * Ajv `code.regExp` engine for claim patterns: RE2 instead of the backtracking
 * RegExp engine, so a tenant pattern like `^(a+)+$` cannot block the shared
 * event loop. Ajv always passes the `u` flag, which RE2 implies. `code` is only
 * read for standalone code generation, which the backend does not use.
 * @throws UnsupportedClaimPattern
 */
export const claimPatternEngine: RegExpEngine = Object.assign(
    (pattern: string) => compileClaimPattern(pattern),
    { code: "compileClaimPattern" },
);
