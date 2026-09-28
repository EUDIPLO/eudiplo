import { MigrationInterface, QueryRunner, Table, TableIndex } from "typeorm";

/**
 * Adds `dpop_proof_jti`, which records presented DPoP proofs per key
 * thumbprint until they leave the freshness window, so a proof cannot be
 * replayed (RFC 9449 Section 11.1). The composite primary key makes
 * registration atomic across concurrent requests and instances.
 */
export class AddDpopProofJti1783000000000 implements MigrationInterface {
    name = "AddDpopProofJti1783000000000";
    async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable("dpop_proof_jti")) return;
        const postgres = queryRunner.connection.options.type === "postgres";
        await queryRunner.createTable(
            new Table({
                name: "dpop_proof_jti",
                columns: [
                    { name: "jkt", type: "varchar", isPrimary: true },
                    { name: "jti", type: "varchar", isPrimary: true },
                    {
                        name: "expiresAt",
                        type: postgres ? "timestamp" : "datetime",
                    },
                ],
            }),
            true,
        );
        await queryRunner.createIndex(
            "dpop_proof_jti",
            new TableIndex({
                name: "IDX_dpop_proof_jti_expires_at",
                columnNames: ["expiresAt"],
            }),
        );
    }
    async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable("dpop_proof_jti"))
            await queryRunner.dropTable("dpop_proof_jti");
    }
}
