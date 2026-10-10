import { createHash } from "node:crypto";
import { MigrationInterface, QueryRunner } from "typeorm";
import type { DataEncryptionService } from "../../platform/data-encryption/data-encryption.service.js";
import {
    getEncryptionService,
    mapJsonPath,
} from "../../platform/data-encryption/encrypted-column.transformer.js";

interface StoredColumn {
    table: string;
    primaryKey: string[];
    column: string;
    json: boolean;
    /** Value to store after `up`, given the stored value. */
    up(value: unknown): unknown;
    /** Value to store after `down`, given the stored value. */
    down(value: unknown): unknown;
}

/**
 * Whether `value` is ciphertext of the current key. AES-GCM authenticates the
 * ciphertext, so plaintext that happens to look like `iv:tag:data` fails.
 */
function isCiphertext(service: DataEncryptionService, value: string): boolean {
    if (!service.isEncrypted(value)) return false;
    try {
        service.decrypt(value);
        return true;
    } catch {
        return false;
    }
}

/**
 * The encryption service is looked up only when a value is converted, so a
 * database without stored secrets also migrates through the TypeORM CLI,
 * which does not load the encryption key.
 */
function encryption(): DataEncryptionService {
    try {
        return getEncryptionService();
    } catch {
        throw new Error(
            "EncryptStoredSecrets1784500000000 encrypts stored secrets and needs the data-at-rest encryption key. Run the migrations by starting the backend with DB_MIGRATIONS_RUN=true.",
        );
    }
}

function encryptString(value: string): string {
    const service = encryption();
    return isCiphertext(service, value) ? value : service.encrypt(value);
}

function decryptString(value: string): string {
    const service = encryption();
    return isCiphertext(service, value) ? service.decrypt(value) : value;
}

/** A column whose whole string value is a secret. */
function stringColumn(
    table: string,
    primaryKey: string[],
    column: string,
): StoredColumn {
    return {
        table,
        primaryKey,
        column,
        json: false,
        up: (value) => encryptString(value as string),
        down: (value) => decryptString(value as string),
    };
}

/** A JSON column with secret strings at `path`. */
function jsonPathColumn(
    table: string,
    primaryKey: string[],
    column: string,
    path: string,
): StoredColumn {
    return {
        table,
        primaryKey,
        column,
        json: true,
        up: (value) => mapJsonPath(value, path, encryptString),
        down: (value) => mapJsonPath(value, path, decryptString),
    };
}

/** A JSON column encrypted as a whole; the ciphertext is a JSON string. */
function encryptedJsonColumn(
    table: string,
    primaryKey: string[],
    column: string,
): StoredColumn {
    return {
        table,
        primaryKey,
        column,
        json: true,
        up: (value) =>
            typeof value === "string" ? value : encryption().encryptJson(value),
        down: (value) =>
            typeof value === "string" && isCiphertext(encryption(), value)
                ? encryption().decryptJson(value)
                : value,
    };
}

/** A refresh token column; the token is replaced by its hash. */
function refreshTokenColumn(
    table: string,
    primaryKey: string[],
    column: string,
): StoredColumn {
    return {
        table,
        primaryKey,
        column,
        json: false,
        // Same as hashRefreshToken, kept here so the migration does not change.
        up: (value) =>
            createHash("sha256")
                .update(value as string)
                .digest("base64url"),
        // A hash cannot be turned back into the token. After a revert, the
        // affected refresh tokens are rejected and wallets authorize again.
        down: (value) => value,
    };
}

const COLUMNS: StoredColumn[] = [
    stringColumn("registrar_config_entity", ["tenantId"], "password"),
    stringColumn("registrar_config_entity", ["tenantId"], "clientSecret"),
    jsonPathColumn(
        "webhook_endpoint_entity",
        ["id", "tenantId"],
        "auth",
        "config.value",
    ),
    jsonPathColumn(
        "attribute_provider_entity",
        ["id", "tenantId"],
        "auth",
        "config.value",
    ),
    jsonPathColumn(
        "issuance_config",
        ["tenantId"],
        "authorizationServers",
        "*.upstream.clientSecret",
    ),
    jsonPathColumn("session", ["id"], "parsedWebhook", "auth.config.value"),
    encryptedJsonColumn("chained_as_session", ["id"], "upstreamIdTokenClaims"),
    encryptedJsonColumn(
        "chained_as_session",
        ["id"],
        "upstreamAccessTokenClaims",
    ),
    refreshTokenColumn("session", ["id"], "refresh_token"),
    refreshTokenColumn("chained_as_session", ["id"], "refreshToken"),
];

/**
 * Encrypt the secrets that earlier versions stored in plaintext with the
 * data-at-rest key (`ENCRYPTION_KEY_SOURCE`), and replace stored refresh
 * tokens by their SHA-256 hash:
 *
 * - registrar client secret and password,
 * - API keys of webhook endpoints, attribute providers and session webhooks,
 * - upstream OIDC client secrets of chained authorization servers,
 * - upstream ID and access token claims of chained authorization sessions,
 * - refresh tokens of the built-in and chained authorization servers.
 *
 * Values that already decrypt with the current key are left unchanged, so
 * rows written by this version before the migration ran are not encrypted
 * twice. Refresh tokens issued before the migration remain valid, because
 * the token endpoint looks them up by hash.
 */
export class EncryptStoredSecrets1784500000000 implements MigrationInterface {
    name = "EncryptStoredSecrets1784500000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const column of COLUMNS) {
            await this.convert(queryRunner, column, column.up);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const column of COLUMNS) {
            await this.convert(queryRunner, column, column.down);
        }
    }

    private async convert(
        queryRunner: QueryRunner,
        column: StoredColumn,
        convert: (value: unknown) => unknown,
    ): Promise<void> {
        const table = await queryRunner.getTable(column.table);
        if (!table?.findColumnByName(column.column)) return;

        const postgres = queryRunner.connection.options.type === "postgres";
        const { driver } = queryRunner.connection;
        const tablePath = this.tablePath(queryRunner, table.name);
        const name = driver.escape(column.column);
        const keys = column.primaryKey.map((key) => driver.escape(key));
        const parameter = (index: number) => (postgres ? `$${index}` : "?");

        const rows: Record<string, unknown>[] = await queryRunner.query(
            `SELECT ${[...keys, name].join(", ")} FROM ${tablePath} WHERE ${name} IS NOT NULL`,
        );
        let converted = 0;
        for (const row of rows) {
            const stored = row[column.column];
            // node-postgres parses json columns, SQLite returns their text.
            const value =
                column.json && !postgres
                    ? JSON.parse(stored as string)
                    : stored;
            const next = convert(value);
            if (JSON.stringify(next) === JSON.stringify(value)) continue;

            await queryRunner.query(
                `UPDATE ${tablePath} SET ${name} = ${parameter(1)} WHERE ${keys
                    .map((key, index) => `${key} = ${parameter(index + 2)}`)
                    .join(" AND ")}`,
                [
                    column.json ? JSON.stringify(next) : next,
                    ...column.primaryKey.map((key) => row[key]),
                ],
            );
            converted++;
        }
        if (converted > 0) {
            console.log(
                `[Migration] Converted ${converted} value(s) of ${column.table}.${column.column}.`,
            );
        }
    }

    private tablePath(queryRunner: QueryRunner, name: string): string {
        const { driver } = queryRunner.connection;
        const { schema, tableName } = driver.parseTableName(name);
        return [schema, tableName]
            .filter((part): part is string => !!part)
            .map((part) => driver.escape(part))
            .join(".");
    }
}
