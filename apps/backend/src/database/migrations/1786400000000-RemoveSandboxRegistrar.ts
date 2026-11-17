import { decodeJwt } from "jose";
import {
    type MigrationInterface,
    type QueryRunner,
    Table,
    TableColumn,
    TableForeignKey,
} from "typeorm";

const PRESENTATION = "presentation_config";
const PRESENTATION_CACHE = "registrationCertCache";
const ISSUANCE = "issuance_config";
const ISSUANCE_CACHE = "registrationCertificateCache";
const REGISTRAR = "registrar_config_entity";
const OWNERSHIP = "config_resource_metadata";

/** Seconds of tolerance when deciding whether a cached JWT is still valid. */
const CLOCK_SKEW_SECONDS = 60;

type Json = Record<string, any>;

/**
 * Remove the integration of the German sandbox registrar, which wallets no
 * longer accept. Registration certificates come from a registrar such as the
 * EUDI Hub and are stored as JWTs; EUDIPLO no longer creates or renews them.
 *
 * - `presentation_config.registration_cert` becomes `{ jwt, purpose,
 *   privacy_policy }`. A certificate the sandbox registrar created for
 *   `id` or `body` is kept as `jwt` from `registrationCertCache` while it is
 *   valid, so presentations keep working until it expires; `body.purpose`
 *   and `body.privacy_policy` are kept for requesting a new one. The cache
 *   column is dropped.
 * - `issuance_config.registrationCertificate` loses `mode` and `renewal`. In
 *   generate mode (the default), the generated certificate is kept as `jwt`
 *   from `registrationCertificateCache` while it is valid. The cache column
 *   is dropped.
 * - The `registrar_config_entity` table, with the registrar credentials, is
 *   dropped, and so are the ownership records of registrar configurations
 *   imported from `registrar.json`, a resource kind that no longer exists.
 *
 * Mirrors the PresentationConfig v4 -> v5 and IssuanceConfig v6 -> v7
 * config-file migrations.
 */
export class RemoveSandboxRegistrar1786400000000 implements MigrationInterface {
    name = "RemoveSandboxRegistrar1786400000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.migratePresentationConfigs(queryRunner);
        await this.migrateIssuanceConfigs(queryRunner);

        const registrar = await queryRunner.getTable(REGISTRAR);
        if (registrar) {
            const rows: Array<{ tenantId: string }> = await queryRunner.query(
                `SELECT "tenantId" FROM "${REGISTRAR}"`,
            );
            for (const row of rows) {
                console.log(
                    `[Migration] Removed the registrar configuration of tenant ${row.tenantId}: the sandbox registrar integration was removed. Request access and registration certificates from the EUDI Hub.`,
                );
            }
            await queryRunner.dropTable(REGISTRAR);
        }

