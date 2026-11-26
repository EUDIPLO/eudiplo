import { describe, expect, it } from "vitest";
import { type ConfigDocument, schemaUrl } from "./config-format.js";
import { validateConfigDocument, validateConfigFile } from "./config-validator.js";

const anchor = (description: string): ConfigDocument => ({
    $schema: schemaUrl("FederationTrustAnchor"),
    kind: "FederationTrustAnchor",
    metadata: { generation: 1 },
    spec: {
        id: "anchor",
        entityId: "https://anchor.example.com",
        description,
        jwks: { keys: [{ kty: "EC", kid: "k1" }] },
    },
});

describe("validateConfigFile", () => {
    // 1000 characters as a value, the maxLength of a description.
    const escaped = `$\${${"a".repeat(998)}`;

    it("checks the values of a file, so that $${ counts as the two characters ${", () => {
        expect(validateConfigFile(anchor(escaped))).toEqual([]);
        expect(validateConfigDocument(anchor(escaped))).not.toEqual([]);
        expect(validateConfigFile(anchor(`${escaped}a`))).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: "CONFIG_SCHEMA_VALIDATION_FAILED",
                    path: "/spec/description",
                }),
            ]),
        );
    });

    it("leaves the document as it is", () => {
        const document = anchor(escaped);
        validateConfigFile(document);
        expect(document.spec.description).toBe(escaped);
    });

    it("checks a KMS configuration, which has no escaped form, as it is", () => {
        const kms: ConfigDocument = {
            $schema: schemaUrl("KmsConfig"),
            kind: "KmsConfig",
            metadata: { generation: 1 },
            spec: { providers: [{ id: "$${A}", type: "db" }] },
        };
        expect(validateConfigFile(kms)).toEqual(validateConfigDocument(kms));
    });
});
