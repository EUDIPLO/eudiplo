import Joi from "joi";

export const ISSUER_VALIDATION_SCHEMA = Joi.object({
    PUBLIC_URL: Joi.string()
        .default("http://localhost:3000")
        .description("The public URL of the issuer")
        .meta({ group: "general", order: 10 }),

    INTERNAL_URL: Joi.string()
        .uri({ scheme: ["http", "https"] })
        .default("http://127.0.0.1:3000")
        .description(
            "Internal URL used by the backend to resolve its own authorization-server JWKS",
        )
        .meta({ group: "general", order: 11 }),

    OUTBOUND_URL_ALLOW_HTTP: Joi.boolean()
        .optional()
        .description(
            "Allow HTTP (non-TLS) for outbound calls (webhooks, attribute providers, issuer and schema metadata imports). Defaults to true outside production.",
        )
        .meta({ group: "issuer", order: 20 }),

    OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: Joi.boolean()
        .optional()
        .description(
            "Allow outbound calls (webhooks, attribute providers, metadata imports) to private, loopback, or link-local IP ranges. The address actually connected to is checked as well (DNS rebinding protection). Defaults to true outside production.",
        )
        .meta({ group: "issuer", order: 30 }),

    OUTBOUND_URL_ALLOWED_HOSTS: Joi.string()
        .allow("")
        .optional()
        .description(
            "Comma-separated hostname allowlist for outbound calls (webhooks, attribute providers, metadata imports; supports exact host and subdomains)",
        )
        .meta({ group: "issuer", order: 40 }),
    ISSUER_MULTI_CONSUMPTION: Joi.boolean()
        .default(false)
        .description("Enable or disable multi-consumption for the issuer")
        .meta({ group: "issuer", order: 50 }),
});
