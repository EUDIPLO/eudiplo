import { describe, expect, it, vi } from "vitest";
import { TypeOrmIssuanceConfigKeyChainReferences } from "./typeorm-issuance-config-key-chain-references.js";

const keyChain = { tenantId: "acme", id: "signing" };

function sourceWith(config: unknown) {
    const repository = { findOne: vi.fn().mockResolvedValue(config) };
    return {
        repository,
        source: new TypeOrmIssuanceConfigKeyChainReferences(repository as any),
    };
}

describe("TypeOrmIssuanceConfigKeyChainReferences", () => {
    it("finds the token signing key of an authorization server", async () => {
        const { source, repository } = sourceWith({
            tenantId: "acme",
            authorizationServers: [
                { type: "built-in", id: "a" },
                {
                    type: "chained",
                    id: "b",
                    token: { signingKeyId: "signing" },
                },
            ],
        });

        await expect(source.findReferences(keyChain)).resolves.toEqual([
            { kind: "IssuanceConfig" },
        ]);
        expect(repository.findOne).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: "acme" } }),
        );
    });

    it("does not count a configuration that uses the default key chain", async () => {
        const { source } = sourceWith({
            tenantId: "acme",
            authorizationServers: [{ type: "built-in", id: "a", token: {} }],
        });

        await expect(source.findReferences(keyChain)).resolves.toEqual([]);
        await expect(
            sourceWith(null).source.findReferences(keyChain),
        ).resolves.toEqual([]);
    });

    it("checks the spec of a configuration document that is not stored", () => {
        const { source } = sourceWith(null);

        expect(
            source.namesKeyChain(
                {
                    authorizationServers: [
                        { token: { signingKeyId: "signing" } },
                    ],
                },
                keyChain,
            ),
        ).toBe(true);
        // IssuanceConfig v6 removed the top-level signingKeyId.
        expect(
            source.namesKeyChain({ signingKeyId: "signing" }, keyChain),
        ).toBe(false);
        expect(source.namesKeyChain(null, keyChain)).toBe(false);
    });
});