        if (await queryRunner.getTable(OWNERSHIP)) {
            await queryRunner.query(
                `DELETE FROM "${OWNERSHIP}" WHERE "kind" = ${param(queryRunner, 1)}`,
                ["RegistrarConfig"],
            );
        }
    }

    private async migratePresentationConfigs(
        queryRunner: QueryRunner,
    ): Promise<void> {
        const table = await queryRunner.getTable(PRESENTATION);
        if (!table?.findColumnByName("registration_cert")) return;
        const hasCache = !!table.findColumnByName(PRESENTATION_CACHE);
        const rows: Array<{
            id: string;
            tenantId: string;
            registration_cert: unknown;
            cache?: unknown;
        }> = await queryRunner.query(
            `SELECT "id", "tenantId", "registration_cert"${hasCache ? `, "${PRESENTATION_CACHE}" AS "cache"` : ""} FROM "${PRESENTATION}" WHERE "registration_cert" IS NOT NULL`,
        );
        for (const row of rows) {
            const before = parse(row.registration_cert);
            const after = presentationRegistrationCertificate(
                before,
                parse(row.cache),
            );
            if (JSON.stringify(before) === JSON.stringify(after.value)) {
                continue;
            }
            if (after.note) {
                console.log(
                    `[Migration] Presentation configuration ${row.id} of tenant ${row.tenantId}: ${after.note}`,
                );
            }
            await queryRunner.query(
                `UPDATE "${PRESENTATION}" SET "registration_cert" = ${param(queryRunner, 1)} WHERE "id" = ${param(queryRunner, 2)} AND "tenantId" = ${param(queryRunner, 3)}`,
                [
                    after.value === null ? null : JSON.stringify(after.value),
                    row.id,
                    row.tenantId,
                ],
            );
        }
        if (hasCache) {
            await queryRunner.dropColumn(PRESENTATION, PRESENTATION_CACHE);
        }
    }

    private async migrateIssuanceConfigs(
        queryRunner: QueryRunner,
    ): Promise<void> {
        const table = await queryRunner.getTable(ISSUANCE);
        // Without the cache column the migration ran already: an entry
        // without `mode` is migrated, not one in the old default mode.
        if (
            !table?.findColumnByName("registrationCertificate") ||
            !table.findColumnByName(ISSUANCE_CACHE)
        ) {
            return;
        }
        const rows: Array<{
            tenantId: string;
            settings: unknown;
            cache: unknown;
        }> = await queryRunner.query(
            `SELECT "tenantId", "registrationCertificate" AS "settings", "${ISSUANCE_CACHE}" AS "cache" FROM "${ISSUANCE}" WHERE "registrationCertificate" IS NOT NULL`,
        );
        for (const row of rows) {
            const before = parse(row.settings);
            if (!before || typeof before !== "object") continue;
            const after = issuerRegistrationCertificate(
                before,
                parse(row.cache),
            );
            if (JSON.stringify(before) === JSON.stringify(after.value)) {
                continue;
            }
            if (after.note) {
                console.log(
                    `[Migration] Issuance configuration of tenant ${row.tenantId}: ${after.note}`,
                );
            }
            await queryRunner.query(
                `UPDATE "${ISSUANCE}" SET "registrationCertificate" = ${param(queryRunner, 1)} WHERE "tenantId" = ${param(queryRunner, 2)}`,
                [JSON.stringify(after.value), row.tenantId],
            );
        }
        await queryRunner.dropColumn(ISSUANCE, ISSUANCE_CACHE);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // The registrar credentials and the dropped `id`, `body` and `mode`
        // values cannot be restored; the schema is.
        const presentation = await queryRunner.getTable(PRESENTATION);
        if (
            presentation &&
            !presentation.findColumnByName(PRESENTATION_CACHE)
        ) {
            await queryRunner.addColumn(
                PRESENTATION,
                new TableColumn({
                    name: PRESENTATION_CACHE,
                    type: "json",
                    isNullable: true,
                }),
            );
        }
        const issuance = await queryRunner.getTable(ISSUANCE);
        if (issuance && !issuance.findColumnByName(ISSUANCE_CACHE)) {
            await queryRunner.addColumn(
                ISSUANCE,
                new TableColumn({
                    name: ISSUANCE_CACHE,
                    type: "json",
                    isNullable: true,
                }),
            );
        }
        if (await queryRunner.getTable(REGISTRAR)) return;
        await queryRunner.createTable(
            new Table({
                name: REGISTRAR,
                columns: [
                    { name: "tenantId", type: "varchar", isPrimary: true },
                    { name: "registrarUrl", type: "varchar" },
                    { name: "oidcUrl", type: "varchar" },
                    { name: "clientId", type: "varchar" },
                    { name: "clientSecret", type: "varchar", isNullable: true },
                    { name: "username", type: "varchar" },
                    { name: "password", type: "varchar" },
                    {
                        name: "registrationCertificateDefaults",
                        type: "json",
                        isNullable: true,
                    },
                    {
                        name: "relyingPartyContact",
                        type: "json",
                        isNullable: true,
                    },
                ],
            }),
        );
        await queryRunner.createForeignKey(
            REGISTRAR,
            new TableForeignKey({
                columnNames: ["tenantId"],
                referencedTableName: "tenant_entity",
                referencedColumnNames: ["id"],
                onDelete: "CASCADE",
            }),
        );
    }
}

