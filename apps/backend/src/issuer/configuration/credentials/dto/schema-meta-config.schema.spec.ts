import { describe, expect, it } from "vitest";
import { SignSchemaMetaConfigSchema } from "./schema-meta-config.schema.js";

describe("SignSchemaMetaConfigSchema", () => {
    const config = {
        version: "1.0.0",
        rulebookURI: "https://example.com/rulebook.md",
        attestationLoS: "iso_18045_high",
        bindingType: "key",
        name: "German PID",
    };

    it("accepts the required values with a name and rulebook", () => {
        expect(SignSchemaMetaConfigSchema.safeParse({ config }).success).toBe(
            true,
        );
    });

    it("rejects unknown fields", () => {
        const result = SignSchemaMetaConfigSchema.safeParse({
            config: { ...config, colour: "blue" },
        });

        expect(result.error?.issues[0]).toMatchObject({
            code: "unrecognized_keys",
            path: ["config"],
        });
    });
});
