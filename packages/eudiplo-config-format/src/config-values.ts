export interface PlaceholderIssue {
    path: string;
    variable: string;
    message: string;
}
const isVariableChar = (char: string) =>
    (char >= "A" && char <= "Z") || (char >= "0" && char <= "9") || char === "_";
const isLower = (char: string) => char >= "a" && char <= "z";
const isSourceChar = (char: string) =>
    isLower(char) || (char >= "0" && char <= "9") || char === "-";
/**
 * The characters of the locator of a secret reference. `$`, `{`, `}` and
 * whitespace are not among them, so a locator never holds another
 * placeholder and the scan stays linear.
 */
const LOCATOR_CHARS = new Set(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~/:@+=,#-",
);
/** What the scanner found between `${` and `}`. */
type PlaceholderToken =
    | { type: "variable"; match: string; variable: string; fallback?: string }
    | { type: "reference"; match: string; source: string; locator: string };
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
 *
 * It also finds secret references, `${source:locator}` with a lowercase
 * source (see {@link parseSecretReference}). No reader fills them in, but in a
 * file sent on (`keep`) they stay references instead of becoming text.
 */
function replacePlaceholders(
    input: string,
    /** The value of the placeholder, or undefined to leave it as it is. */
    replace: (token: PlaceholderToken) => string | undefined,
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
        let token: PlaceholderToken | undefined;
        let end = -1;
        let cursor = start + 2;
        if (isLower(input[cursor] ?? "")) {
            // A reference: the source, a colon, the locator, a closing brace.
            while (cursor < input.length && isSourceChar(input[cursor]))
                cursor++;
            const source = input.slice(start + 2, cursor);
            if (input[cursor] === ":") {
                const locatorStart = cursor + 1;
                cursor = locatorStart;
                while (
                    cursor < input.length &&
                    LOCATOR_CHARS.has(input[cursor])
                )
                    cursor++;
                if (cursor > locatorStart && input[cursor] === "}") {
                    end = cursor;
                    token = {
                        type: "reference",
                        match: input.slice(start, end + 1),
                        source,
                        locator: input.slice(locatorStart, end),
                    };
                }
            }
        } else {
            while (cursor < input.length && isVariableChar(input[cursor]))
                cursor++;
            const variable = input.slice(start + 2, cursor);
            let fallback: string | undefined;
            if (variable && input[cursor] === "}") end = cursor;
            else if (variable && input[cursor] === ":" && !noClosingBrace) {
                end = input.indexOf("}", cursor + 1);
                if (end === -1) noClosingBrace = true;
                else fallback = input.slice(cursor + 1, end);
            }
            if (end !== -1)
                token = {
                    type: "variable",
                    match: input.slice(start, end + 1),
                    variable,
                    fallback,
                };
        }
        if (!token) {
            start = input.indexOf("${", start + 2);
            continue;
        }
        const { match } = token;
        const replacement = replace(token);
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
            (token) => {
                // A secret reference is resolved when it is used, not here.
                if (token.type === "reference") return undefined;
                const { variable, fallback } = token;
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
export interface ConfigReference {
    /** JSON pointer of the value that holds the reference. */
    path: string;
    /** The reference as written, for example `${vault:kv/app#token}`. */
    reference: string;
    /** Whether the reference is the whole value. */
    whole: boolean;
}
/**
 * Reads the values of a configuration file without an environment: the
 * escaped form becomes `${`, and each placeholder is left as it is and
 * listed, also one with a default. Secret references are left as they are
 * and listed apart, in `references`; `$${vault:…}` is text, not one.
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
    references: ConfigReference[];
} {
    const placeholders: ConfigPlaceholder[] = [];
    const references: ConfigReference[] = [];
    const value = mapStrings(input, (text, path) =>
        replacePlaceholders(
            text,
            ({ type, match }) => {
                const whole = match === text;
                if (type === "reference")
                    references.push({ path, reference: match, whole });
                else placeholders.push({ path, placeholder: match, whole });
                return undefined;
            },
            escapes,
        ),
    );
    return { value, placeholders, references };
}
/** The sources a secret reference can name in this release. */
export const SECRET_REFERENCE_SOURCES = ["env", "vault", "required"] as const;
/** Sources the grammar keeps for later releases. */
const RESERVED_SOURCES = new Set(["aws-sm", "azure-kv"]);
/** A secret reference, split into what its source needs to find the value. */
export type SecretReference =
    | { source: "env"; reference: string; variable: string }
    | {
          source: "vault";
          reference: string;
          /** The secrets engine mount, the first segment. */
          mount: string;
          /** The path of the secret below the mount, without `data/`. */
          path: string;
          /** The key inside the secret. */
          field: string;
          /** A KV version; the latest one when absent. */
          version?: number;
      }
    | {
          source: "required";
          reference: string;
          /** What the value is for; it never resolves. */
          hint: string;
      };
export type SecretReferenceParse =
    | { ok: true; reference: SecretReference }
    | { ok: false; source: string; message: string };
const ENV_VARIABLE = /^[A-Z0-9_]+$/;
// No `@` or `#`: they end the path and the key.
const VAULT_SEGMENT = /^[A-Za-z0-9._~+=,:-]+$/;
const VAULT_FIELD = /^[A-Za-z0-9._-]+$/;
const VAULT_VERSION = /^[1-9][0-9]{0,8}$/;
/**
 * Parses a value that is a secret reference as a whole:
 * `${<source>:<locator>}` with a lowercase source and no default.
 *
 * - `${env:NAME}`: an environment variable of the backend.
 * - `${vault:<mount>/<path>#<key>[@<version>]}`: a key of a KV secret;
 *   colons inside the path are part of it.
 * - `${required:<hint>}`: a value that must be supplied; it never resolves.
 *
 * Syntax only: a reference that parses is not one a file may use. Whoever
 * resolves it checks first that the file's scope may name it (the
 * operator's policy for the tenant or the instance), so that a tenant cannot
 * send itself a setting of EUDIPLO or another tenant's secret.
 *
 * @returns undefined when `value` is no reference as a whole (text, a
 * `${VAR}` template, or a reference inside a longer value), and an error for
 * a reference that is malformed or names a source this release does not
 * support.
 */
export function parseSecretReference(
    value: string,
): SecretReferenceParse | undefined {
    let token: PlaceholderToken | undefined;
    replacePlaceholders(value, (found) => {
        token ??= found;
        return undefined;
    });
    if (token?.type !== "reference" || token.match !== value) return undefined;
    const { source, locator } = token;
    // The message names the source, never the locator: a value written by
    // mistake in place of a reference must not reach a log.
    const invalid = (message: string): SecretReferenceParse => ({
        ok: false,
        source,
        message,
    });
    switch (source) {
        case "env":
            return ENV_VARIABLE.test(locator)
                ? {
                      ok: true,
                      reference: {
                          source,
                          reference: value,
                          variable: locator,
                      },
                  }
                : invalid(
                      "an env reference names a variable of A-Z, 0-9 and _",
                  );
        case "vault": {
            const hash = locator.indexOf("#");
            if (hash === -1)
                return invalid(
                    "a vault reference names the key inside the secret after #",
                );
            const at = locator.indexOf("@", hash);
            const field = locator.slice(hash + 1, at === -1 ? undefined : at);
            const version = at === -1 ? undefined : locator.slice(at + 1);
            const segments = locator.slice(0, hash).split("/");
            if (
                segments.length < 2 ||
                segments.some(
                    (segment) =>
                        segment === "." ||
                        segment === ".." ||
                        !VAULT_SEGMENT.test(segment),
                )
            )
                return invalid(
                    "a vault reference is <mount>/<path>#<key>, with no empty, . or .. segment",
                );
            if (!VAULT_FIELD.test(field))
                return invalid(
                    "the key after # is made of A-Z, a-z, 0-9, ., _ and -",
                );
            if (version !== undefined && !VAULT_VERSION.test(version))
                return invalid("the version after @ is a positive number");
            return {
                ok: true,
                reference: {
                    source,
                    reference: value,
                    mount: segments[0],
                    path: segments.slice(1).join("/"),
                    field,
                    ...(version === undefined
                        ? {}
                        : { version: Number(version) }),
                },
            };
        }
        case "required":
            return {
                ok: true,
                reference: { source, reference: value, hint: locator },
            };
        default:
            return invalid(
                RESERVED_SOURCES.has(source)
                    ? `the source '${source}' is not available in this release`
                    : `unknown source '${source}'; use one of ${SECRET_REFERENCE_SOURCES.join(", ")}`,
            );
    }
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
