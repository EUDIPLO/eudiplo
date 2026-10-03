// config/validation.schema.ts
import Joi from "joi";

/**
 * Validation schema for base configuration
 */
export const BASE_VALIDATION_SCHEMA = Joi.object({
    FOLDER: Joi.string()
        .default("../../tmp")
        .description("Root working folder for temp files")
        .meta({ group: "general", order: 10 }),
    // Read from process.env in bootstrap.ts. No Joi default: @nestjs/config
    // writes defaults back into process.env.
    PORT: Joi.string()
        .optional()
        .allow("")
        .description("Port the HTTP(S) server listens on (default: 3000)")
        .meta({ group: "general", order: 12 }),
    GRAFANA_URL: Joi.string()
        .uri({ scheme: ["http", "https"] })
        .optional()
        .allow("")
        .description(
            "Base URL of the Grafana instance for deep linking from the dashboard UI",
        )
        .meta({ group: "observability", order: 10 }),
    GRAFANA_DATASOURCE_TEMPO_UID: Joi.string()
        .default("tempo")
        .description("UID of the Tempo data source in Grafana")
        .meta({ group: "observability", order: 20 }),
    GRAFANA_DATASOURCE_LOKI_UID: Joi.string()
        .default("loki")
        .description("UID of the Loki data source in Grafana")
        .meta({ group: "observability", order: 30 }),
}).unknown(true);
