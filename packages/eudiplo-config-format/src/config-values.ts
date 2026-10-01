export interface PlaceholderIssue {
    path: string;
    variable: string;
    message: string;
}
const isVariableChar = (char: string) =>
    (char >= "A" && char <= "Z") || (char >= "0" && char <= "9") || char === "_";
/**
 * Replaces `${VAR}` and `${VAR:fallback}` in one linear scan. Equivalent to
 * `/\$\{([A-Z0-9_]+)(?::([^}]*))?\}/g`, which backtracks polynomially on
 * inputs like repeated `${A:` without a closing brace.
 */
function replacePlaceholders(
    input: string,
    replace: (match: string, variable: string, fallback?: string) => string,
): string {
    let output = "";
    let copied = 0;
    let start = input.indexOf("${");
    while (start !== -1) {
        let cursor = start + 2;
        while (cursor < input.length && isVariableChar(input[cursor])) cursor++;
        const variable = input.slice(start + 2, cursor);
        let end = -1;
        let fallback: string | undefined;
        if (variable && input[cursor] === "}") end = cursor;
        else if (variable && input[cursor] === ":") {
            end = input.indexOf("}", cursor + 1);
            // No closing brace anywhere after this point: nothing else can match.
            if (end === -1) break;
            fallback = input.slice(cursor + 1, end);
        }
        if (end === -1) {
            start = input.indexOf("${", start + 2);
            continue;
        }
        output += input.slice(copied, start);
        output += replace(input.slice(start, end + 1), variable, fallback);
        copied = end + 1;
        start = input.indexOf("${", copied);
    }
    return output + input.slice(copied);
}
/** Resolve one pass only: environment values are data, never another template. */
export function resolveConfigVariables<T>(
    input: T,
    env: Record<string, string | undefined>,
): { value: T; issues: PlaceholderIssue[] } {
    const issues: PlaceholderIssue[] = [];
    const seen = new WeakMap<object, unknown>();
    function visit(value: any, path: string): any {
        if (typeof value === "string")
            return replacePlaceholders(
                value,
                (match, variable: string, fallback?: string) => {
                    if (env[variable] !== undefined && env[variable] !== "")
                        return env[variable];
                    if (fallback !== undefined) return fallback;
                    issues.push({
                        path: path || "/",
                        variable,
                        message: `Unresolved placeholder \${${variable}}: no environment value or default is available`,
                    });
                    return match;
                },
            );
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
    return { value: visit(input, ""), issues };
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
