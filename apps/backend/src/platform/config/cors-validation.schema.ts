import Joi from "joi";

/**
 * Split a comma-separated `CORS_ORIGINS` value into its entries.
 * Whitespace around entries and empty entries are ignored.
 */
export function splitCorsOrigins(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
}

/**
 * Check whether a value is a serialized web origin as sent by browsers in the
 * `Origin` header: `http(s)` scheme, lowercase host, optional non-default port,
 * and no path, query, fragment or trailing slash.
 */
export function isValidCorsOrigin(value: string): boolean {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return false;
    }
    return url.origin === value;
}

/**
 * Validation schema for cross-origin resource sharing (CORS).
 */
export const CORS_VALIDATION_SCHEMA = Joi.object({
    CORS_ORIGINS: Joi.string()
        .allow("")
        .optional()
        .custom((value: string, helpers) => {
            const invalid = splitCorsOrigins(value).filter(
                (origin) => !isValidCorsOrigin(origin),
            );
            if (invalid.length > 0) {
                return helpers.message({
                    custom: `"CORS_ORIGINS" contains invalid origins: ${invalid.join(", ")}. Use scheme://host[:port] without path or trailing slash, e.g. https://console.example.com`,
                });
            }
            return value;
        })
        .description(
            "Comma-separated list of origins allowed to call the management API (/api/*) from a browser, e.g. https://console.example.com. Protocol and public endpoints stay open to all origins. If unset, all origins are allowed everywhere.",
        )
        .meta({ group: "general", order: 20 }),
});
