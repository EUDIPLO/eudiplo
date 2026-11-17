import {
    type MigrationInterface,
    type QueryRunner,
    Table,
    TableForeignKey,
    TableIndex,
} from "typeorm";

/**
 * Tables of the OpenID Provider:
 *
 * - `oidc_client`: relying parties per tenant, with hashed secrets and the
 *   scopes that map to presentation configs.
 * - `oidc_sign_in`: sign-ins from the pushed authorization request to the ID
 *   token; rows are deleted after they expire.
 *
 * Both are new; nothing existing changes.
 */
export class AddOidcProvider1786400000000 implements MigrationInterface {
    name = "AddOidcProvider1786400000000";

    async up(queryRunner: QueryRunner): Promise<void> {
        // Fresh install: the tenant table does not exist yet, and the
        // baseline creates the schema from the entities.
        if (!(await queryRunner.hasTable("tenant_entity"))) return;

        const isPostgres = queryRunner.connection.options.type === "postgres";
        // The types TypeORM derives from the entities, so an upgraded
        // database matches a fresh install.
        const timestamp = isPostgres ? "timestamp" : "datetime";
        const now = isPostgres ? "now()" : "datetime('now')";
        const json = "json";
        const tenantForeignKey = () =>
            new TableForeignKey({
                columnNames: ["tenantId"],
                referencedTableName: "tenant_entity",
                referencedColumnNames: ["id"],
                onDelete: "CASCADE",
                onUpdate: "NO ACTION",
            });

        if (!(await queryRunner.hasTable("oidc_client"))) {
            await queryRunner.createTable(
                new Table({
                    name: "oidc_client",
                    columns: [
                        { name: "id", type: "varchar", isPrimary: true },
                        { name: "tenantId", type: "varchar", isPrimary: true },
                        { name: "name", type: "varchar" },
                        { name: "redirectUris", type: json },
                        { name: "profile", type: "varchar" },
                        { name: "scopes", type: json },
                        { name: "secrets", type: json },
                        {
                            name: "secretLastUsed",
                            type: json,
                            isNullable: true,
                        },
                        { name: "createdAt", type: timestamp, default: now },
                        { name: "updatedAt", type: timestamp, default: now },
                    ],
                    foreignKeys: [tenantForeignKey()],
                }),
                true,
            );
            console.log("[Migration] Created oidc_client table.");
        }

        if (!(await queryRunner.hasTable("oidc_sign_in"))) {
            await queryRunner.createTable(
                new Table({
                    name: "oidc_sign_in",
                    columns: [
                        { name: "id", type: "varchar", isPrimary: true },
                        { name: "tenantId", type: "varchar" },
                        { name: "clientId", type: "varchar" },
                        { name: "redirectUri", type: "varchar" },
                        { name: "state", type: "varchar", isNullable: true },
                        { name: "nonce", type: "varchar", isNullable: true },
                        { name: "scope", type: "varchar" },
                        { name: "presentationConfigId", type: "varchar" },
                        { name: "codeChallenge", type: "varchar" },
                        {
                            name: "requireSameDevice",
                            type: "boolean",
                            default: isPostgres ? false : 0,
                        },
                        { name: "status", type: "varchar" },
                        {
                            name: "browserBindingHash",
                            type: "varchar",
                            isNullable: true,
                        },
                        {
                            name: "presentationSessionId",
                            type: "varchar",
                            isNullable: true,
                        },
                        {
                            name: "sameDeviceRequest",
                            type: "text",
                            isNullable: true,
                        },
                        {
                            name: "crossDeviceRequest",
                            type: "text",
                            isNullable: true,
                        },
                        {
                            name: "walletReturnedElsewhere",
                            type: "boolean",
                            default: isPostgres ? false : 0,
                        },
                        { name: "codeHash", type: "varchar", isNullable: true },
                        {
                            name: "codeExpiresAt",
                            type: timestamp,
                            isNullable: true,
                        },
                        { name: "acr", type: "varchar", isNullable: true },
                        { name: "authTime", type: timestamp, isNullable: true },
                        { name: "expiresAt", type: timestamp },
                        { name: "createdAt", type: timestamp, default: now },
                    ],
                    foreignKeys: [tenantForeignKey()],
                    indices: [
                        new TableIndex({
                            name: "IDX_oidc_sign_in_code",
                            columnNames: ["tenantId", "codeHash"],
                        }),
                        new TableIndex({
                            name: "IDX_oidc_sign_in_expires",
                            columnNames: ["expiresAt"],
                        }),
                    ],
                }),
                true,
            );
            console.log("[Migration] Created oidc_sign_in table.");
        }
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable("oidc_sign_in")) {
            await queryRunner.dropTable("oidc_sign_in");
        }
        if (await queryRunner.hasTable("oidc_client")) {
            await queryRunner.dropTable("oidc_client");
        }
    }
}
