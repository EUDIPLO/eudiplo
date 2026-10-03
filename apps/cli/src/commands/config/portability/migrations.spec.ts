import { describe, expect, it } from "vitest";
import { upgradeDocument } from "./migrations.js";

describe("offline configuration migrations", () => {
    it("upgrades a v1 issuance document to v2 without retaining metadata.id", () => {
        const result = upgradeDocument({
            $schema:
                "https://eudiplo.dev/schemas/v1/IssuanceConfigFile.schema.json",
            metadata: { generation: 1 },
            spec: {
                authorizationServers: [{ id: "issuer", type: "built-in" }],
                walletProviderTrustLists: [
                    { url: "https://example.com/trust-list" },
                ],
            },
        });

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

    it("refuses to guess when a document is newer than the CLI", () => {
        expect(() =>
            upgradeDocument({
                $schema:
                    "https://eudiplo.dev/schemas/v99/PresentationConfigFile.schema.json",
                metadata: {},
                spec: {},
            }),
        ).toThrow("newer than supported");
    });
});
