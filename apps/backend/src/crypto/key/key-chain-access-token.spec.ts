import { InternalServerErrorException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { KeyChainEntity, KeyUsage } from "./entities/key-chain.entity.js";
import { KeyChainService } from "./key-chain.service.js";
import { KeyUsageType } from "./types/key-usage-type.js";

const jwk = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d", kid: "k" };

function keyChain(
    id: string,
    usageType: KeyUsageType,
    createdAt = new Date(0),
): KeyChainEntity {
    return Object.assign(new KeyChainEntity(), {
        id,
        tenantId: "tenant",
        usageType,
        usage: KeyUsage.Sign,
        kmsProvider: "db",
        activeJwk: { ...jwk, kid: `${id}-key` },
        activeCertificate: "",
        createdAt,
    });
}

/** Repository over `rows` that filters by the `where` columns and sorts by `order`. */
function repository(rows: KeyChainEntity[]) {
    const matching = ({ where, order }: any) =>
        rows
            .filter((row) =>
                Object.entries(where).every(
                    ([column, value]) => (row as any)[column] === value,
                ),
            )
            .sort((a, b) =>
                order
                    ? a.createdAt.getTime() - b.createdAt.getTime() ||
                      a.id.localeCompare(b.id)
                    : 0,
            );
    return {
        findOne: vi.fn(async (options: any) => matching(options)[0] ?? null),
        findOneOrFail: vi.fn(async (options: any) => {
            const row = matching(options)[0];
            if (!row) throw new Error("not found");
            return row;
        }),
    };
}

function setup(
    rows: KeyChainEntity[],
    defaults: Record<string, string> | null = null,
) {
    const keyChains = repository(rows);
    const created: KeyChainEntity[] = [];
    const svc = Object.create(KeyChainService.prototype) as any;
    svc.keyChainRepository = keyChains;
    svc.tenantRepository = {
        findOne: vi.fn(async () => ({
            id: "tenant",
            defaultKeyChains: defaults,
        })),
    };
    svc.logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };
    svc.createWithId = vi.fn(
        async (
            _tenantId: string,
            id: string,
            dto: any,
            options: { insertOnly?: boolean; keyName?: string },
        ) => {
            if (!options.insertOnly) throw new Error("must not overwrite");
            if (rows.some((row) => row.id === id)) {
                throw new Error("duplicate key");
            }
            const entity = keyChain(id, dto.usageType, new Date(1000));
            rows.push(entity);
            created.push(entity);
            return id;
        },
    );
    return { service: svc as KeyChainService, svc, created };
}

