import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { KeyChainEntity, KeyUsage } from "./entities/key-chain.entity.js";
import { KeyChainSigningService } from "./key-chain-signing.service.js";
import { KeyUsageType } from "./types/key-usage-type.js";

describe("KeyChainSigningService", () => {
    it("does not sign with the tenant's encryption key chain", async () => {
        const encryptionKeyChain = Object.assign(new KeyChainEntity(), {
            id: "encryption",
            tenantId: "tenant",
            usageType: KeyUsageType.Encrypt,
            usage: KeyUsage.Encrypt,
            kmsProvider: "db",
        });
        const adapter = { type: "db", sign: vi.fn() };
        const service = Object.create(KeyChainSigningService.prototype) as any;
        service.keyChainRepository = {
            // Returns the stored key chain when it matches every condition.
            findOne: async ({ where }: { where: Record<string, unknown> }) =>
                Object.entries(where).every(
                    ([key, value]) =>
                        encryptionKeyChain[key as keyof KeyChainEntity] ===
                        value,
                )
                    ? encryptionKeyChain
                    : null,
        };
        service.kmsRegistry = { resolve: () => adapter };

        await expect(
            service.signBytes(new Uint8Array([1]), "tenant", "encryption"),
        ).rejects.toThrow(NotFoundException);
        await expect(
            service.createCertificateSigningRequest("tenant", "encryption"),
        ).rejects.toThrow(NotFoundException);
        expect(adapter.sign).not.toHaveBeenCalled();
    });

    it("puts the key chain ID into the header of a key without kid, as the JWKS does", async () => {
        const { kid: _, ...withoutKid } = {
            kty: "EC",
            crv: "P-256",
            x: "pmn8SKQKZ0t2zFlrUXzJaJwwQ0WnQxcSYoS_D6ZSGho",
            y: "rMd9JTAovcOI_OvOXWCWZ1yVZieVYK2UgvB2IPuSk2o",
            d: "rqv47L1jWkbFAGMCK8TORQ1FknBUYGY6OLU1dYHNDqU",
            kid: "unused",
        };
        const keyChain = Object.assign(new KeyChainEntity(), {
            id: "token-chain",
            tenantId: "tenant",
            usageType: KeyUsageType.AccessToken,
            usage: KeyUsage.Sign,
            kmsProvider: "db",
            activeJwk: withoutKid,
        });
        const service = Object.create(KeyChainSigningService.prototype) as any;
        service.keyChainRepository = { findOne: async () => keyChain };
        service.kmsRegistry = {
            resolve: () => ({
                type: "db",
                sign: async () => new Uint8Array(64),
            }),
        };

        const jwt: string = await service.signJWT(
            {},
            { typ: "at+jwt" },
            "tenant",
            "token-chain",
        );

        const header = JSON.parse(
            Buffer.from(jwt.split(".")[0], "base64url").toString(),
        );
        expect(header.kid).toBe("token-chain");
    });
});
