import { describe, expect, it } from "vitest";
import { ConfigMigrationService } from "./config-migration.service.js";
import { ConfigResourceRegistry } from "./config-resource.registry.js";

describe("ConfigMigrationService", () => {
    const registry = new ConfigResourceRegistry();
    const service = new ConfigMigrationService(registry);

    it("upgrades a bare legacy configuration to the current version", () => {
        const input = service.wrapLegacy(
            "IssuanceConfig",
            {
                authorizationServers: [{ id: "issuer", type: "built-in" }],
                walletProviderTrustLists: [
                    { url: "https://example.com/trust-list" },
                ],
            },
            "issuance",
        );

        const result = service.upgrade(input);

        expect(result.document.$schema).toBe(
            "https://eudiplo.dev/schemas/v2/IssuanceConfigFile.schema.json",
        );
        expect(result.document.spec.walletProviderTrustLists).toEqual([
            { url: "https://example.com/trust-list" },
        ]);
        expect(result.migrations).toEqual([
            "issuance-config-v2-offer-lifetime",
        ]);
        expect(result.issues).toEqual([]);
    });

    it("unwraps a key source for legacy importers", () => {
        const input = service.wrapLegacy(
            "KeyChain",
            {
                id: "issuer",
                keySource: {
                    type: "private-jwk",
                    jwk: { kty: "EC", d: "private" },
                },
            },
            "issuer",
        );

        const result = service.upgrade(input);

        expect(result.document.$schema).toBe(
            "https://eudiplo.dev/schemas/v1/KeyChainConfigFile.schema.json",
        );
        expect(service.unwrapForLegacyImporter(result.document)).toMatchObject({
            id: "issuer",
            key: { kty: "EC", d: "private" },
        });
    });

    it("rejects configuration newer than this runtime", () => {
        expect(() =>
            service.upgrade({
                $schema:
                    "https://eudiplo.dev/schemas/v99/TenantConfigFile.schema.json",
                metadata: {},
                spec: {},
            }),
        ).toThrow("newer than supported");
    });
});
