import Joi from "joi";

/**
 * Validation schema for `SKIP_*` flags.
 *
 * Convention: every switch that turns off a check which is part of the normal,
 * secure flow is named `SKIP_<CHECK>`, defaults to `false`, and is declared
 * here with a `disables` meta naming the protection it turns off. Keeping them
 * in one schema lets the service warn about every active skip on startup (see
 * {@link getActiveSkipFlags}) and groups them together in the generated
 * configuration reference. Never enable them in production.
 */
export const SKIP_VALIDATION_SCHEMA = Joi.object({
    SKIP_OVERASKING_CHECK: Joi.boolean()
        .default(false)
        .description(
            "Skip verifying that the registration certificate authorizes every credential in the DCQL query (overasking prevention). Intended for development and interoperability testing only.",
        )
        .meta({
            group: "skip",
            order: 10,
            disables: "overasking prevention of registration certificates",
        }),
});

/**
 * Names of all `SKIP_*` flags that are currently enabled.
 */
export function getActiveSkipFlags(
    get: (key: string) => unknown = (key) => process.env[key],
): string[] {
    const keys = Object.keys(SKIP_VALIDATION_SCHEMA.describe().keys ?? {});
    return keys.filter((key) => {
        const value = get(key);
        return value === true || String(value).toLowerCase() === "true";
    });
}

/**
 * The protection a `SKIP_*` flag turns off, from its `disables` meta.
 */
export function skippedProtection(flag: string): string | undefined {
    const metas: Array<Record<string, unknown>> =
        SKIP_VALIDATION_SCHEMA.describe().keys?.[flag]?.metas ?? [];
    const disables = metas.find((meta) => "disables" in meta)?.disables;
    return typeof disables === "string" ? disables : undefined;
}

/**
 * `SKIP_*` flags that were removed, with what replaces them. A deployment that
 * still enables one refuses to start, so the check it turned off does not
 * come back unnoticed.
 */
const REMOVED_SKIP_FLAGS: Record<string, string> = {
    SKIP_TRUST_AUTHORITY:
        "SKIP_TRUST_AUTHORITY was removed in EUDIPLO 11.0. Set allowUntrustedIssuers to true in each presentation configuration whose credential queries have no trusted_authorities instead (development and interoperability tests only), and unset SKIP_TRUST_AUTHORITY.",
};

/**
 * Why the environment cannot be used because it enables a removed `SKIP_*`
 * flag, or undefined. Unset or `false` values are accepted.
 */
export function removedSkipFlagError(
    env: Record<string, unknown>,
): string | undefined {
    const enabled = Object.keys(REMOVED_SKIP_FLAGS).filter((key) => {
        const value = env[key];
        return value === true || String(value).toLowerCase() === "true";
    });
    return enabled.length > 0
        ? enabled.map((key) => REMOVED_SKIP_FLAGS[key]).join(" ")
        : undefined;
}
