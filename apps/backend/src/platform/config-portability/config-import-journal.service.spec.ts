import "reflect-metadata";
import { DataSource } from "typeorm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddConfigImportRun1781000000000 } from "../../database/migrations/1781000000000-AddConfigImportRun.js";
import { ConfigImportJournalService } from "./config-import-journal.service.js";
import { ConfigImportRunEntity } from "./entities/config-import-run.entity.js";

describe("durable configuration journal", () => {
    let db: DataSource;
    let journal: ConfigImportJournalService;
    beforeEach(async () => {
        db = await new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [ConfigImportRunEntity],
            migrations: [AddConfigImportRun1781000000000],
            migrationsRun: true,
        }).initialize();
        journal = new ConfigImportJournalService(
            db.getRepository(ConfigImportRunEntity),
        );
    });
    afterEach(async () => {
        await db.destroy();
    });
    it("serializes writers across service instances and releases the lock on success", async () => {
        const other = new ConfigImportJournalService(
            db.getRepository(ConfigImportRunEntity),
        );
        await journal.run("tenant", "upsert", async (run) => {
            await expect(
                other.run("tenant", "api", async () => undefined),
            ).rejects.toMatchObject({
                response: expect.objectContaining({
                    code: "CONFIG_WRITER_ACTIVE",
                    operationId: run.id,
                }),
            });
            await other.run("other-tenant", "upsert", async () => undefined);
            await expect(
                journal.acknowledgeInterruption("tenant", run.id),
            ).rejects.toThrow("still executing");
        });
        await other.run("tenant", "api", async () => undefined);
        expect(
            (await journal.list("tenant")).every(
                (run) =>
                    run.status === "completed" && run.activeTenant === null,
            ),
        ).toBe(true);
    });
    it("persists in-flight progress and failure without recording exception secrets", async () => {
        let id = "";
        await expect(
            journal.run("tenant", "upsert", async (run) => {
                id = run.id;
                run.operations = [
                    {
                        stage: "resource",
                        kind: "Client",
                        id: "client",
                        status: "running",
                    },
                ];
                await journal.checkpoint(run);
                expect(
                    (await journal.get("tenant", id)).operations[0].status,
                ).toBe("running");
                throw new Error("private-provider-secret");
            }),
        ).rejects.toThrow("private-provider-secret");
        const other = new ConfigImportJournalService(
            db.getRepository(ConfigImportRunEntity),
        );
        const report = await other.get("tenant", id);
        expect(report.status).toBe("failed");
        expect(report.activeTenant).toBeNull();
        expect(JSON.stringify(report)).not.toContain("private-provider-secret");
        await expect(other.get("other-tenant", id)).rejects.toThrow(
            "not found",
        );
    });
    it("retains a crashed worker's lock until explicit acknowledgment; recovery never replays operations", async () => {
        await db.getRepository(ConfigImportRunEntity).insert({
            id: "crashed",
            tenantId: "tenant",
            activeTenant: "tenant",
            mode: "upsert",
            status: "running",
            operations: [
                {
                    stage: "resource",
                    kind: "KeyChain",
                    id: "key",
                    status: "running",
                },
            ],
        });
        await expect(
            journal.run("tenant", "upsert", async () => undefined),
        ).rejects.toThrow();
        const report = await journal.acknowledgeInterruption(
            "tenant",
            "crashed",
        );
        expect(report.status).toBe("interrupted");
        expect(report.operations[0].status).toBe("running");
        await journal.run("tenant", "upsert", async () => undefined);
    });
    it("preserves generated secrets in the response when final journal persistence fails", async () => {
        const repository = db.getRepository(ConfigImportRunEntity);
        const spy = vi
            .spyOn(repository, "update")
            .mockRejectedValueOnce(new Error("database offline"));
        const generatedSecrets = [
            {
                kind: "Client",
                id: "client",
                path: "/spec/secret",
                value: "one-time-secret",
            },
        ];
        try {
            await expect(
                journal.run("tenant", "upsert", async () => ({
                    generatedSecrets,
                })),
            ).rejects.toMatchObject({
                response: expect.objectContaining({
                    code: "CONFIG_JOURNAL_WRITE_FAILED",
                    generatedSecrets,
                }),
            });
            const report = (await journal.list("tenant"))[0];
            expect(report.status).toBe("running");
            expect(JSON.stringify(report)).not.toContain("one-time-secret");
        } finally {
            spy.mockRestore();
        }
    });
    it("can roll back the journal migration", async () => {
        await db.undoLastMigration();
        expect(await db.createQueryRunner().hasTable("config_import_run")).toBe(
            false,
        );
    });
});
