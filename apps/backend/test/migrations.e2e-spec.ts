import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    PostgreSqlContainer,
    StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { DataSource, MigrationInterface } from "typeorm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AddKeyUsageEntity1743000000000 } from "../src/database/migrations/1743000000000-AddKeyUsageEntity.js";
import { FlattenKeyUsageType1746000000000 } from "../src/database/migrations/1746000000000-FlattenKeyUsageType.js";
import { MigrateKeysToKeyChain1747000000000 } from "../src/database/migrations/1747000000000-MigrateKeysToKeyChain.js";
import { AddOauthBindingsToSession1782000000000 } from "../src/database/migrations/1782000000000-AddOauthBindingsToSession.js";
import { ChangeSessionExpiresAtToTimestamp1784000000000 } from "../src/database/migrations/1784000000000-ChangeSessionExpiresAtToTimestamp.js";
import { AddOfferLifetimeToIssuanceConfig1784100000000 } from "../src/database/migrations/1784100000000-AddOfferLifetimeToIssuanceConfig.js";
import { AddSessionListFilters1784300000000 } from "../src/database/migrations/1784300000000-AddSessionListFilters.js";
import { ChangeSessionOauthBindingsToTimestamp1784400000000 } from "../src/database/migrations/1784400000000-ChangeSessionOauthBindingsToTimestamp.js";
import { describeWithContainers } from "./container-runtime.js";
import {
    redactAuditLogSecretsContract,
    redactAuditLogSecretsEntities,
} from "./persistence/redact-audit-log-secrets.contract.js";

/**
 * Migration tests that verify migrations work correctly on both SQLite and PostgreSQL.
 *
 * These tests simulate upgrading from v3.1.2 by:
 * 1. Creating the old schema structure manually
 * 2. Inserting test data
 * 3. Running the migration
 * 4. Verifying the data was migrated correctly
 */
