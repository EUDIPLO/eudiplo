import type { DataSource } from "typeorm";
import { afterEach, describe, expect, test } from "vitest";
import { ClientEntity } from "../../src/auth/client/entities/client.entity.js";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { HashAuthorizationCodes1784700000000 } from "../../src/database/migrations/1784700000000-HashAuthorizationCodes.js";
import { hashAuthorizationCode } from "../../src/issuer/issuance/oid4vci/authorization/domain/token-grant-rules.js";
import { ChainedAsSessionEntity } from "../../src/issuer/issuance/oid4vci/authorization/shared/entities/chained-as-session.entity.js";
import { InteractiveAuthSessionEntity } from "../../src/issuer/issuance/oid4vci/entities/interactive-auth-session.entity.js";
import { Session } from "../../src/session/entities/session.entity.js";

export const hashAuthorizationCodesEntities = [
    TenantEntity,
    ClientEntity,
    Session,
    ChainedAsSessionEntity,
    InteractiveAuthSessionEntity,
];

const SESSION_ID = "3f2a0000-0000-4000-8000-000000000001";
const OTHER_SESSION_ID = "3f2a0000-0000-4000-8000-000000000002";
const CHAINED_ID = "3f2a0000-0000-4000-8000-000000000003";
const INTERACTIVE_ID = "3f2a0000-0000-4000-8000-000000000004";

/**
 * HashAuthorizationCodes1784700000000 against a database that `createDb`
 * creates empty, with the schema of `hashAuthorizationCodesEntities`.
 */
export function hashAuthorizationCodesContract(
    createDb: () => Promise<DataSource>,
) {
    describe("HashAuthorizationCodes1784700000000", () => {
        let db: DataSource;

        afterEach(async () => {
            if (db?.isInitialized) await db.destroy();
        });

        const parameter = (index: number) =>
            db.options.type === "postgres" ? `$${index}` : "?";

        async function raw(table: string, column: string, id: string) {
            const [row] = await db.query(
                `SELECT "${column}" AS value FROM "${table}" WHERE "id" = ${parameter(1)}`,
                [id],
            );
            return row.value as string | null;
        }

        test("replaces stored codes by their hash and leaves sessions without one alone", async () => {
            db = await createDb();
            await db.query(
                `INSERT INTO "tenant_entity" ("id", "name") VALUES ('t', 't')`,
            );
            await db.query(
                `INSERT INTO "session" ("id", "tenantId", "authorization_code") VALUES (${parameter(1)}, 't', 'pre-auth-code')`,
                [SESSION_ID],
            );
            await db.query(
                `INSERT INTO "session" ("id", "tenantId") VALUES (${parameter(1)}, 't')`,
                [OTHER_SESSION_ID],
            );
            await db.query(
                `INSERT INTO "chained_as_session" ("id", "tenantId", "issuerState", "clientId", "redirectUri", "expiresAt", "authorizationCode") VALUES (${parameter(1)}, 't', 's', 'c', 'https://wallet.example', '2026-01-01 00:00:00', 'chained-code')`,
                [CHAINED_ID],
            );
            await db.query(
                `INSERT INTO "interactive_auth_session" ("id", "authSession", "tenantId", "clientId", "interactionTypesSupported", "expiresAt", "authorizationCode") VALUES (${parameter(1)}, ${parameter(2)}, 't', 'c', 'openid4vp_presentation', '2026-01-01 00:00:00', 'interactive-code')`,
                [INTERACTIVE_ID, INTERACTIVE_ID],
            );

            const queryRunner = db.createQueryRunner();
            try {
                await new HashAuthorizationCodes1784700000000().up(queryRunner);
            } finally {
                await queryRunner.release();
            }

            expect(await raw("session", "authorization_code", SESSION_ID)).toBe(
                hashAuthorizationCode("pre-auth-code"),
            );
            expect(
                await raw("session", "authorization_code", OTHER_SESSION_ID),
            ).toBeNull();
            expect(
                await raw(
                    "chained_as_session",
                    "authorizationCode",
                    CHAINED_ID,
                ),
            ).toBe(hashAuthorizationCode("chained-code"));
            expect(
                await raw(
                    "interactive_auth_session",
                    "authorizationCode",
                    INTERACTIVE_ID,
                ),
            ).toBe(hashAuthorizationCode("interactive-code"));
        });
    });
}
