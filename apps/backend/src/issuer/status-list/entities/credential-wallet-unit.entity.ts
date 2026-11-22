import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";
import { TenantEntity } from "../../../auth/tenant/entities/tenant.entity.js";
import { epochMilliseconds } from "../../../database/epoch-milliseconds.transformer.js";
import type { AttestationKind } from "../../../trust/domain/attestation-status-claims.js";
import { StatusListEntity } from "./status-list.entity.js";

/**
 * A wallet unit attestation an issued credential was bound to, for a
 * credential configuration with `revokeWithWalletUnit`. Up to two rows per
 * status entry of such a credential, one for the key attestation of its
 * proof and one for the wallet attestation of its access token: the
 * background check reads each attestation's status list and revokes the
 * entry once either is revoked, then deletes the rows of the entry. The rows
 * are also deleted once the credential is revoked otherwise or has expired.
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

    /**
     * Which attestation the row follows: `key` for the key attestation of
     * the proof, `wallet` for the wallet attestation (WIA) presented at the
     * token endpoint. Rows written before wallet attestations were followed
     * are `key`.
     */
    @Column({ type: "varchar", primary: true, default: "key" })
    attestationKind!: AttestationKind;

    /** Issuance session of the credential, named in the webhook. */
    @Column({ type: "varchar" })
    sessionId!: string;

    @Column({ type: "varchar" })
    credentialConfigurationId!: string;

    /** `status_list.uri` the wallet unit attestation names (`key_storage_status.status`, else `status`). */
    @Column({ type: "varchar" })
    walletUnitStatusUri!: string;

    /** `status_list.idx` the wallet unit attestation names (`key_storage_status.status`, else `status`). */
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
