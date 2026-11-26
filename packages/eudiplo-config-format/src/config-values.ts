export interface PlaceholderIssue {
    path: string;
    variable: string;
    message: string;
}
const isVariableChar = (char: string) =>
    (char >= "A" && char <= "Z") || (char >= "0" && char <= "9") || char === "_";
/**
 * What becomes of `$${`, the escaped form of a literal `${`:
 *
 * - `resolve`: it becomes `${`. The result is the value itself.
 * - `keep`: it stays `$${`. The result is still a file a later reader
 *   resolves, so the values filled in are escaped too.
 * - `none`: the text has no escaped form (a `kms.json`).
 */
export type PlaceholderEscapes = "resolve" | "keep" | "none";
// A function, because "$$" in a replacement string means one "$".
const escapeText = (text: string) => text.replaceAll("${", () => "$${");
/**
 * Replaces `${VAR}` and `${VAR:fallback}` in one linear scan. Equivalent to
 * `/\$\{([A-Z0-9_]+)(?::([^}]*))?\}/g`, which backtracks polynomially on
 * inputs like repeated `${A:` without a closing brace. A `${` that follows a
 * `$` is no placeholder but the escaped form of these two characters.
 */
function replacePlaceholders(
    input: string,
    /** The value of the placeholder, or undefined to leave it as it is. */
    replace: (
        match: string,
        variable: string,
        fallback?: string,
    ) => string | undefined,
    escapes: PlaceholderEscapes = "resolve",
): string {
    let output = "";
    // Text read so far that is a value. With `keep`, each run of it is
    // escaped as a whole, so that a value filled in forms no `${` with the
    // text next to it; only a placeholder left as it is stands between runs.
    let text = "";
    const flush = () => {
        output += escapes === "keep" ? escapeText(text) : text;
        text = "";
    };
    let copied = 0;
    // Once no closing brace follows, none follows a later position either.
    let noClosingBrace = false;
    let start = input.indexOf("${");
    while (start !== -1) {
        if (escapes !== "none" && start > copied && input[start - 1] === "$") {
            text += `${input.slice(copied, start - 1)}\${`;
            copied = start + 2;
            start = input.indexOf("${", copied);
            continue;
        }
        let cursor = start + 2;
        while (cursor < input.length && isVariableChar(input[cursor])) cursor++;
        const variable = input.slice(start + 2, cursor);
        let end = -1;
        let fallback: string | undefined;
        if (variable && input[cursor] === "}") end = cursor;
        else if (variable && input[cursor] === ":" && !noClosingBrace) {
            end = input.indexOf("}", cursor + 1);
            if (end === -1) noClosingBrace = true;
            else fallback = input.slice(cursor + 1, end);
        }
        if (end === -1) {
            start = input.indexOf("${", start + 2);
            continue;
        }
        const match = input.slice(start, end + 1);
        const replacement = replace(match, variable, fallback);
        text += input.slice(copied, start);
        if (replacement !== undefined) text += replacement;
        else if (escapes === "keep") {
            // A placeholder left as it is stays one for the next reader.
            flush();
            output += match;
        } else text += match;
        copied = end + 1;
        start = input.indexOf("${", copied);
    }
    text += input.slice(copied);
    flush();
    return output;
}
/** Applies `change` to every string inside `input`, with its JSON pointer. */
function mapStrings<T>(
    input: T,
    change: (text: string, path: string) => string,
): T {
    const seen = new WeakMap<object, unknown>();
    function visit(value: any, path: string): any {
        if (typeof value === "string") return change(value, path || "/");
        if (!value || typeof value !== "object" || value instanceof Uint8Array)
            return value;
        if (seen.has(value)) return seen.get(value);
        const output: any = Array.isArray(value) ? [] : {};
        seen.set(value, output);
        for (const [key, item] of Object.entries(value))
            Object.defineProperty(output, key, {
                value: visit(
                    item,
                    `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
                ),
                enumerable: true,
                configurable: true,
                writable: true,
            });
        return output;
    }
    return visit(input, "");
}
/**
 * Resolve one pass only: environment values are data, never another template.
 *
 * @param escapes `keep` when the result is sent on as a file, as the CLI
 * sends a folder to the API, which reads the escaped form itself.
 */
export function resolveConfigVariables<T>(
    input: T,
    env: Record<string, string | undefined>,
    escapes: PlaceholderEscapes = "resolve",
): { value: T; issues: PlaceholderIssue[] } {
    const issues: PlaceholderIssue[] = [];
    const value = mapStrings(input, (text, path) =>
        replacePlaceholders(
            text,
            (match, variable: string, fallback?: string) => {
                const found = env[variable];
                if (found !== undefined && found !== "") return found;
                if (fallback !== undefined) return fallback;
                issues.push({
                    path,
                    variable,
                    message: `Unresolved placeholder \${${variable}}: no environment value or default is available`,
                });
                return undefined;
            },
            escapes,
        ),
    );
    return { value, issues };
}
/**
 * Writes values as a configuration file holds them: every `${` becomes
 * `$${`, so that no reader of the file takes stored text for a placeholder.
 * {@link resolveConfigVariables} and {@link readConfigFileValues} undo it.
 */
export function escapeConfigPlaceholders<T>(input: T): T {
    return mapStrings(input, escapeText);
}
export interface ConfigPlaceholder {
    /** JSON pointer of the value that holds the placeholder. */
    path: string;
    /** The placeholder as written, for example `${VAR}`. */
    placeholder: string;
    /** Whether the placeholder is the whole value. */
    whole: boolean;
}
/**
 * Reads the values of a configuration file without an environment: the
 * escaped form becomes `${`, and each placeholder is left as it is and
 * listed, also one with a default.
 *
 * @param escapes `none` for a file without an escaped form (a `kms.json`):
 * the values stay as they are and only the placeholders are listed.
 */
export function readConfigFileValues<T>(
    input: T,
    escapes: Exclude<PlaceholderEscapes, "keep"> = "resolve",
): {
    value: T;
    placeholders: ConfigPlaceholder[];
} {
    const placeholders: ConfigPlaceholder[] = [];
    const value = mapStrings(input, (text, path) =>
        replacePlaceholders(
            text,
            (match) => {
                placeholders.push({
                    path,
                    placeholder: match,
                    whole: match === text,
                });
                return undefined;
            },
            escapes,
        ),
    );
    return { value, placeholders };
}
export interface ConfigChange {
    path: string;
    before?: unknown;
    after?: unknown;
    redacted?: boolean;
}
export function stableConfigJson(value: unknown): string {
    function sort(item: any): any {
        if (Array.isArray(item)) return item.map(sort);
        if (!item || typeof item !== "object") return item;
        return Object.fromEntries(
            Object.keys(item)
                .sort()
                .filter((key) => item[key] !== undefined)
                .map((key) => [key, sort(item[key])]),
        );
    }
    return JSON.stringify(sort(value));
}
/** Values in potentially secret fields never enter reports, including removed objects. */
export function configChanges(
    before: unknown,
    after: unknown,
    sensitivePaths: string[] = [],
    prefix = "",
): ConfigChange[] {
    const changes: ConfigChange[] = [];
    const sensitive = (path: string) =>
        /(?:^|\/)(?:secret|password|apiKey|accessToken|refreshToken|authorization|token|vaultToken|clientSecret|secretAccessKey|pin|sad|authorizeAuthData|auth|keySource|key|privateKey|jwk|activeJwk)(?:\/|$)/i.test(
            path,
        ) ||
        sensitivePaths.some((pattern) => {
            const parts = pattern.split(".");
            const actual = path
                .replace(/^\/spec\//, "")
                .replace(/^\//, "")
                .split("/");
            return parts.every(
                (part, index) => part === "*" || part === actual[index],
            );
        });
    function visit(left: any, right: any, path: string) {
        if (stableConfigJson(left) === stableConfigJson(right)) return;
        if (sensitive(path)) {
            changes.push({
                path: path || "/",
                before: left === undefined ? undefined : "[redacted]",
                after: right === undefined ? undefined : "[redacted]",
                redacted: true,
            });
            return;
        }
        const lobject =
            left && typeof left === "object" && !Array.isArray(left);
        const robject =
            right && typeof right === "object" && !Array.isArray(right);
        if (
            (lobject || left === undefined) &&
            (robject || right === undefined) &&
            (lobject || robject)
        ) {
            for (const key of [
                ...new Set([
                    ...Object.keys(left ?? {}),
                    ...Object.keys(right ?? {}),
                ]),
            ].sort())
                visit(
                    left?.[key],
                    right?.[key],
                    `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
                );
        } else if (Array.isArray(left) || Array.isArray(right)) {
            // Recurse into arrays too: credential/provider objects can contain secrets.
            if (
                (Array.isArray(left) || left === undefined) &&
                (Array.isArray(right) || right === undefined)
            ) {
                for (
                    let i = 0;
                    i < Math.max(left?.length ?? 0, right?.length ?? 0);
                    i++
                )
                    visit(left?.[i], right?.[i], `${path}/${i}`);
            } else
                changes.push({
                    path,
                    before: "[changed]",
                    after: "[changed]",
                    redacted: true,
                });
        } else if (lobject || robject)
            changes.push({
                path,
                before: "[changed]",
                after: "[changed]",
                redacted: true,
            });
        else changes.push({ path: path || "/", before: left, after: right });
    }
    visit(before, after, prefix);
    return changes;
}
