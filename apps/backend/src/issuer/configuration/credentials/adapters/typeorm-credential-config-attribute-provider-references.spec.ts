import { describe, expect, it, vi } from "vitest";
import { TypeOrmCredentialConfigAttributeProviderReferences } from "./typeorm-credential-config-attribute-provider-references.js";

describe("TypeOrmCredentialConfigAttributeProviderReferences", () => {
    it("returns the tenant's credential configs that name the provider", async () => {
        const repository = {
            find: vi.fn().mockResolvedValue([
                { id: "mdl", description: null },
                { id: "pid", description: "PID" },
            ]),
        };
        const source = new TypeOrmCredentialConfigAttributeProviderReferences(
            repository as any,
        );

        const found = await source.findReferences("acme", "crm");

        expect(repository.find).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: "acme", attributeProviderId: "crm" },
            }),
        );
        expect(found).toEqual([
            { kind: "CredentialConfig", id: "mdl", description: undefined },
            { kind: "CredentialConfig", id: "pid", description: "PID" },
        ]);
    });
});
