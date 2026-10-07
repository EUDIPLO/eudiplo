/**
 * Joi compiles `is: "sqlite"` to `valid(Joi.override, "sqlite")`; describe()
 * lists the override marker as `{ override: true }`. It is not a value.
 */
function isOverrideMarker(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        (value as { override?: unknown }).override === true
    );
}

/**
 * Formats a default value as inline code. Computed defaults (functions) have
 * no printable value; the key's `defaultText` meta describes them instead.
 */
export function formatDefault(value: unknown, defaultText?: string): string {
    if (typeof value === "function" || value === undefined) {
        return defaultText ?? "computed at startup";
    }
    return `\`${typeof value === "string" ? value : JSON.stringify(value)}\``;
}

/**
 * Describes the `is` schema of a condition, e.g. "is set" or "is `s3`".
 */
function summarizeIs(s?: any): string {
    const values = Array.isArray(s?.allow)
        ? s.allow.filter((value: unknown) => !isOverrideMarker(value))
        : [];
    if (values.length > 0) {
        return `is ${values
            .map((value: unknown) =>
                typeof value === "string" ? `\`${value}\`` : `\`${JSON.stringify(value)}\``,
            )
            .join(" or ")}`;
    }
    if (s?.type === "any") return "is set"; // Joi.exist()
    return "matches";
}

interface BranchSummary {
    conditions: string[];
    required: boolean;
}

/**
 * Describes what one branch of a condition changes: "required when …",
 * "required unless …" or "default … when …".
 */
function summarizeBranch(
    flags: any,
    sense: "when" | "unless",
    condition: string,
    defaultText?: string,
): BranchSummary {
    const conditions: string[] = [];
    if (flags?.presence === "required") {
        conditions.push(`required ${sense} ${condition}`);
    }
    if (flags && "default" in flags) {
        conditions.push(
            `default ${formatDefault(flags.default, defaultText)} ${sense} ${condition}`,
        );
    }
    return { conditions, required: flags?.presence === "required" };
}

function summarizeWhenEntry(w: any, defaultText?: string): BranchSummary {
    const ref =
        (typeof w.ref === "string" && w.ref) ||
        (Array.isArray(w.ref?.path) ? w.ref.path.join(".") : "ref");
    const condition = `\`${ref}\` ${summarizeIs(w.is)}`;
    const then = summarizeBranch(w.then?.flags, "when", condition, defaultText);
    const otherwise = summarizeBranch(
        w.otherwise?.flags,
        "unless",
        condition,
        defaultText,
    );
    return {
        conditions: [...then.conditions, ...otherwise.conditions],
        required: then.required || otherwise.required,
    };
}

/**
 * Extracts the conditions of a key ("required unless `OIDC` is set") and
 * whether one of them makes the key required.
 */
export function extractConditionsFromKeyDesc(
    keyDesc: any,
    defaultText?: string,
): BranchSummary {
    const entries = [
        ...(Array.isArray(keyDesc?.whens) ? keyDesc.whens : []),
        ...(Array.isArray(keyDesc?.matches)
            ? keyDesc.matches.filter(
                  (m: any) => m.ref || m.is || m.then || m.otherwise,
              )
            : []),
    ];
    const summaries = entries.map((entry) => summarizeWhenEntry(entry, defaultText));
    return {
        conditions: summaries.flatMap((summary) => summary.conditions),
        required: summaries.some((summary) => summary.required),
    };
}

/**
 * The type of a key whose base schema is `any` (`Joi.when(...)` without a
 * type) is the type of its branches.
 */
export function branchType(keyDesc: any): string | undefined {
    for (const w of keyDesc?.whens ?? []) {
        const type = w.then?.type ?? w.otherwise?.type;
        if (type && type !== "any") return type;
    }
    return undefined;
}

/**
 * Flattens the meta information from a given description object.
 * @param desc The description object to extract meta information from.
 * @returns A record containing the flattened meta information.
 */
export function flattenMetas(desc: any): Record<string, any> {
    const metas = Array.isArray(desc?.metas) ? desc.metas : [];
    return Object.assign({}, ...metas);
}
