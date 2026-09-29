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

    ISSUER_MULTI_CONSUMPTION: Joi.boolean()
        .default(false)
        .description("Enable or disable multi-consumption for the issuer")
        .meta({ group: "issuer", order: 50 }),
});
