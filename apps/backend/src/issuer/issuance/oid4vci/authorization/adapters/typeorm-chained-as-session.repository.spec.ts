import { randomUUID } from "node:crypto";
import { DataSource, type Repository } from "typeorm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ChainedAsSessionStatus } from "../domain/chained-as-session.js";
import { ChainedAsSessionEntity } from "../shared/entities/chained-as-session.entity.js";
import { TypeOrmChainedAsSessionRepository } from "./typeorm-chained-as-session.repository.js";

describe("TypeOrmChainedAsSessionRepository", () => {
    it("scopes the issuer_state lookup to the tenant", async () => {
        const findOne = vi.fn().mockResolvedValue(null);
        const repository = new TypeOrmChainedAsSessionRepository({
            findOne,
        } as unknown as Repository<ChainedAsSessionEntity>);

        await repository.findByIssuerState("tenant-1", "issuer-state");

        expect(findOne).toHaveBeenCalledWith({
            where: { tenantId: "tenant-1", issuerState: "issuer-state" },
        });
    });
});

describe("SQLite chained AS session cleanup", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = new Date();
    let db: DataSource;

    beforeAll(async () => {
        db = await new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [ChainedAsSessionEntity],
            synchronize: true,
        }).initialize();
    });

    afterAll(async () => {
        if (db?.isInitialized) await db.destroy();
    });

    async function store(
        id: string,
        values: Partial<ChainedAsSessionEntity>,
    ): Promise<void> {
        await db.getRepository(ChainedAsSessionEntity).save({
            id: randomUUID(),
            tenantId: "tenant-1",
            status: ChainedAsSessionStatus.TOKEN_ISSUED,
            issuerState: id,
            clientId: "wallet",
            redirectUri: "https://wallet.example/cb",
            expiresAt: new Date(now.getTime() + 60_000),
            ...values,
        });
    }

    it("deletes expired sessions unless they hold a valid refresh token", async () => {
        const past = new Date(now.getTime() - 60_000);
        await store("active", {});
        await store("expired", { expiresAt: past });
        await store("expired-refresh", {
            expiresAt: past,
            refreshToken: "r1",
            refreshTokenExpiresAt: past,
        });
        await store("valid-refresh", {
            expiresAt: past,
            refreshToken: "r2",
            refreshTokenExpiresAt: new Date(now.getTime() + DAY_MS),
        });
        await store("legacy-refresh", {
            expiresAt: past,
            refreshToken: "r3",
            createdAt: new Date(now.getTime() - DAY_MS),
        });
        await store("old-legacy-refresh", {
            expiresAt: past,
            refreshToken: "r4",
            createdAt: new Date(now.getTime() - 31 * DAY_MS),
        });
        const repository = new TypeOrmChainedAsSessionRepository(
            db.getRepository(ChainedAsSessionEntity),
        );

        await expect(repository.deleteExpired(now)).resolves.toBe(3);
        const remaining = await db
            .getRepository(ChainedAsSessionEntity)
            .find({ order: { issuerState: "ASC" } });
        expect(remaining.map((session) => session.issuerState)).toEqual([
            "active",
            "legacy-refresh",
            "valid-refresh",
        ]);
        await expect(repository.deleteExpired(now)).resolves.toBe(0);
    });
});
