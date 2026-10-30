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
            "https://eudiplo.dev/schemas/v6/IssuanceConfigFile.schema.json",
        );
        expect(result.document.spec.walletProviderTrustLists).toEqual([
            { url: "https://example.com/trust-list" },
        ]);
        expect(result.migrations).toEqual([
            "issuance-config-v2-offer-lifetime",
            "issuance-config-v3-trust-list-verifier-pem",
            "issuance-config-v4-wallet-attestation-status-check-mode",
            "issuance-config-v5-federation-entity",
            "issuance-config-v6-access-token-signing-key",
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

    it("reads a bare kms.json with provider algorithms as KmsConfig v2", () => {
        const withAlgorithms = service.wrapLegacy("KmsConfig", {
            providers: [{ id: "db", type: "db", algorithms: ["ES384"] }],
        });
        const without = service.wrapLegacy("KmsConfig", {
            providers: [{ id: "db", type: "db" }],
        });

        expect(withAlgorithms.$schema).toBe(
            "https://eudiplo.dev/schemas/v2/KmsConfigFile.schema.json",
        );
        expect(without.$schema).toBe(
            "https://eudiplo.dev/schemas/v1/KmsConfigFile.schema.json",
        );
        expect(service.upgrade(withAlgorithms).issues).toEqual([]);
    });

    it("reads a bare key chain with type as KeyChain v2", () => {
        const jwk = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" };
        const spec = { usageType: "attestation", key: jwk };

        const withType = service.wrapLegacy(
            "KeyChain",
            { ...spec, type: "internalChain" },
            "issuer",
        );
        const withoutType = service.wrapLegacy("KeyChain", spec, "issuer");

        expect(withType.$schema).toBe(
            "https://eudiplo.dev/schemas/v2/KeyChainConfigFile.schema.json",
        );
        expect(withoutType.$schema).toBe(
            "https://eudiplo.dev/schemas/v1/KeyChainConfigFile.schema.json",
        );
        const result = service.upgrade(withType);
        expect(result.issues).toEqual([]);
        expect(service.unwrapForLegacyImporter(result.document)).toMatchObject({
            type: "internalChain",
            key: jwk,
        });
        expect(service.upgrade(withoutType)).toMatchObject({
            issues: [],
            migrations: [
                "key-chain-v2-type",
                "key-chain-v3-federation-usage",
                "key-chain-v4-access-token-usage",
            ],
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
