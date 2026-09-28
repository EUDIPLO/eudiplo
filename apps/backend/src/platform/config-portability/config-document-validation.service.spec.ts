import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import { describe, expect, it } from "vitest";
import { ConfigDocumentValidationService } from "./config-document-validation.service.js";
import { ConfigMigrationService } from "./config-migration.service.js";
import { ConfigResourceRegistry } from "./config-resource.registry.js";

describe("ConfigDocumentValidationService", () => {
    const migrations = new ConfigMigrationService(new ConfigResourceRegistry());
    const service = new ConfigDocumentValidationService(migrations);

    it("accepts an explicit key-regeneration decision", () => {
        expect(
            service.validate({
                $schema: schemaUrl("KeyChain"),
                kind: "KeyChain",
                metadata: {},
                spec: {
                    id: "issuer",
                    usageType: "attestation",
                    kmsProvider: "db",
                    keySource: {
                        type: "regenerate",
                        keyChainType: "internalChain",
                    },
                },
            }),
        ).toEqual([]);
    });

    it("accepts identity carried by the schema-described spec", () => {
        expect(
            service.validate({
                $schema: schemaUrl("Client"),
                kind: "Client",
                metadata: {},
                spec: {
                    clientId: "different",
                    roles: ["clients:manage"],
                },
            }),
        ).toEqual([]);
    });
});
