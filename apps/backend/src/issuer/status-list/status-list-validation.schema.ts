import Joi from "joi";

export const STATUS_LIST_VALIDATION_SCHEMA = Joi.object({
    STATUS_CAPACITY: Joi.number()
        .integer()
        .min(1)
        .max(1_000_000)
        .default(10000)
        .description(
            "The default capacity of the status list. Can be overridden per tenant.",
        )
        .meta({ group: "status", order: 10 }),
    STATUS_BITS: Joi.number()
        .valid(1, 2, 4, 8)
        .default(1)
        .description(
            "The default number of bits used per status entry. Can be overridden per tenant.",
        )
        .meta({ group: "status", order: 20 }),
    STATUS_TTL: Joi.number()
        .min(60)
        .default(3600)
        .description(
            "The default TTL in seconds for status list JWTs. Verifiers can cache the JWT until expiration. Can be overridden per tenant.",
        )
        .meta({ group: "status", order: 30 }),
    STATUS_IMMEDIATE_UPDATE: Joi.boolean()
        .default(false)
        .description(
            "If true, regenerate status list JWT immediately on every status change. If false (default), use lazy regeneration when TTL expires. Can be overridden per tenant.",
        )
        .meta({ group: "status", order: 40 }),
    STATUS_ENABLE_AGGREGATION: Joi.boolean()
        .default(true)
        .description(
            "If true (default), include aggregation_uri in status list JWTs. This allows relying parties to pre-fetch all status lists for offline validation per RFC draft-ietf-oauth-status-list Section 9. Can be overridden per tenant.",
        )
        .meta({ group: "status", order: 50 }),
});
