import { randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import { beforeEach, describe, expect, it } from "vitest";
import { AddDpopProofJti1783000000000 } from "../../src/database/migrations/1783000000000-AddDpopProofJti.js";
import { TypeOrmDpopProofReplayRegistry } from "../../src/issuer/issuance/oid4vci/adapters/typeorm-dpop-proof-replay-registry.js";
import { DpopProofJtiEntity } from "../../src/issuer/issuance/oid4vci/entities/dpop-proof-jti.entity.js";

export const dpopProofEntities = [DpopProofJtiEntity];

/** Creates `dpop_proof_jti` through its migration, as a deployment would. */
export async function migrateDpopProofTable(db: DataSource): Promise<void> {
    const queryRunner = db.createQueryRunner();
    try {
        await new AddDpopProofJti1783000000000().up(queryRunner);
    } finally {
        await queryRunner.release();
    }
}

const inOneMinute = () => new Date(Date.now() + 60_000);

/** The same observable contract runs against real SQLite and PostgreSQL. */
export function dpopProofReplayRegistryContract(
    getDataSource: () => DataSource,
) {
    describe("DPoP proof replay registry contract", () => {
        let registry: TypeOrmDpopProofReplayRegistry;
        let jkt: string;

        beforeEach(async () => {
            const repository =
                getDataSource().getRepository(DpopProofJtiEntity);
            await repository.clear();
            registry = new TypeOrmDpopProofReplayRegistry(repository);
            jkt = randomUUID();
        });

        it("accepts a proof once and rejects its replay", async () => {
            await expect(
                registry.register(jkt, "jti-1", inOneMinute()),
            ).resolves.toBe(true);
            await expect(
                registry.register(jkt, "jti-1", inOneMinute()),
            ).resolves.toBe(false);
        });

        it("tracks jti values per key thumbprint", async () => {
            await registry.register(jkt, "jti-1", inOneMinute());
            await expect(
                registry.register(randomUUID(), "jti-1", inOneMinute()),
            ).resolves.toBe(true);
            await expect(
                registry.register(jkt, "jti-2", inOneMinute()),
            ).resolves.toBe(true);
        });

        it("accepts a proof again once its entry expired", async () => {
            await registry.register(jkt, "jti-1", new Date(Date.now() - 1000));
            await expect(
                registry.register(jkt, "jti-1", inOneMinute()),
            ).resolves.toBe(true);
            await expect(
                registry.register(jkt, "jti-1", inOneMinute()),
            ).resolves.toBe(false);
        });

        it("accepts exactly one of concurrent registrations", async () => {
            const results = await Promise.all(
                Array.from({ length: 8 }, () =>
                    registry.register(jkt, "jti-1", inOneMinute()),
                ),
            );
            expect(results.filter(Boolean)).toHaveLength(1);
        });

        it("accepts exactly one of concurrent registrations over an expired entry", async () => {
            await registry.register(jkt, "jti-1", new Date(Date.now() - 1000));
            const results = await Promise.all(
                Array.from({ length: 8 }, () =>
                    registry.register(jkt, "jti-1", inOneMinute()),
                ),
            );
            expect(results.filter(Boolean)).toHaveLength(1);
        });

        it("deletes only expired entries", async () => {
            await registry.register(
                jkt,
                "expired",
                new Date(Date.now() - 1000),
            );
            await registry.register(jkt, "valid", inOneMinute());

            await registry.deleteExpired(new Date());

            const remaining = await getDataSource()
                .getRepository(DpopProofJtiEntity)
                .find();
            expect(remaining.map((entry) => entry.jti)).toEqual(["valid"]);
        });
    });
}
