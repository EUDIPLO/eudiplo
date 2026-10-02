import Joi from "joi";

/**
 * Validation schema for logging configuration
 */
export const LOG_VALIDATION_SCHEMA = Joi.object({
    LOG_LEVEL: Joi.string()
        .valid("trace", "debug", "info", "warn", "error", "fatal")
        .default(process.env.NODE_ENV === "production" ? "warn" : "debug")
        .description("Application log level")
        .meta({ group: "log", order: 10 }),
    LOG_ENABLE_HTTP_LOGGER: Joi.boolean()
        .default(false)
        .description("Enable HTTP request logging")
        .meta({ group: "log", order: 20 }),
    LOG_HTTP_RESPONSE_BODY: Joi.boolean()
        .default(false)
        .description(
            "Capture and log HTTP response bodies (buffered up to LOG_HTTP_RESPONSE_BODY_MAX_LENGTH bytes). " +
                "Disabled by default because response bodies may contain access tokens, " +
                "credentials, or other sensitive data.",
        )
        .meta({ group: "log", order: 25 }),
    LOG_HTTP_RESPONSE_BODY_MAX_LENGTH: Joi.number()
        .integer()
        .min(0)
        .default(4096)
        .description(
            "Maximum number of bytes to capture for HTTP response bodies. Set to 0 to disable truncation.",
        )
        .meta({ group: "log", order: 27 }),
    LOG_REDACT_SENSITIVE_DATA: Joi.boolean()
        .default(true)
        .description(
            "Redact sensitive request/response fields from logs. Disable only for debugging.",
        )
        .meta({ group: "log", order: 28 }),
    LOG_OID4VP_DECRYPTED_RESPONSE: Joi.boolean()
        .default(false)
        .description(
            "Log decrypted OID4VP authorization responses. Disable by default because responses may contain personal data and credentials.",
        )
        .meta({ group: "log", order: 29 }),
    LOG_ENABLE_SESSION_LOGGER: Joi.boolean()
        .default(false)
        .description("Enable session flow logging")
        .meta({ group: "log", order: 30 }),
    LOG_SESSION_STORE: Joi.string()
        .valid("off", "errors", "all", "verbose")
        .default("off")
        .description(
            "Controls whether session log entries are persisted to the database. " +
                "'off' disables storage, 'errors' stores only warn/error entries, " +
                "'all' stores everything, 'verbose' stores everything including full request/response bodies and error stacks.",
        )
        .meta({ group: "log", order: 35 }),
    LOG_TO_FILE: Joi.boolean()
        .default(false)
        .description("Enable logging to file in addition to console")
        .meta({ group: "log", order: 60 }),
    LOG_FILE_PATH: Joi.string()
        .default("./logs/session.log")
        .description("File path for log output when LOG_TO_FILE is enabled")
        .meta({ group: "log", order: 70 }),
    OTEL_SDK_DISABLED: Joi.boolean()
        .default(false)
        .description("Disable OpenTelemetry SDK (and OTel log forwarding)")
        .meta({ group: "log", order: 80 }),
    // The OTel variables below are read by tracing.ts and the OpenTelemetry
    // SDK before NestJS starts. No Joi defaults: @nestjs/config writes
    // defaults back into process.env, which the SDK also reads.
    OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string()
        .optional()
        .allow("")
        .description(
            "Base URL of the OTLP/HTTP endpoint (e.g. the OpenTelemetry Collector) that receives traces, metrics and logs (default: http://localhost:4318)",
        )
        .meta({ group: "observability", order: 40 }),
    OTEL_SERVICE_NAME: Joi.string()
        .optional()
        .allow("")
        .description(
            "Service name attached to exported traces, metrics and logs (default: eudiplo-backend)",
        )
        .meta({ group: "observability", order: 50 }),
});
