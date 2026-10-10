import Joi from "joi";

/**
 * Loopback address of this backend, used for its requests to itself. Without
 * one (built-in TLS, whose certificate does not name 127.0.0.1, or a PORT
 * that is not a TCP port, such as a named pipe), those requests use
 * PUBLIC_URL. Keys after INTERNAL_URL in the schema are still unconverted
 * here, so TLS_ENABLED may be a string.
 */
function defaultInternalUrl(env: Record<string, unknown>): string | undefined {
    const port = env.PORT ? String(env.PORT) : "3000";
    const tls = String(env.TLS_ENABLED ?? false).toLowerCase() === "true";
    return /^\d+$/.test(port) && !tls ? `http://127.0.0.1:${port}` : undefined;
}

export const ISSUER_VALIDATION_SCHEMA = Joi.object({
    PUBLIC_URL: Joi.string()
        .default("http://localhost:3000")
        .description("The public URL of the issuer")
        .meta({ group: "general", order: 10 }),

    INTERNAL_URL: Joi.string()
        .uri({ scheme: ["http", "https"] })
        .default(defaultInternalUrl)
        .description(
            "URL the backend uses to reach itself: its authorization server keys (JWKS) and managed trust lists. Without it, these requests use PUBLIC_URL",
        )
        .meta({
            group: "general",
            order: 11,
            defaultText:
                "`http://127.0.0.1:<PORT>`; none with `TLS_ENABLED=true` or a `PORT` that is not a number",
        }),

    ISSUER_MULTI_CONSUMPTION: Joi.boolean()
        .default(false)
        .description("Enable or disable multi-consumption for the issuer")
        .meta({ group: "issuer", order: 50 }),
});
