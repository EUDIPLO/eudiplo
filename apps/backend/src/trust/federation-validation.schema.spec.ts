import { describe, expect, it } from "vitest";
import { FEDERATION_VALIDATION_SCHEMA } from "./federation-validation.schema.js";

describe("FEDERATION_VALIDATION_SCHEMA", () => {
    const validate = (env: Record<string, string>) =>
        FEDERATION_VALIDATION_SCHEMA.validate(env);

    it("resolves locally by default", () => {
        expect(validate({}).value).toEqual({ FEDERATION_RESOLVER: "local" });
    });

    it("requires FEDERATION_RESOLVER_URL for the http resolver", () => {
        expect(
            validate({ FEDERATION_RESOLVER: "http" }).error?.message,
        ).toContain("FEDERATION_RESOLVER_URL");
    });

    it("accepts only an HTTPS trust engine URL", () => {
        expect(
            validate({
                FEDERATION_RESOLVER: "http",
                FEDERATION_RESOLVER_URL: "http://trust-engine:8080",
            }).error?.message,
        ).toContain("FEDERATION_RESOLVER_URL");
        expect(
            validate({
                FEDERATION_RESOLVER: "http",
                FEDERATION_RESOLVER_URL: "https://trust-engine.example",
            }).error,
        ).toBeUndefined();
    });
});