describe("KeyChainService.resolveAccessTokenKeyChain", () => {
    it("never picks an access or attestation key chain", async () => {
        const { service, svc, created } = setup([
            keyChain("registrar", KeyUsageType.Access),
            keyChain("credentials", KeyUsageType.Attestation),
        ]);

        const resolved = await service.resolveAccessTokenKeyChain("tenant");

        expect(resolved.id).toBe("access-token");
        expect(resolved.usageType).toBe(KeyUsageType.AccessToken);
        expect(created).toHaveLength(1);
        // Every tenant has this key chain ID; external KMS key names must
        // not derive from it.
        const { keyName } = svc.createWithId.mock.calls[0][3];
        expect(keyName).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("uses the oldest access token key chain, the ID breaking ties", async () => {
        const { service, svc, created } = setup([
            keyChain("newer", KeyUsageType.AccessToken, new Date(2000)),
            keyChain("b-old", KeyUsageType.AccessToken, new Date(1000)),
            keyChain("a-old", KeyUsageType.AccessToken, new Date(1000)),
        ]);

        await expect(
            service.resolveAccessTokenKeyChain("tenant"),
        ).resolves.toMatchObject({ id: "a-old" });
        expect(created).toHaveLength(0);
        expect(svc.keyChainRepository.findOne).toHaveBeenCalledWith(
            expect.objectContaining({
                order: { createdAt: "ASC", id: "ASC" },
            }),
        );
    });

    it("uses the accessToken entry of the key chain defaults", async () => {
        const { service } = setup(
            [
                keyChain("old", KeyUsageType.AccessToken, new Date(0)),
                keyChain("chosen", KeyUsageType.AccessToken, new Date(5000)),
            ],
            { accessToken: "chosen" },
        );

        await expect(
            service.resolveAccessTokenKeyChain("tenant"),
        ).resolves.toMatchObject({ id: "chosen" });
    });

    it("uses the key chain the authorization server names over the default", async () => {
        const { service } = setup(
            [
                keyChain("default", KeyUsageType.AccessToken),
                keyChain("named", KeyUsageType.AccessToken),
            ],
            { accessToken: "default" },
        );

        await expect(
            service.resolveAccessTokenKeyChain("tenant", "named"),
        ).resolves.toMatchObject({ id: "named" });
    });

    it("refuses a named key chain of another usage type without naming it to the wallet", async () => {
        const { service, svc } = setup([
            keyChain("credentials", KeyUsageType.Attestation),
        ]);

        const error = await service
            .resolveAccessTokenKeyChain("tenant", "credentials")
            .catch((e) => e);

        expect(error).toBeInstanceOf(InternalServerErrorException);
        expect(error.message).not.toContain("credentials");
        expect(svc.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('usage type "attestation"'),
        );
    });

    it("refuses a default entry that names a missing key chain instead of falling back", async () => {
        const { service, created } = setup(
            [keyChain("token", KeyUsageType.AccessToken)],
            { accessToken: "gone" },
        );

        await expect(
            service.resolveAccessTokenKeyChain("tenant"),
        ).rejects.toBeInstanceOf(InternalServerErrorException);
        expect(created).toHaveLength(0);
    });

    it("uses the key chain a concurrent request created first", async () => {
        const rows: KeyChainEntity[] = [];
        const { service, svc } = setup(rows);
        const original = svc.createWithId;
        svc.createWithId = vi.fn(async (...args: unknown[]) => {
            // Another request inserts the key chain first.
            rows.push(keyChain("access-token", KeyUsageType.AccessToken));
            return original(...args);
        });

        await expect(
            service.resolveAccessTokenKeyChain("tenant"),
        ).resolves.toMatchObject({ id: "access-token" });
        expect(rows).toHaveLength(1);
    });

    it("uses the key chain a concurrent request created before the ID check", async () => {
        const rows: KeyChainEntity[] = [];
        const { service, svc } = setup(rows);
        const findOne = svc.keyChainRepository.findOne;
        // The oldest lookup finds nothing; by the ID check it exists.
        svc.keyChainRepository.findOne = vi.fn(async (options: any) => {
            const result = await findOne(options);
            if (options.order) {
                rows.push(keyChain("access-token", KeyUsageType.AccessToken));
            }
            return result;
        });

        await expect(
            service.resolveAccessTokenKeyChain("tenant"),
        ).resolves.toMatchObject({ id: "access-token" });
        expect(svc.createWithId).not.toHaveBeenCalled();
    });

    it("fails without naming the cause when the key cannot be created", async () => {
        const { service, svc } = setup([]);
        svc.createWithId = vi.fn(async () => {
            throw new Error("KMS unreachable");
        });

        const error = await service
            .resolveAccessTokenKeyChain("tenant")
            .catch((e) => e);

        expect(error).toBeInstanceOf(InternalServerErrorException);
        expect(error.message).not.toContain("KMS");
        expect(svc.logger.error).toHaveBeenCalledWith(
            expect.stringContaining("KMS unreachable"),
        );
    });

    it("fails when a key chain of another usage type holds the ID", async () => {
        const { service, svc } = setup([
            keyChain("access-token", KeyUsageType.Attestation),
        ]);

        await expect(
            service.resolveAccessTokenKeyChain("tenant"),
        ).rejects.toBeInstanceOf(InternalServerErrorException);
        expect(svc.logger.error).toHaveBeenCalled();
        // No KMS key is created and deleted again on each request.
        expect(svc.createWithId).not.toHaveBeenCalled();
    });
});

describe("KeyChainService.accessTokenKeyChainRefusal", () => {
    it("accepts only access token key chains of the tenant", async () => {
        const { service } = setup([
            keyChain("token", KeyUsageType.AccessToken),
            keyChain("registrar", KeyUsageType.Access),
        ]);

        await expect(
            service.accessTokenKeyChainRefusal("tenant", "token"),
        ).resolves.toBeUndefined();
        await expect(
            service.accessTokenKeyChainRefusal("tenant", "registrar"),
        ).resolves.toContain('usage type "access"');
        await expect(
            service.accessTokenKeyChainRefusal("tenant", "missing"),
        ).resolves.toContain("does not exist");
    });
});

describe("KeyChainService.getAccessTokenVerificationKeys", () => {
    it("publishes no keys before a token was issued instead of creating a key chain", async () => {
        const { service, created } = setup([
            keyChain("registrar", KeyUsageType.Access),
        ]);

        await expect(
            service.getAccessTokenVerificationKeys("tenant", undefined, 300),
        ).resolves.toEqual([]);
        expect(created).toHaveLength(0);
    });

    it("publishes the public keys of the access token key chain", async () => {
        const { service } = setup([
            keyChain("token", KeyUsageType.AccessToken),
        ]);

        const keys = await service.getAccessTokenVerificationKeys(
            "tenant",
            undefined,
            300,
        );

        expect(keys.map((key) => key.kid)).toEqual(["token-key"]);
        expect(keys[0]).not.toHaveProperty("d");
    });
});

describe("KeyChainService creation of the access token key chain", () => {
    /** A service whose external KMS generates and deletes keys by name. */
    function withKms(insert: () => Promise<unknown>) {
        const adapter = {
            type: "vault",
            providerId: "vault",
            capabilities: {
                supportedAlgs: ["ES256"],
                defaultAlg: "ES256",
                canDelete: true,
            },
            generateKey: vi.fn(async ({ kid }: { kid: string }) => ({
                ref: {
                    externalKeyId: kid,
                    publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y", kid },
                    alg: "ES256",
                },
            })),
            deleteKey: vi.fn(),
        };
        const svc = Object.create(KeyChainService.prototype) as any;
        svc.logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };
        svc.tenantRepository = {
            findOne: vi.fn(async () => ({
                id: "tenant",
                defaultKeyChains: null,
            })),
            findOneByOrFail: vi.fn(async () => ({ id: "tenant", name: "t" })),
        };
        svc.configService = { getOrThrow: () => "https://issuer.example" };
        svc.kmsRegistry = { resolve: () => adapter };
        svc.certBuilder = { createSelfSignedCert: vi.fn(async () => "PEM") };
        svc.keyChainRepository = {
            findOne: vi.fn(async () => null),
            findOneOrFail: vi.fn(async () =>
                keyChain("access-token", KeyUsageType.AccessToken),
            ),
            insert: vi.fn(insert),
            save: vi.fn(),
        };
        return { service: svc as KeyChainService, svc, adapter };
    }

    it("names the KMS key randomly, never after the key chain ID every tenant shares", async () => {
        const { service, adapter, svc } = withKms(async () => undefined);

        await service.resolveAccessTokenKeyChain("tenant");

        const { kid } = adapter.generateKey.mock.calls[0][0];
        expect(kid).not.toContain("access-token");
        expect(kid).toMatch(/^[0-9a-f-]{36}-active$/);
        expect(svc.keyChainRepository.save).not.toHaveBeenCalled();
    });

    it("deletes the key it generated when the insert loses, never overwriting the winner", async () => {
        const { service, adapter, svc } = withKms(async () => {
            throw new Error("UNIQUE constraint failed");
        });
        // The winner's key chain shows up after the failed insert.
        svc.keyChainRepository.findOne
            .mockResolvedValueOnce(null) // oldest before creating
            .mockResolvedValueOnce(null) // nothing blocks the ID
            .mockResolvedValueOnce(
                keyChain("access-token", KeyUsageType.AccessToken),
            );

        await expect(
            service.resolveAccessTokenKeyChain("tenant"),
        ).resolves.toMatchObject({ id: "access-token" });

        const generated = adapter.generateKey.mock.calls[0][0].kid;
        expect(adapter.deleteKey).toHaveBeenCalledWith(
            expect.objectContaining({ externalKeyId: generated }),
        );
        expect(svc.keyChainRepository.save).not.toHaveBeenCalled();
    });
});
