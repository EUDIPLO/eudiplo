import type { DataSource } from "typeorm";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { ClientEntity } from "../../src/auth/client/entities/client.entity.js";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { EncryptStoredSecrets1784500000000 } from "../../src/database/migrations/1784500000000-EncryptStoredSecrets.js";
import { AttributeProviderEntity } from "../../src/issuer/configuration/attribute-provider/entities/attribute-provider.entity.js";
import { IssuanceConfig } from "../../src/issuer/configuration/issuance/entities/issuance-config.entity.js";
import { WebhookEndpointEntity } from "../../src/issuer/configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import { hashRefreshToken } from "../../src/issuer/issuance/oid4vci/authorization/domain/token-grant-rules.js";
import { ChainedAsSessionEntity } from "../../src/issuer/issuance/oid4vci/authorization/shared/entities/chained-as-session.entity.js";
import { RegistrarConfigEntity } from "../../src/registrar/entities/registrar-config.entity.js";
import { Session } from "../../src/session/entities/session.entity.js";
import { initializeTestEncryption } from "./test-encryption.js";

export const encryptStoredSecretsEntities = [
    TenantEntity,
    ClientEntity,
    RegistrarConfigEntity,
    WebhookEndpointEntity,
    AttributeProviderEntity,
    IssuanceConfig,
    Session,
    ChainedAsSessionEntity,
];

const SESSION_ID = "3f2a0000-0000-4000-8000-000000000001";
const CHAINED_ID = "3f2a0000-0000-4000-8000-000000000002";
const apiKeyAuth = (value: string) => ({
    type: "apiKey",
    config: { headerName: "X-Key", value },
});
const servers = [
    { type: "built-in", id: "built-in" },
    {
        type: "chained",
        id: "chained",
        upstream: {
            issuer: "https://idp.example",
            clientId: "c",
            clientSecret: "upstream-secret",
        },
    },
];
const claims = { sub: "user-1", given_name: "Erika" };

/**
 * EncryptStoredSecrets1784500000000 against a database that `createDb`
 * creates empty, with the schema of `encryptStoredSecretsEntities`.
 */
