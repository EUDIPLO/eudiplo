import type { DataSource } from "typeorm";
import { afterEach, describe, expect, test } from "vitest";
import { AuditLogEntity } from "../../src/audit-log/entities/audit-log.entity.js";
import { RedactAuditLogSecrets1784600000000 } from "../../src/database/migrations/1784600000000-RedactAuditLogSecrets.js";

export const redactAuditLogSecretsEntities = [AuditLogEntity];

const auth = (value: string) => ({
    type: "apiKey",
    config: { headerName: "X-Key", value },
});
const servers = (clientSecret: string) => [
    { type: "built-in", id: "built-in" },
    {
        type: "chained",
        id: "chained",
        upstream: {
            issuer: "https://idp.example",
            clientId: "c",
            clientSecret,
        },
    },
];

/**
 * RedactAuditLogSecrets1784600000000 against a database that `createDb`
 * creates empty, with the schema of `redactAuditLogSecretsEntities`.
 */
export function redactAuditLogSecretsContract(
    createDb: () => Promise<DataSource>,
) {
    describe("RedactAuditLogSecrets1784600000000", () => {
        let db: DataSource;

        afterEach(async () => {
            if (db?.isInitialized) await db.destroy();
        });

        async function entry(
            actionType: string,
            before: unknown,
            after: unknown,
        ) {
            const saved = await db.getRepository(AuditLogEntity).save({
                tenantId: "t",
                actionType,
                actorType: "client",
                before,
                after,
            } as AuditLogEntity);
            return saved.id;
        }

        async function snapshots(id: string) {
            const { before, after } = await db
                .getRepository(AuditLogEntity)
                .findOneByOrFail({ id });
            return { before, after };
        }

        async function run() {
            const queryRunner = db.createQueryRunner();
            try {
                await new RedactAuditLogSecrets1784600000000().up(queryRunner);
            } finally {
                await queryRunner.release();
            }
        }

        test("redacts API keys and upstream client secrets and keeps the rest", async () => {
            db = await createDb();
            const webhook = await entry(
                "webhook_endpoint_updated",
                { id: "e", auth: auth("old-key") },
                { id: "e", auth: auth("new-key") },
            );
            const provider = await entry("attribute_provider_created", null, {
                id: "p",
                auth: auth("provider-key"),
            });
            const issuance = await entry(
                "issuance_config_updated",
                { authorizationServers: servers("old-secret") },
                { authorizationServers: servers("new-secret") },
            );
            const other = await entry(
                "presentation_config_updated",
                { id: "x", auth: auth("not-a-secret-path") },
                null,
            );

            await run();
            await run();

            expect(await snapshots(webhook)).toEqual({
                before: { id: "e", auth: auth("[REDACTED]") },
                after: { id: "e", auth: auth("[REDACTED]") },
            });
            expect(await snapshots(provider)).toEqual({
                before: null,
                after: { id: "p", auth: auth("[REDACTED]") },
            });
            expect(await snapshots(issuance)).toEqual({
                before: { authorizationServers: servers("[REDACTED]") },
                after: { authorizationServers: servers("[REDACTED]") },
            });
            expect((await snapshots(other)).before).toEqual({
                id: "x",
                auth: auth("not-a-secret-path"),
            });
        });
    });
}
