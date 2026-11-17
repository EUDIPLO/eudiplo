import { describe, expect, it } from "vitest";
import { SchemaMetaConfigSchema } from "./schema-meta-config.schema.js";

const config = {
    version: "1.0.0",
    rulebookURI: "https://example.com/rulebook.md",
    attestationLoS: "iso_18045_high",
    bindingType: "key",
    name: "German PID",
};

describe("SchemaMetaConfigSchema", () => {
    it("does not accept the registrar catalogue fields", () => {
        const result = SchemaMetaConfigSchema.safeParse({
            ...config,
            category: "identity",
            tags: ["pid"],
        });

        expect(result.error?.issues[0]).toMatchObject({
            code: "unrecognized_keys",
            keys: ["category", "tags"],
        });
    });
});