export function encryptStoredSecretsContract(
    createDb: () => Promise<DataSource>,
) {
    describe("EncryptStoredSecrets1784500000000", () => {
        let db: DataSource;

        beforeAll(initializeTestEncryption);

        afterEach(async () => {
            if (db?.isInitialized) await db.destroy();
        });

        const postgres = () => db.options.type === "postgres";
        const parameter = (index: number) => (postgres() ? `$${index}` : "?");

        /** Stored column value; SQLite returns the text of json columns. */
        async function raw(table: string, column: string): Promise<unknown> {
            const [row] = await db.query(
                `SELECT "${column}" AS value FROM "${table}"`,
            );
            return row.value;
        }

        async function rawJson(table: string, column: string): Promise<any> {
            const value = await raw(table, column);
            return postgres() ? value : JSON.parse(value as string);
        }

        /** Rows as an 8.x backend stored them: secrets and tokens in plaintext. */
        async function insertPlaintextRows() {
            await db.query(
                `INSERT INTO "tenant_entity" ("id", "name") VALUES ('t', 't')`,
            );
            await db.query(
                `INSERT INTO "registrar_config_entity" ("tenantId", "registrarUrl", "oidcUrl", "clientId", "clientSecret", "username", "password") VALUES ('t', 'https://registrar.example', 'https://auth.example', 'c', 'client-secret', 'u', 'pass:word:1')`,
            );
            for (const table of [
                "webhook_endpoint_entity",
                "attribute_provider_entity",
            ]) {
                await db.query(
                    `INSERT INTO "${table}" ("id", "tenantId", "name", "url", "auth") VALUES ('e', 't', 'n', 'https://endpoint.example', ${parameter(1)})`,
                    [JSON.stringify(apiKeyAuth("api-key"))],
                );
            }
            await db.query(
                `INSERT INTO "issuance_config" ("tenantId", "authorizationServers") VALUES ('t', ${parameter(1)})`,
                [JSON.stringify(servers)],
            );
            await db.query(
                `INSERT INTO "session" ("id", "tenantId", "parsedWebhook", "refresh_token") VALUES (${parameter(1)}, 't', ${parameter(2)}, 'session-refresh')`,
                [
                    SESSION_ID,
                    JSON.stringify({
                        url: "https://hook.example",
                        auth: apiKeyAuth("hook-key"),
                    }),
                ],
            );
            await db.query(
                `INSERT INTO "chained_as_session" ("id", "tenantId", "issuerState", "clientId", "redirectUri", "expiresAt", "upstreamIdTokenClaims", "upstreamAccessTokenClaims", "refreshToken") VALUES (${parameter(1)}, 't', 's', 'c', 'https://wallet.example', '2026-01-01 00:00:00', ${parameter(2)}, ${parameter(3)}, 'chained-refresh')`,
                [
                    CHAINED_ID,
                    JSON.stringify(claims),
                    JSON.stringify({ scope: "openid" }),
                ],
            );
        }

        async function run(direction: "up" | "down") {
            const queryRunner = db.createQueryRunner();
            try {
                await new EncryptStoredSecrets1784500000000()[direction](
                    queryRunner,
                );
            } finally {
                await queryRunner.release();
            }
        }

        async function migratedDatabase() {
            db = await createDb();
            await insertPlaintextRows();
            await run("up");
        }

        test("encrypts stored secrets so that entities read the original values", async () => {
            await migratedDatabase();

            // Looks like ciphertext (`a:b:c`), but is encrypted all the same.
            expect(await raw("registrar_config_entity", "password")).not.toBe(
                "pass:word:1",
            );
            expect(
                await db
                    .getRepository(RegistrarConfigEntity)
                    .findOneByOrFail({ tenantId: "t" }),
            ).toMatchObject({
                password: "pass:word:1",
                clientSecret: "client-secret",
            });

            for (const entity of [
                WebhookEndpointEntity,
                AttributeProviderEntity,
            ]) {
                const table = db.getRepository(entity).metadata.tableName;
                const stored = await rawJson(table, "auth");
                expect(stored.config.headerName).toBe("X-Key");
                expect(stored.config.value).not.toBe("api-key");
                expect(
                    (
                        await db
                            .getRepository(entity)
                            .findOneByOrFail({ id: "e" })
                    ).auth,
                ).toEqual(apiKeyAuth("api-key"));
            }

            const storedServers = await rawJson(
                "issuance_config",
                "authorizationServers",
            );
            expect(storedServers[1].upstream.clientId).toBe("c");
            expect(storedServers[1].upstream.clientSecret).not.toBe(
                "upstream-secret",
            );
            expect(
                (
                    await db
                        .getRepository(IssuanceConfig)
                        .findOneByOrFail({ tenantId: "t" })
                ).authorizationServers,
            ).toEqual(servers);

            expect(
                (await rawJson("session", "parsedWebhook")).auth.config.value,
            ).not.toBe("hook-key");
            expect(
                (
                    await db
                        .getRepository(Session)
                        .findOneByOrFail({ id: SESSION_ID })
                ).parsedWebhook?.auth,
            ).toEqual(apiKeyAuth("hook-key"));

            expect(
                JSON.stringify(
                    await raw("chained_as_session", "upstreamIdTokenClaims"),
                ),
            ).not.toContain("Erika");
            expect(
                await db
                    .getRepository(ChainedAsSessionEntity)
                    .findOneByOrFail({ id: CHAINED_ID }),
            ).toMatchObject({
                upstreamIdTokenClaims: claims,
                upstreamAccessTokenClaims: { scope: "openid" },
            });
        });

        test("replaces stored refresh tokens by their hash", async () => {
            await migratedDatabase();

            expect(await raw("session", "refresh_token")).toBe(
                hashRefreshToken("session-refresh"),
            );
            expect(await raw("chained_as_session", "refreshToken")).toBe(
                hashRefreshToken("chained-refresh"),
            );
        });

        test("leaves values that are already encrypted unchanged", async () => {
            await migratedDatabase();
            const password = await raw("registrar_config_entity", "password");
            const auth = await rawJson("webhook_endpoint_entity", "auth");

            await run("up");

            expect(await raw("registrar_config_entity", "password")).toBe(
                password,
            );
            expect(await rawJson("webhook_endpoint_entity", "auth")).toEqual(
                auth,
            );
        });

        test("down restores the plaintext secrets", async () => {
            await migratedDatabase();

            await run("down");

            expect(await raw("registrar_config_entity", "password")).toBe(
                "pass:word:1",
            );
            expect(await rawJson("webhook_endpoint_entity", "auth")).toEqual(
                apiKeyAuth("api-key"),
            );
            expect(
                await rawJson("issuance_config", "authorizationServers"),
            ).toEqual(servers);
            expect(
                await rawJson("chained_as_session", "upstreamIdTokenClaims"),
            ).toEqual(claims);
        });
    });
}
