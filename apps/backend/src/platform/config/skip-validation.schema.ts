import Joi from "joi";

/**
 * Validation schema for `SKIP_*` flags.
 *
 * Convention: every switch that turns off a check which is part of the normal,
 * secure flow is named `SKIP_<CHECK>`, defaults to `false`, and is declared
 * here. Keeping them in one schema lets the service warn about every active
 * skip on startup (see {@link getActiveSkipFlags}) and groups them together in
 * the generated configuration reference. Never enable them in production.
 */
export const SKIP_VALIDATION_SCHEMA = Joi.object({
    SKIP_OVERASKING_CHECK: Joi.boolean()
        .default(false)
        .description(
            "Skip verifying that the registration certificate authorizes every credential in the DCQL query (overasking prevention). Intended for development and interoperability testing only.",
        )
        .meta({ group: "skip", order: 10 }),
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
