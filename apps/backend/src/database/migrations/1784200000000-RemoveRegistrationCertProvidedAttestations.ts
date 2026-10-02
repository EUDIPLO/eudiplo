import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Removes `registration_cert.body.provided_attestations` from stored
 * presentation configs. The registrar API names the field
 * `provides_attestations` and expects credential type identifiers; the object
 * entries accepted under the old name were never understood by the registrar.
 * Mirrors the PresentationConfig v1 -> v2 config-file migration, so exports of
 * migrated rows validate against the current format.
 */
export class RemoveRegistrationCertProvidedAttestations1784200000000
    implements MigrationInterface
{
    name = "RemoveRegistrationCertProvidedAttestations1784200000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("presentation_config");
        if (!table?.columns.some((c) => c.name === "registration_cert")) {
            return;
        }

        const escape = (identifier: string) =>
            queryRunner.connection.driver.escape(identifier);
        // Use driver-appropriate SQL placeholders (Postgres: $1,$2,... / SQLite: ?,?,...)
        const param = (n: number) =>
            queryRunner.connection.options.type === "postgres" ? `$${n}` : "?";

        const rows: Array<{
            id: string;
            tenantId: string;
            registration_cert: unknown;
        }> = await queryRunner.query(
            `SELECT ${escape("id")}, ${escape("tenantId")}, ${escape("registration_cert")} FROM ${escape("presentation_config")} WHERE ${escape("registration_cert")} IS NOT NULL`,
        );

        let migrated = 0;
        for (const row of rows) {
            const registrationCert =
                typeof row.registration_cert === "string"
                    ? JSON.parse(row.registration_cert)
                    : row.registration_cert;
            const body = registrationCert?.body;
            if (
                !body ||
                typeof body !== "object" ||
                !("provided_attestations" in body)
            ) {
                continue;
            }
            delete body.provided_attestations;
            await queryRunner.query(
                `UPDATE ${escape("presentation_config")} SET ${escape("registration_cert")} = ${param(1)} WHERE ${escape("id")} = ${param(2)} AND ${escape("tenantId")} = ${param(3)}`,
                [JSON.stringify(registrationCert), row.id, row.tenantId],
            );
            migrated++;
        }

        if (migrated > 0) {
            console.log(
                `[Migration] Removed registration_cert.body.provided_attestations from ${migrated} presentation config(s); set provides_attestations instead.`,
            );
        }
    }

    public async down(): Promise<void> {
        // The removed entries had no effect and cannot be restored.
    }
}
