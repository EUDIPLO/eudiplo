import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Joi from "joi";

const currentDir = dirname(fileURLToPath(import.meta.url));

/**
 * Validation schema for configuration
 */
export const CONFIG_VALIDATION_SCHEMA = Joi.object({
    CONFIG_IMPORT_MODE: Joi.string()
        .default("disabled")
        .valid("disabled", "create", "upsert", "replace")
        .description("Startup configuration reconciliation mode.")
        .meta({ group: "config", order: 10 }),

    CONFIG_FOLDER: Joi.string()
        .default(resolve(currentDir, "../../../../../assets/config"))
        .description("Path to config import folder")
        .meta({
            group: "config",
            order: 40,
            defaultText:
                "`assets/config` of the repository; the container image sets `/app/config/config`",
        }),
    CONFIG_VARIABLE_STRICT: Joi.alternatives()
        .try(Joi.string().valid("abort", "skip", "ignore"), Joi.boolean())
        .default("skip")
        .description("Strict mode for config import.")
        .meta({ group: "config", order: 50 }),
});
