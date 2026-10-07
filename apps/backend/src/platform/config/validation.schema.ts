// config/validation.schema.ts
import Joi from "joi";

/**
 * Validation schema for base configuration
 */
export const BASE_VALIDATION_SCHEMA = Joi.object({
    FOLDER: Joi.string()
        .default("../../tmp")
        .description(
            "Working folder: holds the SQLite database (`service.db`) and, with local storage, the uploaded files",
        )
        .meta({
            group: "general",
            order: 10,
            defaultText:
                "`../../tmp`, relative to the working directory; the container image sets `/app/config`",
        }),
    // Not validated: read directly from process.env where it matters.
    NODE_ENV: Joi.string()
        .optional()
        .description(
            "`production` turns on TLS certificate checks for status list, trust list and federation fetches, hides internal error messages from API responses and makes `warn` the default `LOG_LEVEL`. The container image sets it; set it yourself when you run the backend from source in production.",
        )
        .meta({ group: "general", order: 11 }),
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
