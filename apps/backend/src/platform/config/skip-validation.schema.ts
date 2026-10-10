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
    SKIP_TRUST_AUTHORITY: Joi.boolean()
        .default(false)
        .description(
            "Accept presentation configurations whose DCQL credential queries have no trusted_authorities. Presented credentials of such queries are verified without checking their issuer. Intended for development and interoperability testing only.",
        )
        .meta({
            group: "skip",
            order: 20,
            disables: "required trusted authorities in presentation configs",
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
