import { describe, expect, it, vi } from "vitest";
import { TypeOrmTenantKeyChainReferences } from "./typeorm-tenant-key-chain-references.js";

const keyChain = { tenantId: "acme", id: "access" };

describe("TypeOrmTenantKeyChainReferences", () => {
    it("returns the key chain defaults when one of their entries is the key chain", async () => {
        const repository = {
            findOne: vi.fn().mockResolvedValue({
                id: "acme",
                defaultKeyChains: { access: "access" },
            }),
        };
        const source = new TypeOrmTenantKeyChainReferences(repository as any);

        await expect(source.findReferences(keyChain)).resolves.toEqual([
            { kind: "KeyChainDefaults" },
        ]);
        expect(repository.findOne).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "acme" } }),
        );
    });

    it("returns nothing when the tenant names another or no key chain", async () => {
        for (const defaultKeyChains of [{ access: "other" }, null]) {
            const repository = {
                findOne: vi
                    .fn()
                    .mockResolvedValue({ id: "acme", defaultKeyChains }),
            };
            const source = new TypeOrmTenantKeyChainReferences(
                repository as any,
            );

            await expect(source.findReferences(keyChain)).resolves.toEqual([]);
        }
    });

    it("checks the spec of a key chain defaults document that is not stored", () => {
        const source = new TypeOrmTenantKeyChainReferences({} as any);

        expect(source.namesKeyChain({ access: "access" }, keyChain)).toBe(true);
        expect(source.namesKeyChain({ access: "other" }, keyChain)).toBe(false);
        expect(source.namesKeyChain({}, keyChain)).toBe(false);
    });
});
