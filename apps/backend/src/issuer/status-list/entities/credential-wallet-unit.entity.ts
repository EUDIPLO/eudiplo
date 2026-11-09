import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";
import { TenantEntity } from "../../../auth/tenant/entities/tenant.entity.js";
import { epochMilliseconds } from "../../../database/epoch-milliseconds.transformer.js";
import { StatusListEntity } from "./status-list.entity.js";

/**
 * The wallet unit attestation an issued credential was bound to, for a
 * credential configuration with `revokeWithWalletUnit`. One row per status
 * entry of such a credential: the background check reads the attestation's
 * status list and revokes the entry once the wallet unit is revoked, then
 * deletes the row. A row is also deleted once the credential is revoked
 * otherwise or has expired.
 */
@Entity()
@Index("IDX_credential_wallet_unit_status", ["tenantId", "walletUnitStatusUri"])
export class CredentialWalletUnit {
    @Column({ type: "varchar", primary: true })
    tenantId!: string;

    @ManyToOne(() => TenantEntity, { onDelete: "CASCADE" })
    tenant!: TenantEntity;

    /** Status list of the credential's status entry. */
    @Column({ type: "varchar", primary: true })
    statusListId!: string;

    @ManyToOne(() => StatusListEntity, { onDelete: "CASCADE" })
    @JoinColumn([
        { name: "statusListId", referencedColumnName: "id" },
        { name: "tenantId", referencedColumnName: "tenantId" },
    ])
    statusList!: StatusListEntity;

    /** Index of the credential's status entry. */
    @Column({ type: "int", primary: true })
    index!: number;

    /** Issuance session of the credential, named in the webhook. */
    @Column({ type: "varchar" })
    sessionId!: string;

    @Column({ type: "varchar" })
    credentialConfigurationId!: string;

    /** `status.status_list.uri` of the wallet unit attestation. */
    @Column({ type: "varchar" })
    walletUnitStatusUri!: string;

    /** `status.status_list.idx` of the wallet unit attestation. */
    @Column({ type: "int" })
    walletUnitStatusIdx!: number;

    /** `x5c` of the wallet unit attestation, leaf first. */
    @Column("json")
    walletUnitCertificates!: string[];

    /**
     * When the credential expires; the check ends then. Null for a
     * credential without expiry.
     */
    @Column({
        type: "bigint",
        nullable: true,
        transformer: epochMilliseconds,
    })
    credentialExpiresAt?: Date | null;
}
