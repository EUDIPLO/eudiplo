import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/**
 * A DPoP proof `jti` already presented with the key of thumbprint `jkt`.
 * The composite primary key makes registration atomic: of concurrent inserts
 * of the same proof only one succeeds.
 */
@Entity("dpop_proof_jti")
export class DpopProofJtiEntity {
    @PrimaryColumn("varchar")
    jkt!: string;

    @PrimaryColumn("varchar")
    jti!: string;

    @Index("IDX_dpop_proof_jti_expires_at")
    @Column()
    expiresAt!: Date;
}