/**
 * The new `registration_cert` of a presentation configuration, and what was
 * lost on the way, if anything.
 */
export function presentationRegistrationCertificate(
    spec: unknown,
    cache: unknown,
    nowSeconds = Math.floor(Date.now() / 1000),
): { value: Json | null; note?: string } {
    if (!spec || typeof spec !== "object") return { value: null };
    const {
        jwt,
        id,
        body,
        purpose: keptPurpose,
        privacy_policy,
    } = spec as Json;
    const value: Json = {};
    // Already migrated values are kept, so running the migration again
    // changes nothing.
    if (Array.isArray(keptPurpose)) value.purpose = keptPurpose;
    if (typeof privacy_policy === "string") {
        value.privacy_policy = privacy_policy;
    }
    const notes: string[] = [];
    if (typeof jwt === "string" && jwt.length > 0) {
        value.jwt = jwt;
    } else if (id !== undefined || body !== undefined) {
        const cached = (cache as Json | null)?.jwt;
        if (typeof cached === "string" && isActive(cached, nowSeconds)) {
            value.jwt = cached;
            notes.push(
                "kept the registration certificate the sandbox registrar issued as registration_cert.jwt until it expires",
            );
        } else {
            notes.push(
                "the sandbox registrar no longer creates its registration certificate; request one from the EUDI Hub",
            );
        }
    }
    if (body && typeof body === "object") {
        const purpose = Array.isArray(body.purpose)
            ? body.purpose
                  .filter(
                      (
                          entry: unknown,
                      ): entry is { lang: string; content: string } =>
                          typeof (entry as Json)?.lang === "string" &&
                          (entry as Json).lang.length > 0 &&
                          typeof (entry as Json)?.content === "string" &&
                          (entry as Json).content.length > 0,
                  )
                  .map(
                      ({
                          lang,
                          content,
                      }: {
                          lang: string;
                          content: string;
                      }) => ({
                          lang,
                          content,
                      }),
                  )
            : [];
        if (purpose.length > 0 && !value.purpose) value.purpose = purpose;
        if (
            !value.privacy_policy &&
            typeof body.privacy_policy === "string" &&
            body.privacy_policy.length > 0
        ) {
            value.privacy_policy = body.privacy_policy;
        }
    }
    return {
        value: Object.keys(value).length > 0 ? value : null,
        note: notes.length > 0 ? `${notes.join("; ")}.` : undefined,
    };
}

/**
 * The new `registrationCertificate` of an issuance configuration, and what
 * was lost on the way, if anything.
 */
export function issuerRegistrationCertificate(
    settings: Json,
    cache: unknown,
    nowSeconds = Math.floor(Date.now() / 1000),
): { value: Json; note?: string } {
    const { mode, renewal: _renewal, ...value } = settings;
    if (mode === "import") return { value };
    // Generate mode (also when unset) served the cached certificate, not jwt.
    delete value.jwt;
    const cached = (cache as Json | null)?.jwt;
    if (typeof cached === "string" && isActive(cached, nowSeconds)) {
        value.jwt = cached;
        return {
            value,
            note: "kept the issuer registration certificate the sandbox registrar issued as registrationCertificate.jwt until it expires.",
        };
    }
    return {
        value,
        note: value.enabled
            ? "the sandbox registrar no longer generates the issuer registration certificate; request one from the EUDI Hub."
            : undefined,
    };
}

function isActive(jwt: string, nowSeconds: number): boolean {
    try {
        const { exp, nbf } = decodeJwt(jwt);
        return (
            (typeof exp !== "number" ||
                exp - CLOCK_SKEW_SECONDS > nowSeconds) &&
            (typeof nbf !== "number" || nbf - CLOCK_SKEW_SECONDS <= nowSeconds)
        );
    } catch {
        return false;
    }
}

/** SQLite returns JSON columns as text, PostgreSQL parsed. */
function parse(value: unknown): any {
    if (typeof value !== "string") return value ?? null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function param(queryRunner: QueryRunner, n: number): string {
    return queryRunner.connection.options.type === "postgres" ? `$${n}` : "?";
}
