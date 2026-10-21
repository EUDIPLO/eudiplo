import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from "typeorm";
import { TenantEntity } from "../../../auth/tenant/entities/tenant.entity.js";
import { StatusListEntity } from "./status-list.entity.js";

@Entity()
@Unique("UQ_status_mapping_tenant_list_index", [
    "tenantId",
    "statusListId",
    "index",
])
export class StatusMapping {
    @Column({ type: "varchar", primary: true })
    tenantId!: string;

    /**
     * The tenant that owns this object.
     */
    @ManyToOne(() => TenantEntity, { cascade: true, onDelete: "CASCADE" })
    tenant!: TenantEntity;

    @Column({ type: "varchar", primary: true })
    sessionId!: string;

    /**
     * The ID of the status list this mapping belongs to.
     */
    @Column({ type: "varchar", primary: true })
    statusListId!: string;

    /**
     * The status list entity.
     */
    @ManyToOne(() => StatusListEntity, { onDelete: "CASCADE" })
    @JoinColumn([
        { name: "statusListId", referencedColumnName: "id" },
        { name: "tenantId", referencedColumnName: "tenantId" },
    ])
    statusList!: StatusListEntity;

    /**
     * The full URI of the status list (for backward compatibility and quick lookups).
     */
    @Column({ type: "varchar" })
    list!: string;

    @Column({ type: "int", primary: true })
    index!: number;

    @Column({ type: "varchar", primary: true })
    credentialConfigurationId!: string;

    /**
     * Opaque identifier grouping all status entries allocated for one issuance
     * (one Credential Response, including batch issuance).
     *
     * Used by the active-credential-limit policy (issue #843) to find the
     * entries belonging to a subject's previously active issuance so they can
     * be revoked as a set. Deliberately opaque and subject-independent: no
     * subject-derived value is stored on historical status mappings.
     *
     * Null for issuance that predates the policy or does not use it.
     */
    @Column({ type: "varchar", nullable: true })
    @Index("IDX_status_mapping_issuance_set")
    issuanceSetId?: string | null;

    @Column({ nullable: true })
    statusUpdatedAt?: Date;
}
