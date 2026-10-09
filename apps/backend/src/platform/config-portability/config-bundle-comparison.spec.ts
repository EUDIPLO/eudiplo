import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import { hash } from "bcrypt";
import { describe, expect, it } from "vitest";
import { ConfigBundleService } from "./config-bundle.service.js";
import { ConfigDocumentValidationService } from "./config-document-validation.service.js";
import { ConfigResourceRegistry } from "./config-resource.registry.js";
import type { ConfigDocument } from "./config-resource.types.js";

function service(
    current: Record<string, unknown>,
    files: { id: string; filename: string }[] = [],
) {
    const result = Object.create(ConfigBundleService.prototype) as any;
    result.currentSpec = async () => structuredClone(current);
    result.files = { find: async () => files };
    result.registry = new ConfigResourceRegistry();
    result.documentValidationService = Object.create(
        ConfigDocumentValidationService.prototype,
    );
    result.configService = { get: () => false };
    return result as ConfigBundleService;
}
const client: ConfigDocument = {
    $schema: schemaUrl("Client"),
    kind: "Client",
    metadata: {},
    spec: {
        clientId: "client",
        roles: ["clients:manage"],
        secret: "test-secret",
    },
};
describe("configuration comparisons", () => {
    it("compares plaintext client input with its stored hash without revealing either", async () => {
        const current = {
            ...client.spec,
            secret: await hash("test-secret", 4),
        };
        const result = service(current);
        expect(await result.compareDocument("tenant", client)).toEqual({
            unchanged: true,
            changes: [],
        });
        const changed = await result.compareDocument("tenant", {
            ...client,
            spec: { ...client.spec, secret: "changed-secret" },
        });
        expect(changed.unchanged).toBe(false);
        expect(changed.changes).toEqual([
            {
                path: "/spec/secret",
                before: "[redacted]",
                after: "[redacted]",
                redacted: true,
            },
        ]);
    });
    it("compares stored storage URLs with the bundle filenames they serve", async () => {
        const document: ConfigDocument = {
            $schema: schemaUrl("IssuanceConfig"),
            kind: "IssuanceConfig",
            metadata: {},
            spec: {
                display: [{ name: "Issuer", logo: { uri: "company.png" } }],
            },
        };
        const stored = (uri: string) => ({
            display: [{ name: "Issuer", logo: { uri } }],
        });
        const files = [{ id: "569e", filename: "company.png" }];
        expect(
            await service(
                stored("http://localhost:3000/storage/569e"),
                files,
            ).compareDocument("tenant", document),
        ).toEqual({ unchanged: true, changes: [] });
        expect(
            (
                await service(
                    stored("http://localhost:3000/storage/other"),
                    files,
                ).compareDocument("tenant", document)
            ).unchanged,
        ).toBe(false);
    });
    it("preserves omitted update fields while detecting role changes", async () => {
        const result = service({ ...client.spec, description: "Retained" });
        expect((await result.compareDocument("tenant", client)).unchanged).toBe(
            true,
        );
        const changed = await result.compareDocument("tenant", {
            ...client,
            spec: { ...client.spec, roles: ["presentation:request"] },
        });
        expect(changed.unchanged).toBe(false);
        expect(changed.changes).toContainEqual({
            path: "/spec/roles/0",
            before: "clients:manage",
            after: "presentation:request",
        });
    });
    it("does not suppress explicit regeneration", async () => {
        const document: ConfigDocument = {
            $schema: schemaUrl("KeyChain"),
            kind: "KeyChain",
            metadata: {},
            spec: { id: "key", keySource: { type: "regenerate" } },
        };
        expect(
            (await service(document.spec).compareDocument("tenant", document))
                .unchanged,
        ).toBe(false);
    });
    it("detects removal of fields in KMS configs that replace the entire file", async () => {
        const document: ConfigDocument = {
            $schema: schemaUrl("KmsConfig"),
            kind: "KmsConfig",
            metadata: {},
            spec: {},
        };
        expect(
            (
                await service({ vaultToken: "removed-secret" }).compareDocument(
                    "tenant",
                    document,
                )
            ).unchanged,
        ).toBe(false);
    });
});
