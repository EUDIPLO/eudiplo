import "reflect-metadata";
import {
    PostgreSqlContainer,
    type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ClientEntity } from "../../../src/auth/client/entities/client.entity.js";
import { TenantEntity } from "../../../src/auth/tenant/entities/tenant.entity.js";
import { ActiveCredentialSlot } from "../../../src/issuer/status-list/entities/active-credential-slot.entity.js";
import { StatusListEntity } from "../../../src/issuer/status-list/entities/status-list.entity.js";
import { StatusMapping } from "../../../src/issuer/status-list/entities/status-mapping.entity.js";
import { StatusListService } from "../../../src/issuer/status-list/status-list.service.js";
import { describeWithContainers } from "../../container-runtime.js";
import { initializeTestEncryption } from "../../persistence/test-encryption.js";

/** More concurrent issuances than optimistic retries could ever absorb. */
const CONCURRENT_ISSUANCES = 40;
const CAPACITY = 64;

describeWithContainers("PostgreSQL status entry allocation", () => {
    let db: DataSource;
    let container: StartedPostgreSqlContainer;
    let service: StatusListService;

    beforeAll(async () => {
        await initializeTestEncryption();
        container = await new PostgreSqlContainer("postgres:16-alpine").start();
        db = await new DataSource({
            type: "postgres",
            url: container.getConnectionUri(),
            entities: [
                ClientEntity,
                TenantEntity,
                StatusListEntity,
                StatusMapping,
                ActiveCredentialSlot,
            ],
            synchronize: true,
            // Enough connections that every issuance holds its own
            // transaction and they really wait on the row lock.
            extra: { max: CONCURRENT_ISSUANCES + 5 },
        }).initialize();
        await db.getRepository(TenantEntity).save({
            id: "tenant-1",
            name: "Tenant 1",
            status: "active",
        });
    }, 60_000);

    afterAll(async () => {
        if (db?.isInitialized) await db.destroy();
        await container?.stop();
    });

    /** A list of CAPACITY entries with `free` of them still unallocated. */
    const saveList = (
        id: string,
        credentialConfigurationId: string | null,
        free = CAPACITY,
        createdAt = new Date(),
    ) =>
        db.getRepository(StatusListEntity).save({
            id,
            tenantId: "tenant-1",
            credentialConfigurationId,
            elements: new Array(CAPACITY).fill(0),
            stack: Array.from({ length: free }, (_, index) => index),
            bits: 1,
            jwt: "cached.status.jwt",
            createdAt,
        });

    beforeEach(async () => {
        vi.restoreAllMocks();
        // A fresh service per test, so stubs set by one test do not leak.
        service = new StatusListService(
            {
                publicUrl: "https://issuer.example",
                statusCapacity: CAPACITY,
                statusBits: 1,
            },
            {} as never,
            {} as never,
            db,
            db.getRepository(StatusMapping),
            db.getRepository(StatusListEntity),
            db.getRepository(TenantEntity),
            {} as never,
            {} as never,
            { register: vi.fn() } as never,
            db.getRepository(ActiveCredentialSlot),
            {} as never,
            {} as never,
        );
        await db.getRepository(StatusMapping).delete({ tenantId: "tenant-1" });
        await db
            .getRepository(StatusListEntity)
            .delete({ tenantId: "tenant-1" });
        await saveList("list-1", null, CAPACITY, new Date(1_000));
    });

    const issue = (count: number, firstSession = 0) =>
        Promise.allSettled(
            Array.from({ length: count }, (_, n) =>
                service.createEntry(
                    {
                        id: `session-${firstSession + n}`,
                        tenantId: "tenant-1",
                    } as never,
                    "config-1",
                ),
            ),
        );

    const fulfilled = <T>(results: PromiseSettledResult<T>[]): T[] => {
        expect(results.filter((r) => r.status === "rejected")).toEqual([]);
        return results.map((r) => (r as PromiseFulfilledResult<T>).value);
    };

    /** Resolve once some connection is blocked waiting for a row lock. */
    const waitForLockWait = async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
            const waiting: unknown[] = await db.query(
                "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
            );
            if (waiting.length > 0) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("No allocation started waiting for the row lock");
    };

    /** Every list's free indexes and its mappings never overlap. */
    const expectStacksMatchMappings = async () => {
        const lists = await db
            .getRepository(StatusListEntity)
            .findBy({ tenantId: "tenant-1" });
        for (const list of lists) {
            const mapped = (
                await db
                    .getRepository(StatusMapping)
                    .findBy({ tenantId: "tenant-1", statusListId: list.id })
            ).map((m) => m.index);
            expect(new Set(mapped).size).toBe(mapped.length);
            expect(list.stack.filter((i) => mapped.includes(i))).toEqual([]);
        }
    };

    test("concurrent issuances on one list all get a distinct index", async () => {
        const results = await issue(CONCURRENT_ISSUANCES);

        const rejected = results.filter((r) => r.status === "rejected");
        expect(rejected).toEqual([]);
        const indexes = results.map((r) =>
            r.status === "fulfilled" ? r.value.status.status_list.idx : -1,
        );
        expect(new Set(indexes).size).toBe(CONCURRENT_ISSUANCES);

        const list = await db
            .getRepository(StatusListEntity)
            .findOneByOrFail({ tenantId: "tenant-1", id: "list-1" });
        expect(list.stack).toHaveLength(CAPACITY - CONCURRENT_ISSUANCES);
        expect(list.stack.filter((i) => indexes.includes(i))).toEqual([]);
        const mappings = await db
            .getRepository(StatusMapping)
            .findBy({ tenantId: "tenant-1", statusListId: "list-1" });
        expect(mappings.map((m) => m.index).sort((a, b) => a - b)).toEqual(
            [...indexes].sort((a, b) => a - b),
        );
    });

    test("allocation leaves the version and the cached token alone", async () => {
        const before = await db
            .getRepository(StatusListEntity)
            .findOneByOrFail({ tenantId: "tenant-1", id: "list-1" });

        await issue(5);

        const after = await db
            .getRepository(StatusListEntity)
            .findOneByOrFail({ tenantId: "tenant-1", id: "list-1" });
        expect(after.version).toBe(before.version);
        expect(after.jwt).toBe("cached.status.jwt");
    });

    test("moves on to the next list when another allocation took the last free indexes", async () => {
        await db
            .getRepository(StatusListEntity)
            .update(
                { tenantId: "tenant-1", id: "list-1" },
                { stack: [0, 1, 2] },
            );
        await saveList("list-2", null, CAPACITY, new Date(2_000));

        const entries = fulfilled(await issue(CONCURRENT_ISSUANCES));

        const perList = Map.groupBy(
            entries,
            (e) => e.status.status_list.uri.split("/").pop() as string,
        );
        expect(perList.get("list-1")).toHaveLength(3);
        expect(perList.get("list-2")).toHaveLength(CONCURRENT_ISSUANCES - 3);
        await expectStacksMatchMappings();
    });

    test("creates a new list when the last candidate was drained under the lock", async () => {
        await db
            .getRepository(StatusListEntity)
            .update(
                { tenantId: "tenant-1", id: "list-1" },
                { stack: [0, 1, 2] },
            );
        // New lists are created as usual; only signing their tokens is
        // left out.
        Object.assign(service as object, {
            regenerateListTokens: (tenantId: string, id: string) =>
                db
                    .getRepository(StatusListEntity)
                    .findOneByOrFail({ tenantId, id }),
        });

        const entries = fulfilled(await issue(10));

        const onFirstList = entries.filter((e) =>
            e.status.status_list.uri.endsWith("/list-1"),
        );
        expect(onFirstList).toHaveLength(3);
        await expectStacksMatchMappings();
    });

    test("fills a dedicated list before a shared one", async () => {
        await saveList("list-dedicated", "config-1", CAPACITY, new Date(2_000));

        const entries = fulfilled(await issue(20));

        expect(
            entries.every((e) =>
                e.status.status_list.uri.endsWith("/list-dedicated"),
            ),
        ).toBe(true);
        await expectStacksMatchMappings();
    });

    test("does not allocate from a list bound elsewhere while it waited for the lock", async () => {
        await saveList("list-2", null, CAPACITY, new Date(2_000));
        const holder = db.createQueryRunner();
        await holder.connect();
        await holder.startTransaction();
        try {
            await holder.manager.findOne(StatusListEntity, {
                where: { tenantId: "tenant-1", id: "list-1" },
                lock: { mode: "pessimistic_write" },
            });
            // The allocation reads list-1 as shared, then waits for the lock.
            const allocation = issue(1);
            await waitForLockWait();
            await holder.manager.update(
                StatusListEntity,
                { tenantId: "tenant-1", id: "list-1" },
                { credentialConfigurationId: "config-2" },
            );
            await holder.commitTransaction();

            const [entry] = fulfilled(await allocation);
            expect(entry.status.status_list.uri).toMatch(/\/list-2$/);
        } finally {
            await holder.release();
        }
    });

    test("issuances and revocations on one list do not make each other retry", async () => {
        Object.assign(service as object, {
            statusListConfigService: {
                getEffectiveConfig: vi
                    .fn()
                    .mockResolvedValue({ immediateUpdate: false }),
            },
        });
        fulfilled(await issue(10));
        const delay = vi.spyOn(
            service as unknown as { delay: (ms: number) => Promise<void> },
            "delay",
        );

        // Revocations of one list conflict with each other by design (the
        // version guards its values), so they run one after another here,
        // each of them alongside the issuances.
        const revokeInTurn = async () => {
            for (let n = 0; n < 10; n++) {
                await service.updateStatus(
                    { sessionId: `session-${n}`, status: 1 } as never,
                    "tenant-1",
                );
            }
            return "ok";
        };
        const [issued, revoked] = await Promise.all([
            issue(20, 100),
            revokeInTurn(),
        ]);

        fulfilled(issued);
        expect(revoked).toBe("ok");
        expect(delay).not.toHaveBeenCalled();
        await expectStacksMatchMappings();
    });
});
