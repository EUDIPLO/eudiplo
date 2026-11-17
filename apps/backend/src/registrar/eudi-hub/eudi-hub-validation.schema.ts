import Joi from "joi";

/** Organization API of the production EUDI Hub. */
const DEFAULT_EUDI_HUB_API_URL = "https://api.eudi-hub.gov.de/org-management";

/**
 * Validation schema for the connection to the German EUDI Hub.
 */
export const EUDI_HUB_VALIDATION_SCHEMA = Joi.object({
    EUDI_HUB_API_URL: Joi.string()
        .uri({ scheme: ["https", "http"] })
        .default(DEFAULT_EUDI_HUB_API_URL)
        .description(
            "Base URL of the Organization API of the German EUDI Hub, without the /v1 path. EUDIPLO sends the access token pasted into a EUDI Hub request only to this URL. The outbound URL policy applies to it.",
        )
        .meta({ group: "registrar", order: 10 }),
});
