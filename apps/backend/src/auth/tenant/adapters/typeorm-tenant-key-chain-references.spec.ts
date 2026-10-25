import { describe, expect, it, vi } from "vitest";
import { TypeOrmTenantKeyChainReferences } from "./typeorm-tenant-key-chain-references.js";

const keyChain = { tenantId: "acme", id: "access" };

describe("TypeOrmTenantKeyChainReferences", () => {
    it("returns the tenant when its default access key chain is the key chain", async () => {
        const repository = { countBy: vi.fn().mockResolvedValue(1) };
        const source = new TypeOrmTenantKeyChainReferences(repository as any);

        await expect(source.findReferences(keyChain)).resolves.toEqual([
            { kind: "Tenant" },
        ]);
        expect(repository.countBy).toHaveBeenCalledWith({
            id: "acme",
            defaultAccessKeyChainId: "access",
        });
    });

    it("returns nothing when the tenant names another or no key chain", async () => {
        const repository = { countBy: vi.fn().mockResolvedValue(0) };
        const source = new TypeOrmTenantKeyChainReferences(repository as any);

        await expect(source.findReferences(keyChain)).resolves.toEqual([]);
    });

    it("checks the spec of a tenant document that is not stored", () => {
        const source = new TypeOrmTenantKeyChainReferences({} as any);

        expect(
            source.namesKeyChain(
                { name: "Acme", defaultAccessKeyChainId: "access" },
                keyChain,
            ),
        ).toBe(true);
        expect(source.namesKeyChain({ name: "Acme" }, keyChain)).toBe(false);
    });
});
