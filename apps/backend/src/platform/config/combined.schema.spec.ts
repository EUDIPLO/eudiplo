import { describe, expect, it } from "vitest";
import { VALIDATION_SCHEMA } from "./combined.schema.js";

/**
 * Variables that are read outside the ConfigService (directly from
 * process.env, or by the OpenTelemetry/AWS SDKs) and are only declared in the
 * schema so they are documented.
 */
const DOCUMENTED_ONLY = {
    PORT: "general",
    VAULT_ADDR: "encryption",
    VAULT_TOKEN: "encryption",
    AWS_REGION: "encryption",
    OTEL_EXPORTER_OTLP_ENDPOINT: "observability",
    OTEL_SERVICE_NAME: "observability",
};

const REQUIRED_ENV = {
    MASTER_SECRET: "a-master-secret-with-at-least-32-characters",
    AUTH_CLIENT_ID: "client",
    AUTH_CLIENT_SECRET: "secret",
};

describe("VALIDATION_SCHEMA documented-only variables", () => {
    const keys = VALIDATION_SCHEMA.describe().keys ?? {};

    it.each(Object.entries(DOCUMENTED_ONLY))(
        "documents %s in the %s group without a default",
        (key, group) => {
            const desc = (keys as Record<string, any>)[key];
            expect(desc).toBeDefined();
            expect(desc.flags?.description).toBeTruthy();
            expect(desc.flags).not.toHaveProperty("default");
            expect(Object.assign({}, ...(desc.metas ?? [])).group).toBe(group);
        },
    );

    it("does not add values for unset variables (they would be written to process.env)", () => {
        const { error, value } = VALIDATION_SCHEMA.validate(REQUIRED_ENV);

        expect(error).toBeUndefined();
        for (const key of Object.keys(DOCUMENTED_ONLY)) {
            expect(value).not.toHaveProperty(key);
        }
    });

    it("accepts any value the runtime accepts", () => {
        const env = {
            ...REQUIRED_ENV,
            PORT: String.raw`\\.\pipe\eudiplo`,
            VAULT_ADDR: "",
            VAULT_TOKEN: "",
            AWS_REGION: "eu-central-1",
            OTEL_EXPORTER_OTLP_ENDPOINT: "",
            OTEL_SERVICE_NAME: "custom",
        };

        const { error, value } = VALIDATION_SCHEMA.validate(env);

        expect(error).toBeUndefined();
        expect(value).toMatchObject(env);
    });
});
