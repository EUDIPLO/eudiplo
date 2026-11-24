import { describe, expect, it } from "vitest";
import { CRYPTO_VALIDATION_SCHEMA } from "./crypto-validation.schema.js";

describe("KMS_TENANT_VARIABLES", () => {
    const validate = (value?: string) =>
        CRYPTO_VALIDATION_SCHEMA.validate(
            value === undefined ? {} : { KMS_TENANT_VARIABLES: value },
        ).error;

    it("accepts a comma-separated list of variable names, or none", () => {
        for (const value of [undefined, "", "A_TOKEN", " A_TOKEN , B_URL2 "]) {
            expect(validate(value)).toBeUndefined();
        }
    });

    it.each(["a-token", "A_TOKEN;B_URL", "A_TOKEN,", "${A_TOKEN}"])(
        "refuses %j",
        (value) => {
            expect(validate(value)).toBeDefined();
        },
    );
});

describe("KMS_TENANT_AWS_DEFAULT_CREDENTIALS", () => {
    const validate = (value?: string) =>
        CRYPTO_VALIDATION_SCHEMA.validate(
            value === undefined
                ? {}
                : { KMS_TENANT_AWS_DEFAULT_CREDENTIALS: value },
        );

    it("is off by default and on with the environment value true", () => {
        expect(validate().value.KMS_TENANT_AWS_DEFAULT_CREDENTIALS).toBe(false);
        expect(validate("true").value.KMS_TENANT_AWS_DEFAULT_CREDENTIALS).toBe(
            true,
        );
        expect(validate("false").value.KMS_TENANT_AWS_DEFAULT_CREDENTIALS).toBe(
            false,
        );
    });

    it("refuses a value that is no boolean", () => {
        expect(validate("yes-please").error).toBeDefined();
    });
});