describe("Migration tests", () => {
    describe("AddKeyUsageEntity1743000000000", () => {
        /**
         * Creates the v3.1.2 schema structure needed before this migration runs.
         * This includes key_entity, cert_entity, and cert_usage_entity tables.
         */
        async function createOldSchema(dataSource: DataSource): Promise<void> {
            const queryRunner = dataSource.createQueryRunner();

            // Create tenant_entity (required for foreign keys)
            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "tenant_entity" (
                    "id" varchar PRIMARY KEY NOT NULL,
                    "name" varchar NOT NULL
                )
            `);

            // Create key_entity (v3.1.2 schema - before usageType column was added)
            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "key_entity" (
                    "tenantId" varchar NOT NULL,
                    "id" varchar NOT NULL,
                    "key" text,
                    "description" varchar,
                    "kmsProvider" varchar,
                    "externalKeyId" varchar,
                    "createdAt" datetime DEFAULT CURRENT_TIMESTAMP,
                    "updatedAt" datetime DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY ("tenantId", "id")
                )
            `);

            // Create cert_entity
            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "cert_entity" (
                    "tenantId" varchar NOT NULL,
                    "id" varchar NOT NULL,
                    "keyId" varchar,
                    "crt" text,
                    "description" varchar,
                    "createdAt" datetime DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY ("tenantId", "id")
                )
            `);

            // Create cert_usage_entity (the source table for migration)
            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "cert_usage_entity" (
                    "tenantId" varchar NOT NULL,
                    "certId" varchar NOT NULL,
                    "usage" varchar NOT NULL,
                    PRIMARY KEY ("tenantId", "certId", "usage")
                )
            `);

            await queryRunner.release();
        }

        /**
         * Creates the v3.1.2 schema for PostgreSQL (uses different datetime type).
         */
        async function createOldSchemaPostgres(
            dataSource: DataSource,
        ): Promise<void> {
            const queryRunner = dataSource.createQueryRunner();

            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "tenant_entity" (
                    "id" varchar PRIMARY KEY NOT NULL,
                    "name" varchar NOT NULL
                )
            `);

            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "key_entity" (
                    "tenantId" varchar NOT NULL,
                    "id" varchar NOT NULL,
                    "key" text,
                    "description" varchar,
                    "kmsProvider" varchar,
                    "externalKeyId" varchar,
                    "createdAt" timestamp DEFAULT CURRENT_TIMESTAMP,
                    "updatedAt" timestamp DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY ("tenantId", "id")
                )
            `);

            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "cert_entity" (
                    "tenantId" varchar NOT NULL,
                    "id" varchar NOT NULL,
                    "keyId" varchar,
                    "crt" text,
                    "description" varchar,
                    "createdAt" timestamp DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY ("tenantId", "id")
                )
            `);

            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "cert_usage_entity" (
                    "tenantId" varchar NOT NULL,
                    "certId" varchar NOT NULL,
                    "usage" varchar NOT NULL,
                    PRIMARY KEY ("tenantId", "certId", "usage")
                )
            `);

            await queryRunner.release();
        }

        /**
         * Inserts test data that simulates a v3.1.2 database state.
         */
        async function insertTestData(dataSource: DataSource): Promise<void> {
            const queryRunner = dataSource.createQueryRunner();

            // Insert tenant
            await queryRunner.query(`
                INSERT INTO "tenant_entity" ("id", "name") VALUES ('test-tenant', 'Test Tenant')
            `);

            // Insert keys
            await queryRunner.query(`
                INSERT INTO "key_entity" ("tenantId", "id", "key", "description")
                VALUES 
                    ('test-tenant', 'key-1', 'dummy-key-1', 'Test Key 1'),
                    ('test-tenant', 'key-2', 'dummy-key-2', 'Test Key 2')
            `);

            // Insert certificates linked to keys
            await queryRunner.query(`
                INSERT INTO "cert_entity" ("tenantId", "id", "keyId", "crt", "description")
                VALUES 
                    ('test-tenant', 'cert-1', 'key-1', 'dummy-cert-1', 'Test Cert 1'),
                    ('test-tenant', 'cert-2', 'key-2', 'dummy-cert-2', 'Test Cert 2'),
                    ('test-tenant', 'cert-3', NULL, 'orphan-cert', 'Orphan Cert without key')
            `);

            // Insert usage entries (the data that will be migrated)
            await queryRunner.query(`
                INSERT INTO "cert_usage_entity" ("tenantId", "certId", "usage")
                VALUES 
                    ('test-tenant', 'cert-1', 'issuance'),
                    ('test-tenant', 'cert-1', 'attestation'),
                    ('test-tenant', 'cert-2', 'issuance'),
                    ('test-tenant', 'cert-3', 'signing')
            `);

            await queryRunner.release();
        }

        describe("SQLite", () => {
            let dataSource: DataSource;
            let tmpDir: string;

            beforeAll(async () => {
                // Create a temp directory for the SQLite database
                tmpDir = mkdtempSync(join(tmpdir(), "eudiplo-migration-test-"));

                dataSource = new DataSource({
                    type: "better-sqlite3",
                    database: join(tmpDir, "test.db"),
                    synchronize: false,
                    logging: false,
                });

                await dataSource.initialize();
                await createOldSchema(dataSource);
                await insertTestData(dataSource);
            }, 30_000);

            afterAll(async () => {
                await dataSource?.destroy();
                if (tmpDir) {
                    rmSync(tmpDir, { recursive: true, force: true });
                }
            });

            test("migrates cert_usage_entity data to key_usage_entity", async () => {
                const migration = new AddKeyUsageEntity1743000000000();
                const queryRunner = dataSource.createQueryRunner();

                // Run the migration
                await migration.up(queryRunner);

                // Verify key_usage_entity was created and populated
                const keyUsages = await queryRunner.query(`
                    SELECT * FROM "key_usage_entity" ORDER BY "keyId", "usage"
                `);

                expect(keyUsages).toHaveLength(3); // 3 usages for certs with keyId (cert-3 has no keyId)

                // Verify specific entries
                const key1Usages = keyUsages.filter(
                    (u: { keyId: string }) => u.keyId === "key-1",
                );
                expect(key1Usages).toHaveLength(2);
                expect(
                    key1Usages.map((u: { usage: string }) => u.usage).sort(),
                ).toEqual(["attestation", "issuance"]);

                const key2Usages = keyUsages.filter(
                    (u: { keyId: string }) => u.keyId === "key-2",
                );
                expect(key2Usages).toHaveLength(1);
                expect(key2Usages[0].usage).toBe("issuance");

                await queryRunner.release();
            });

            test("migration is idempotent (can run twice)", async () => {
                const migration = new AddKeyUsageEntity1743000000000();
                const queryRunner = dataSource.createQueryRunner();

                // Running migration again should not fail
                await expect(migration.up(queryRunner)).resolves.not.toThrow();

                // Data should remain the same
                const keyUsages = await queryRunner.query(`
                    SELECT * FROM "key_usage_entity"
                `);
                expect(keyUsages).toHaveLength(3);

                await queryRunner.release();
            });

            test("down migration removes the table", async () => {
                const migration = new AddKeyUsageEntity1743000000000();
                const queryRunner = dataSource.createQueryRunner();

                // Run down migration
                await migration.down(queryRunner);

                // Verify table was dropped
                const tables = await queryRunner.query(`
                    SELECT name FROM sqlite_master WHERE type='table' AND name='key_usage_entity'
                `);
                expect(tables).toHaveLength(0);

                await queryRunner.release();
            });
        });

        describeWithContainers("PostgreSQL", () => {
            let dataSource: DataSource;
            let postgresContainer: StartedPostgreSqlContainer;

            beforeAll(async () => {
                postgresContainer = await new PostgreSqlContainer(
                    "postgres:alpine",
                )
                    .withUsername("test_user")
                    .withPassword("test_password")
                    .withDatabase("test_db")
                    .withExposedPorts(5432)
                    .start();

                dataSource = new DataSource({
                    type: "postgres",
                    host: postgresContainer.getHost(),
                    port: postgresContainer.getMappedPort(5432),
                    username: postgresContainer.getUsername(),
                    password: postgresContainer.getPassword(),
                    database: postgresContainer.getDatabase(),
                    synchronize: false,
                    logging: false,
                });

                await dataSource.initialize();
                await createOldSchemaPostgres(dataSource);
                await insertTestData(dataSource);
            }, 60_000);

            afterAll(async () => {
                await dataSource?.destroy();
                await postgresContainer?.stop();
            });

            test("migrates cert_usage_entity data to key_usage_entity", async () => {
                const migration = new AddKeyUsageEntity1743000000000();
                const queryRunner = dataSource.createQueryRunner();

                // Run the migration
                await migration.up(queryRunner);

                // Verify key_usage_entity was created and populated
                const keyUsages = await queryRunner.query(`
                    SELECT * FROM "key_usage_entity" ORDER BY "keyId", "usage"
                `);

                expect(keyUsages).toHaveLength(3);

                // Verify specific entries
                const key1Usages = keyUsages.filter(
                    (u: { keyId: string }) => u.keyId === "key-1",
                );
                expect(key1Usages).toHaveLength(2);
                expect(
                    key1Usages.map((u: { usage: string }) => u.usage).sort(),
                ).toEqual(["attestation", "issuance"]);

                const key2Usages = keyUsages.filter(
                    (u: { keyId: string }) => u.keyId === "key-2",
                );
                expect(key2Usages).toHaveLength(1);
                expect(key2Usages[0].usage).toBe("issuance");

                await queryRunner.release();
            });

            test("migration is idempotent (can run twice)", async () => {
                const migration = new AddKeyUsageEntity1743000000000();
                const queryRunner = dataSource.createQueryRunner();

                // Running migration again should not fail
                await expect(migration.up(queryRunner)).resolves.not.toThrow();

                // Data should remain the same
                const keyUsages = await queryRunner.query(`
                    SELECT * FROM "key_usage_entity"
                `);
                expect(keyUsages).toHaveLength(3);

                await queryRunner.release();
            });

            test("down migration removes the table", async () => {
                const migration = new AddKeyUsageEntity1743000000000();
                const queryRunner = dataSource.createQueryRunner();

                // Run down migration
                await migration.down(queryRunner);

                // Verify table was dropped
                const tables = await queryRunner.query(`
                    SELECT tablename FROM pg_tables WHERE tablename = 'key_usage_entity'
                `);
                expect(tables).toHaveLength(0);

                await queryRunner.release();
            });
        });
    });

    describe("FlattenKeyUsageType1746000000000", () => {
        /**
         * Creates the schema state AFTER AddKeyUsageEntity migration ran.
         * This means key_entity exists with key_usage_entity table.
         */
        async function createSchemaAfterKeyUsageMigration(
            dataSource: DataSource,
            dbType: "sqlite" | "postgres",
        ): Promise<void> {
            const queryRunner = dataSource.createQueryRunner();
            const timestampType =
                dbType === "sqlite" ? "datetime" : "timestamp";

            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "tenant_entity" (
                    "id" varchar PRIMARY KEY NOT NULL,
                    "name" varchar NOT NULL
                )
            `);

            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "key_entity" (
                    "tenantId" varchar NOT NULL,
                    "id" varchar NOT NULL,
                    "key" text,
                    "description" varchar,
                    "kmsProvider" varchar,
                    "externalKeyId" varchar,
                    "createdAt" ${timestampType} DEFAULT CURRENT_TIMESTAMP,
                    "updatedAt" ${timestampType} DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY ("tenantId", "id")
                )
            `);

            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "key_usage_entity" (
                    "tenantId" varchar NOT NULL,
                    "keyId" varchar NOT NULL,
                    "usage" varchar NOT NULL,
                    PRIMARY KEY ("tenantId", "keyId", "usage")
                )
            `);

            await queryRunner.release();
        }

        async function insertTestDataForFlatten(
            dataSource: DataSource,
        ): Promise<void> {
            const queryRunner = dataSource.createQueryRunner();

            await queryRunner.query(`
                INSERT INTO "tenant_entity" ("id", "name") VALUES ('test-tenant', 'Test Tenant')
            `);

            await queryRunner.query(`
                INSERT INTO "key_entity" ("tenantId", "id", "key", "description")
                VALUES 
                    ('test-tenant', 'key-1', 'dummy-key-1', 'Key with issuance usage'),
                    ('test-tenant', 'key-2', 'dummy-key-2', 'Key with attestation usage'),
                    ('test-tenant', 'key-3', 'dummy-key-3', 'Root CA key without usage')
            `);

            // key_usage_entity with usages (key-3 has no usage - it's a CA key)
            await queryRunner.query(`
                INSERT INTO "key_usage_entity" ("tenantId", "keyId", "usage")
                VALUES 
                    ('test-tenant', 'key-1', 'issuance'),
                    ('test-tenant', 'key-2', 'attestation')
            `);

            await queryRunner.release();
        }

        describe("SQLite", () => {
            let dataSource: DataSource;
            let tmpDir: string;

            beforeAll(async () => {
                tmpDir = mkdtempSync(
                    join(tmpdir(), "eudiplo-migration-flatten-test-"),
                );

                dataSource = new DataSource({
                    type: "better-sqlite3",
                    database: join(tmpDir, "test.db"),
                    synchronize: false,
                    logging: false,
                });

                await dataSource.initialize();
                await createSchemaAfterKeyUsageMigration(dataSource, "sqlite");
                await insertTestDataForFlatten(dataSource);
            }, 30_000);

            afterAll(async () => {
                await dataSource?.destroy();
                if (tmpDir) {
                    rmSync(tmpDir, { recursive: true, force: true });
                }
            });

            test("flattens key_usage_entity into key_entity.usageType", async () => {
                const migration = new FlattenKeyUsageType1746000000000();
                const queryRunner = dataSource.createQueryRunner();

                // Run the migration
                await migration.up(queryRunner);

                // Verify usageType column was added and populated
                const keys = await queryRunner.query(`
                    SELECT "id", "usageType" FROM "key_entity" ORDER BY "id"
                `);

                expect(keys).toHaveLength(3);
                expect(keys[0]).toEqual({ id: "key-1", usageType: "issuance" });
                expect(keys[1]).toEqual({
                    id: "key-2",
                    usageType: "attestation",
                });
                expect(keys[2]).toEqual({ id: "key-3", usageType: null }); // CA key has no usage

                // Verify key_usage_entity was dropped
                const tables = await queryRunner.query(`
                    SELECT name FROM sqlite_master WHERE type='table' AND name='key_usage_entity'
                `);
                expect(tables).toHaveLength(0);

                await queryRunner.release();
            });

            test("migration is idempotent", async () => {
                const migration = new FlattenKeyUsageType1746000000000();
                const queryRunner = dataSource.createQueryRunner();

                // Running again should not fail (usageType column already exists)
                await expect(migration.up(queryRunner)).resolves.not.toThrow();

                await queryRunner.release();
            });
        });

        describeWithContainers("PostgreSQL", () => {
            let dataSource: DataSource;
            let postgresContainer: StartedPostgreSqlContainer;

            beforeAll(async () => {
                postgresContainer = await new PostgreSqlContainer(
                    "postgres:alpine",
                )
                    .withUsername("test_user")
                    .withPassword("test_password")
                    .withDatabase("test_db")
                    .withExposedPorts(5432)
                    .start();

                dataSource = new DataSource({
                    type: "postgres",
                    host: postgresContainer.getHost(),
                    port: postgresContainer.getMappedPort(5432),
                    username: postgresContainer.getUsername(),
                    password: postgresContainer.getPassword(),
                    database: postgresContainer.getDatabase(),
                    synchronize: false,
                    logging: false,
                });

                await dataSource.initialize();
                await createSchemaAfterKeyUsageMigration(
                    dataSource,
                    "postgres",
                );
                await insertTestDataForFlatten(dataSource);
            }, 60_000);

            afterAll(async () => {
                await dataSource?.destroy();
                await postgresContainer?.stop();
            });

            test("flattens key_usage_entity into key_entity.usageType", async () => {
                const migration = new FlattenKeyUsageType1746000000000();
                const queryRunner = dataSource.createQueryRunner();

                // Run the migration
                await migration.up(queryRunner);

                // Verify usageType column was added and populated
                const keys = await queryRunner.query(`
                    SELECT "id", "usageType" FROM "key_entity" ORDER BY "id"
                `);

                expect(keys).toHaveLength(3);
                expect(keys[0]).toEqual({ id: "key-1", usageType: "issuance" });
                expect(keys[1]).toEqual({
                    id: "key-2",
                    usageType: "attestation",
                });
                expect(keys[2]).toEqual({ id: "key-3", usageType: null });

                // Verify key_usage_entity was dropped
                const tables = await queryRunner.query(`
                    SELECT tablename FROM pg_tables WHERE tablename = 'key_usage_entity'
                `);
                expect(tables).toHaveLength(0);

                await queryRunner.release();
            });

            test("migration is idempotent", async () => {
                const migration = new FlattenKeyUsageType1746000000000();
                const queryRunner = dataSource.createQueryRunner();

                await expect(migration.up(queryRunner)).resolves.not.toThrow();

                await queryRunner.release();
            });
        });
    });

    describe("MigrateKeysToKeyChain1747000000000", () => {
        /**
         * Creates the schema state AFTER FlattenKeyUsageType migration.
         * key_entity has usageType column, and we need key_chain table.
         */
        async function createSchemaForKeyChainMigration(
            dataSource: DataSource,
            dbType: "sqlite" | "postgres",
        ): Promise<void> {
            const queryRunner = dataSource.createQueryRunner();
            const timestampType =
                dbType === "sqlite" ? "datetime" : "timestamp";
            const boolType = dbType === "sqlite" ? "integer" : "boolean";
            const boolDefault = dbType === "sqlite" ? "0" : "false";

            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "tenant_entity" (
                    "id" varchar PRIMARY KEY NOT NULL,
                    "name" varchar NOT NULL
                )
            `);

            // key_entity with usageType (after FlattenKeyUsageType migration)
            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "key_entity" (
                    "tenantId" varchar NOT NULL,
                    "id" varchar NOT NULL,
                    "key" text,
                    "description" varchar,
                    "usageType" varchar,
                    "usage" varchar,
                    "kmsProvider" varchar,
                    "externalKeyId" varchar,
                    "signingCaKeyId" varchar,
                    "rotationEnabled" ${boolType} DEFAULT ${boolDefault},
                    "rotationIntervalDays" integer,
                    "certValidityDays" integer,
                    "lastRotatedAt" ${timestampType},
                    "createdAt" ${timestampType} DEFAULT CURRENT_TIMESTAMP,
                    "updatedAt" ${timestampType} DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY ("tenantId", "id")
                )
            `);

            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "cert_entity" (
                    "tenantId" varchar NOT NULL,
                    "id" varchar NOT NULL,
                    "keyId" varchar,
                    "crt" text,
                    "description" varchar,
                    "signingCaKeyId" varchar,
                    "createdAt" ${timestampType} DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY ("tenantId", "id")
                )
            `);

            // The new key_chain table (target of migration)
            await queryRunner.query(`
                CREATE TABLE IF NOT EXISTS "key_chain" (
                    "tenantId" varchar NOT NULL,
                    "id" varchar NOT NULL,
                    "description" varchar,
                    "usageType" varchar,
                    "usage" varchar,
                    "kmsProvider" varchar,
                    "externalKeyId" varchar,
                    "rootKey" text,
                    "rootCertificate" text,
                    "activeKey" text,
                    "activeCertificate" text,
                    "rotationEnabled" ${boolType} DEFAULT ${boolDefault},
                    "rotationIntervalDays" integer,
                    "certValidityDays" integer,
                    "lastRotatedAt" ${timestampType},
                    "previousKey" text,
                    "previousCertificate" text,
                    "previousKeyExpiry" ${timestampType},
                    "createdAt" ${timestampType} DEFAULT CURRENT_TIMESTAMP,
                    "updatedAt" ${timestampType} DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY ("tenantId", "id")
                )
            `);

            await queryRunner.release();
        }

        async function insertTestDataForKeyChain(
            dataSource: DataSource,
        ): Promise<void> {
            const queryRunner = dataSource.createQueryRunner();

            await queryRunner.query(`
                INSERT INTO "tenant_entity" ("id", "name") VALUES ('test-tenant', 'Test Tenant')
            `);

            // Root CA key (no usageType, will be skipped but used as reference)
            await queryRunner.query(`
                INSERT INTO "key_entity" ("tenantId", "id", "key", "description", "usageType", "usage", "kmsProvider")
                VALUES ('test-tenant', 'root-ca', 'root-ca-private-key', 'Root CA', NULL, 'sign', 'db')
            `);

            // Signing key (with CA)
            await queryRunner.query(`
                INSERT INTO "key_entity" ("tenantId", "id", "key", "description", "usageType", "usage", "kmsProvider", "signingCaKeyId")
                VALUES ('test-tenant', 'signing-key', 'signing-private-key', 'Signing Key', 'attestation', 'sign', 'db', 'root-ca')
            `);

            // Issuance key (self-signed, no CA)
            await queryRunner.query(`
                INSERT INTO "key_entity" ("tenantId", "id", "key", "description", "usageType", "usage", "kmsProvider")
                VALUES ('test-tenant', 'issuance-key', 'issuance-private-key', 'Issuance Key', 'issuance', 'sign', 'db')
            `);

            // Certificates
            await queryRunner.query(`
                INSERT INTO "cert_entity" ("tenantId", "id", "keyId", "crt", "description")
                VALUES 
                    ('test-tenant', 'root-ca-cert', 'root-ca', '["-----BEGIN CERTIFICATE-----\\nROOTCA\\n-----END CERTIFICATE-----"]', 'Root CA Cert'),
                    ('test-tenant', 'signing-cert', 'signing-key', '["-----BEGIN CERTIFICATE-----\\nSIGNING\\n-----END CERTIFICATE-----"]', 'Signing Cert'),
                    ('test-tenant', 'issuance-cert', 'issuance-key', '-----BEGIN CERTIFICATE-----\\nISSUANCE\\n-----END CERTIFICATE-----', 'Issuance Cert')
            `);

            await queryRunner.release();
        }

        describe("SQLite", () => {
            let dataSource: DataSource;
            let tmpDir: string;

            beforeAll(async () => {
                tmpDir = mkdtempSync(
                    join(tmpdir(), "eudiplo-migration-keychain-test-"),
                );

                dataSource = new DataSource({
                    type: "better-sqlite3",
                    database: join(tmpDir, "test.db"),
                    synchronize: false,
                    logging: false,
                });

                await dataSource.initialize();
                await createSchemaForKeyChainMigration(dataSource, "sqlite");
                await insertTestDataForKeyChain(dataSource);
            }, 30_000);

            afterAll(async () => {
                await dataSource?.destroy();
                if (tmpDir) {
                    rmSync(tmpDir, { recursive: true, force: true });
                }
            });

            test("migrates keys with usageType to key_chain", async () => {
                const migration = new MigrateKeysToKeyChain1747000000000();
                const queryRunner = dataSource.createQueryRunner();

                // Run the migration
                await migration.up(queryRunner);

                // Verify key_chain was populated (only keys with usageType)
                const keyChains = await queryRunner.query(`
                    SELECT "id", "usageType", "activeKey", "activeCertificate", "rootKey", "rootCertificate"
                    FROM "key_chain"
                    ORDER BY "id"
                `);

                expect(keyChains).toHaveLength(2); // signing-key and issuance-key (root-ca has no usageType)

                // Verify issuance key (self-signed, no CA)
                const issuanceKey = keyChains.find(
                    (k: { id: string }) => k.id === "issuance-key",
                );
                expect(issuanceKey).toBeDefined();
                expect(issuanceKey.usageType).toBe("issuance");
                expect(issuanceKey.activeKey).toBe("issuance-private-key");
                expect(issuanceKey.activeCertificate).toContain("ISSUANCE");
                expect(issuanceKey.rootKey).toBeNull();

                // Verify signing key (with CA)
                const signingKey = keyChains.find(
                    (k: { id: string }) => k.id === "signing-key",
                );
                expect(signingKey).toBeDefined();
                expect(signingKey.usageType).toBe("attestation");
                expect(signingKey.activeKey).toBe("signing-private-key");
                expect(signingKey.rootKey).toBe("root-ca-private-key");
                expect(signingKey.rootCertificate).toContain("ROOTCA");

                // Verify legacy tables were dropped
                const tables = await queryRunner.query(`
                    SELECT name FROM sqlite_master WHERE type='table' AND name IN ('key_entity', 'cert_entity')
                `);
                expect(tables).toHaveLength(0);

                await queryRunner.release();
            });
        });

        describeWithContainers("PostgreSQL", () => {
            let dataSource: DataSource;
            let postgresContainer: StartedPostgreSqlContainer;

            beforeAll(async () => {
                postgresContainer = await new PostgreSqlContainer(
                    "postgres:alpine",
                )
                    .withUsername("test_user")
                    .withPassword("test_password")
                    .withDatabase("test_db")
                    .withExposedPorts(5432)
                    .start();

                dataSource = new DataSource({
                    type: "postgres",
                    host: postgresContainer.getHost(),
                    port: postgresContainer.getMappedPort(5432),
                    username: postgresContainer.getUsername(),
                    password: postgresContainer.getPassword(),
                    database: postgresContainer.getDatabase(),
                    synchronize: false,
                    logging: false,
                });

                await dataSource.initialize();
                await createSchemaForKeyChainMigration(dataSource, "postgres");
                await insertTestDataForKeyChain(dataSource);
            }, 60_000);

            afterAll(async () => {
                await dataSource?.destroy();
                await postgresContainer?.stop();
            });

            test("migrates keys with usageType to key_chain", async () => {
                const migration = new MigrateKeysToKeyChain1747000000000();
                const queryRunner = dataSource.createQueryRunner();

                // Run the migration
                await migration.up(queryRunner);

                // Verify key_chain was populated
                const keyChains = await queryRunner.query(`
                    SELECT "id", "usageType", "activeKey", "activeCertificate", "rootKey", "rootCertificate"
                    FROM "key_chain"
                    ORDER BY "id"
                `);

                expect(keyChains).toHaveLength(2);

                // Verify issuance key
                const issuanceKey = keyChains.find(
                    (k: { id: string }) => k.id === "issuance-key",
                );
                expect(issuanceKey).toBeDefined();
                expect(issuanceKey.usageType).toBe("issuance");

                // Verify signing key
                const signingKey = keyChains.find(
                    (k: { id: string }) => k.id === "signing-key",
                );
                expect(signingKey).toBeDefined();
                expect(signingKey.usageType).toBe("attestation");
                expect(signingKey.rootKey).toBe("root-ca-private-key");

                // Verify legacy tables were dropped
                const tables = await queryRunner.query(`
                    SELECT tablename FROM pg_tables WHERE tablename IN ('key_entity', 'cert_entity')
                `);
                expect(tables).toHaveLength(0);

                await queryRunner.release();
            });
        });
    });

    /**
     * SQLite is covered by src/database/session-expiry-migration.spec.ts.
     * On PostgreSQL the type change must keep the stored values (TypeORM's
     * changeColumn would drop and re-add the column).
     */
    describe("ChangeSessionExpiresAtToTimestamp1784000000000", () => {
        describeWithContainers("PostgreSQL", () => {
            let dataSource: DataSource;
            let postgresContainer: StartedPostgreSqlContainer;
            let driftAfterSynchronize: string[];
            const sessionId = "00000000-0000-4000-8000-000000000001";

            const drift = async () =>
                (await dataSource.driver.createSchemaBuilder().log()).upQueries
                    .map((query) => query.query)
                    .sort();
            const columnType = async (table: string, column: string) =>
                (
                    await dataSource.query(
                        `SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
                        [table, column],
                    )
                )[0]?.data_type;

            beforeAll(async () => {
                const [
                    { Session },
                    { SessionLogEntry },
                    { TenantEntity },
                    { ClientEntity },
                    { IssuanceConfig },
                ] = await Promise.all([
                    import("../src/session/entities/session.entity.js"),
                    import(
                        "../src/session/entities/session-log-entry.entity.js"
                    ),
                    import("../src/auth/tenant/entities/tenant.entity.js"),
                    import("../src/auth/client/entities/client.entity.js"),
                    import(
                        "../src/issuer/configuration/issuance/entities/issuance-config.entity.js"
                    ),
                ]);
                postgresContainer = await new PostgreSqlContainer(
                    "postgres:alpine",
                ).start();
                dataSource = new DataSource({
                    type: "postgres",
                    url: postgresContainer.getConnectionUri(),
                    entities: [
                        Session,
                        SessionLogEntry,
                        TenantEntity,
                        ClientEntity,
                        IssuanceConfig,
                    ],
                    synchronize: true,
                    logging: false,
                });
                await dataSource.initialize();
                driftAfterSynchronize = await drift();

                // Recreate the schema before the migrations.
                const queryRunner = dataSource.createQueryRunner();
                await new ChangeSessionExpiresAtToTimestamp1784000000000().down(
                    queryRunner,
                );
                await new AddOfferLifetimeToIssuanceConfig1784100000000().down(
                    queryRunner,
                );
                await queryRunner.release();
                await dataSource.query(
                    `INSERT INTO "tenant_entity" ("id", "name") VALUES ('t', 't')`,
                );
                await dataSource.query(
                    `INSERT INTO "session" ("id", "tenantId", "expiresAt") VALUES ($1, 't', '2026-03-01')`,
                    [sessionId],
                );
                await dataSource.query(
                    `INSERT INTO "session_log_entry" ("sessionId", "level", "message") VALUES ($1, 'info', 'kept')`,
                    [sessionId],
                );
            }, 60_000);

            afterAll(async () => {
                await dataSource?.destroy();
                await postgresContainer?.stop();
            });

            test("starts from a date-only column without an offer lifetime", async () => {
                expect(await columnType("session", "expiresAt")).toBe("date");
                expect(
                    await columnType("issuance_config", "offerLifetimeSeconds"),
                ).toBeUndefined();
            });

            test("converts stored dates to midnight timestamps in place", async () => {
                const queryRunner = dataSource.createQueryRunner();
                await new ChangeSessionExpiresAtToTimestamp1784000000000().up(
                    queryRunner,
                );
                await new AddOfferLifetimeToIssuanceConfig1784100000000().up(
                    queryRunner,
                );
                await queryRunner.release();

                expect(await columnType("session", "expiresAt")).toBe(
                    "timestamp without time zone",
                );
                expect(
                    await columnType("issuance_config", "offerLifetimeSeconds"),
                ).toBe("integer");
                await expect(
                    dataSource.query(
                        `SELECT "expiresAt"::text AS "expiresAt" FROM "session" WHERE "id" = $1`,
                        [sessionId],
                    ),
                ).resolves.toEqual([{ expiresAt: "2026-03-01 00:00:00" }]);
                await expect(
                    dataSource.query(
                        `SELECT "message" FROM "session_log_entry"`,
                    ),
                ).resolves.toEqual([{ message: "kept" }]);
                expect(await drift()).toEqual(driftAfterSynchronize);
            });

            test("is idempotent and keeps the time of day", async () => {
                const queryRunner = dataSource.createQueryRunner();
                await new ChangeSessionExpiresAtToTimestamp1784000000000().up(
                    queryRunner,
                );
                await new AddOfferLifetimeToIssuanceConfig1784100000000().up(
                    queryRunner,
                );
                await queryRunner.release();
                expect(await drift()).toEqual(driftAfterSynchronize);

                const { Session } = await import(
                    "../src/session/entities/session.entity.js"
                );
                const later = new Date("2026-03-01T10:15:30.250Z");
                await dataSource
                    .getRepository(Session)
                    .update(sessionId, { expiresAt: later });
                expect(
                    (
                        await dataSource
                            .getRepository(Session)
                            .findOneByOrFail({ id: sessionId })
                    ).expiresAt,
                ).toEqual(later);
            });
        });
    });

    describe("AddSessionListFilters1784300000000", () => {
        describeWithContainers("PostgreSQL", () => {
            let dataSource: DataSource;
            let postgresContainer: StartedPostgreSqlContainer;
            let driftAfterSynchronize: string[];
            const sessionId = "00000000-0000-4000-8000-000000000001";

            const drift = async () =>
                (await dataSource.driver.createSchemaBuilder().log()).upQueries
                    .map((query) => query.query)
                    .sort();
            const indexes = async () =>
                (
                    await dataSource.query(
                        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'session' AND indexname LIKE 'IDX_session_%' ORDER BY indexname`,
                    )
                ).map(
                    (row: { indexname: string; indexdef: string }) =>
                        `${row.indexname}: ${row.indexdef.replace(/^.* USING btree /, "")}`,
                );

            beforeAll(async () => {
                const [
                    { Session },
                    { SessionLogEntry },
                    { TenantEntity },
                    { ClientEntity },
                ] = await Promise.all([
                    import("../src/session/entities/session.entity.js"),
                    import(
                        "../src/session/entities/session-log-entry.entity.js"
                    ),
                    import("../src/auth/tenant/entities/tenant.entity.js"),
                    import("../src/auth/client/entities/client.entity.js"),
                ]);
                postgresContainer = await new PostgreSqlContainer(
                    "postgres:alpine",
                ).start();
                dataSource = new DataSource({
                    type: "postgres",
                    url: postgresContainer.getConnectionUri(),
                    entities: [
                        Session,
                        SessionLogEntry,
                        TenantEntity,
                        ClientEntity,
                    ],
                    synchronize: true,
                    logging: false,
                });
                await dataSource.initialize();
                driftAfterSynchronize = await drift();

                // Recreate the schema before the migration.
                const queryRunner = dataSource.createQueryRunner();
                await new AddSessionListFilters1784300000000().down(
                    queryRunner,
                );
                await queryRunner.release();
                await dataSource.query(
                    `INSERT INTO "tenant_entity" ("id", "name") VALUES ('t', 't')`,
                );
                await dataSource.query(
                    `INSERT INTO "session" ("id", "tenantId", "requestId") VALUES ($1, 't', 'age-check')`,
                    [sessionId],
                );
            }, 60_000);

            afterAll(async () => {
                await dataSource?.destroy();
                await postgresContainer?.stop();
            });

            test("adds the columns and indexes, keeps the rows and is idempotent", async () => {
                expect(await indexes()).toEqual([]);
                const queryRunner = dataSource.createQueryRunner();
                await new AddSessionListFilters1784300000000().up(queryRunner);
                await new AddSessionListFilters1784300000000().up(queryRunner);
                await queryRunner.release();

                expect(await indexes()).toEqual([
                    'IDX_session_tenant_created_at: ("tenantId", "createdAt")',
                    'IDX_session_tenant_reference: ("tenantId", reference)',
                    'IDX_session_tenant_request_id: ("tenantId", "requestId")',
                    'IDX_session_tenant_status: ("tenantId", status)',
                    'IDX_session_tenant_updated_at: ("tenantId", "updatedAt")',
                    'IDX_session_wallet_nonce: ("walletNonce")',
                ]);
                await expect(
                    dataSource.query(
                        `SELECT "requestId", "reference", "credentialConfigurationIds" FROM "session" WHERE "id" = $1`,
                        [sessionId],
                    ),
                ).resolves.toEqual([
                    {
                        requestId: "age-check",
                        reference: null,
                        credentialConfigurationIds: null,
                    },
                ]);
                expect(await drift()).toEqual(driftAfterSynchronize);
            });
        });
    });

    describe("AddOauthBindingsToSession1782000000000 and ChangeSessionOauthBindingsToTimestamp1784400000000", () => {
        describeWithContainers("PostgreSQL", () => {
            let dataSource: DataSource;
            let postgresContainer: StartedPostgreSqlContainer;
            let driftAfterSynchronize: string[];
            const sessionId = "00000000-0000-4000-8000-000000000001";
            const columns = [
                "request_uri_expires_at",
                "authorization_code_expires_at",
            ];

            const drift = async () =>
                (await dataSource.driver.createSchemaBuilder().log()).upQueries
                    .map((query) => query.query)
                    .sort();
            const columnTypes = async () =>
                Promise.all(
                    columns.map(
                        async (column) =>
                            (
                                await dataSource.query(
                                    `SELECT data_type FROM information_schema.columns WHERE table_name = 'session' AND column_name = $1`,
                                    [column],
                                )
                            )[0]?.data_type,
                    ),
                );
            const run = async (...migrations: MigrationInterface[]) => {
                const queryRunner = dataSource.createQueryRunner();
                for (const migration of migrations) {
                    await migration.up(queryRunner);
                }
                await queryRunner.release();
            };

            beforeAll(async () => {
                const [
                    { Session },
                    { SessionLogEntry },
                    { TenantEntity },
                    { ClientEntity },
                ] = await Promise.all([
                    import("../src/session/entities/session.entity.js"),
                    import(
                        "../src/session/entities/session-log-entry.entity.js"
                    ),
                    import("../src/auth/tenant/entities/tenant.entity.js"),
                    import("../src/auth/client/entities/client.entity.js"),
                ]);
                postgresContainer = await new PostgreSqlContainer(
                    "postgres:alpine",
                ).start();
                dataSource = new DataSource({
                    type: "postgres",
                    url: postgresContainer.getConnectionUri(),
                    entities: [
                        Session,
                        SessionLogEntry,
                        TenantEntity,
                        ClientEntity,
                    ],
                    synchronize: true,
                    logging: false,
                });
                await dataSource.initialize();
                driftAfterSynchronize = await drift();

                // Recreate the schema before the migrations.
                const queryRunner = dataSource.createQueryRunner();
                await new AddOauthBindingsToSession1782000000000().down(
                    queryRunner,
                );
                await queryRunner.release();
                await dataSource.query(
                    `INSERT INTO "tenant_entity" ("id", "name") VALUES ('t', 't')`,
                );
                await dataSource.query(
                    `INSERT INTO "session" ("id", "tenantId") VALUES ($1, 't')`,
                    [sessionId],
                );
            }, 60_000);

            afterAll(async () => {
                await dataSource?.destroy();
                await postgresContainer?.stop();
            });

            test("adds the expiry columns with the entity's type", async () => {
                expect(await columnTypes()).toEqual([undefined, undefined]);
                await run(new AddOauthBindingsToSession1782000000000());

                expect(await columnTypes()).toEqual([
                    "timestamp without time zone",
                    "timestamp without time zone",
                ]);
                expect(await drift()).toEqual(driftAfterSynchronize);
            });

            test("converts columns created with a time zone and keeps their instants", async () => {
                for (const column of columns) {
                    await dataSource.query(
                        `ALTER TABLE "session" ALTER COLUMN "${column}" TYPE timestamp with time zone`,
                    );
                }
                await dataSource.query(
                    `UPDATE "session" SET "request_uri_expires_at" = '2026-03-01T10:15:30.250Z', "authorization_code_expires_at" = '2026-03-01T10:16:00Z' WHERE "id" = $1`,
                    [sessionId],
                );

                await run(
                    new ChangeSessionOauthBindingsToTimestamp1784400000000(),
                    new ChangeSessionOauthBindingsToTimestamp1784400000000(),
                );

                expect(await columnTypes()).toEqual([
                    "timestamp without time zone",
                    "timestamp without time zone",
                ]);
                expect(await drift()).toEqual(driftAfterSynchronize);
                const { Session } = await import(
                    "../src/session/entities/session.entity.js"
                );
                const session = await dataSource
                    .getRepository(Session)
                    .findOneByOrFail({ id: sessionId });
                expect(session.request_uri_expires_at).toEqual(
                    new Date("2026-03-01T10:15:30.250Z"),
                );
                expect(session.authorization_code_expires_at).toEqual(
                    new Date("2026-03-01T10:16:00Z"),
                );
            });
        });
    });

    // The same contract runs on SQLite in the unit tests.
    describeWithContainers("RedactAuditLogSecrets on PostgreSQL", () => {
        let postgresContainer: StartedPostgreSqlContainer;

        beforeAll(async () => {
            postgresContainer = await new PostgreSqlContainer(
                "postgres:alpine",
            ).start();
        }, 60_000);

        afterAll(async () => {
            await postgresContainer?.stop();
        });

        redactAuditLogSecretsContract(() =>
            new DataSource({
                type: "postgres",
                url: postgresContainer.getConnectionUri(),
                entities: redactAuditLogSecretsEntities,
                synchronize: true,
                dropSchema: true,
            }).initialize(),
        );
    });
});
