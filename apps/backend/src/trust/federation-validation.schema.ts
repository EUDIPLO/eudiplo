import Joi from "joi";

/**
 * Validation schema for OpenID Federation trust resolution
 */
export const FEDERATION_VALIDATION_SCHEMA = Joi.object({
    FEDERATION_RESOLVER: Joi.string()
        .valid("local", "http")
        .default("local")
        .description(
            "How OpenID Federation trust chains are resolved. `local`: EUDIPLO fetches and validates the entity configurations and subordinate statements itself. `http`: resolution is delegated to an external trust engine at `FEDERATION_RESOLVER_URL`.",
        )
        .meta({ group: "federation", order: 10 }),
    FEDERATION_RESOLVER_URL: Joi.string()
        .uri({ scheme: ["https"] })
        .when("FEDERATION_RESOLVER", {
            is: "http",
            then: Joi.required(),
            otherwise: Joi.optional().allow(""),
        })
        .description(
            "HTTPS base URL of the trust engine for `FEDERATION_RESOLVER=http`. EUDIPLO sends `POST {url}/resolve`; the request is subject to the outbound URL policy and redirects are not followed.",
        )
        .meta({ group: "federation", order: 20 }),
    FEDERATION_RESOLVER_TOKEN: Joi.string()
        .optional()
        .allow("")
        .description(
            "Bearer token EUDIPLO sends to the trust engine for `FEDERATION_RESOLVER=http`.",
        )
        .meta({ group: "federation", order: 30, secret: true }),
});
