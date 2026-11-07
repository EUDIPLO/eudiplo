import Joi from "joi";
import { splitCommaSeparatedList } from "../../shared/domain/comma-separated-list.js";
import { isSerializedWebOrigin } from "../../shared/domain/web-origin.js";

/**
 * Validation schema for cross-origin resource sharing (CORS).
 */
export const CORS_VALIDATION_SCHEMA = Joi.object({
    CORS_ORIGINS: Joi.string()
        .allow("")
        .optional()
        .custom((value: string, helpers) => {
            const invalid = splitCommaSeparatedList(value).filter(
                (origin) => !isSerializedWebOrigin(origin),
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
