import { DataSource } from "typeorm";
import { afterEach, describe, expect, test } from "vitest";
import { ClientEntity } from "../auth/client/entities/client.entity.js";
import { TenantEntity } from "../auth/tenant/entities/tenant.entity.js";
import { WebhookEndpointEntity } from "../issuer/configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import { PresentationConfig } from "../verifier/presentations/entities/presentation-config.entity.js";
import { AddAllowUntrustedIssuersToPresentationConfig1786900000000 } from "./migrations/1786900000000-AddAllowUntrustedIssuersToPresentationConfig.js";

describe("AddAllowUntrustedIssuersToPresentationConfig1786900000000", () => {
    let dataSource: DataSource | undefined;

    afterEach(async () => {
        await dataSource?.destroy();
        dataSource = undefined;
    });

    test("keeps existing configurations, which then require trusted authorities, and adds the column idempotently", async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [
                TenantEntity,
                ClientEntity,
                WebhookEndpointEntity,
                PresentationConfig,
            ],
        });
        await dataSource.initialize();
        await dataSource.synchronize();
        const queryRunner = dataSource.createQueryRunner();
        const migration =
            new AddAllowUntrustedIssuersToPresentationConfig1786900000000();
        // The schema of 10.x, with a configuration written then.
        await migration.down(queryRunner);
        await queryRunner.query("PRAGMA foreign_keys = OFF");
        await queryRunner.query(
            `INSERT INTO "presentation_config" ("id", "tenantId", "dcql_query") VALUES ('pid', 't', '{"credentials":[]}')`,
        );

        await migration.up(queryRunner);
        await migration.up(queryRunner);

        const rows = await queryRunner.query(
            `SELECT "id", "allowUntrustedIssuers" FROM "presentation_config"`,
        );
        expect(rows).toEqual([{ id: "pid", allowUntrustedIssuers: 0 }]);

        await migration.down(queryRunner);
        expect(
            (
                await queryRunner.getTable("presentation_config")
            )?.findColumnByName("allowUntrustedIssuers"),
        ).toBeUndefined();
    });
});
