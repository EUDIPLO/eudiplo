import { BitsPerStatus } from "@owf/token-status-list";
import {
    Column,
    CreateDateColumn,
    Entity,
    ManyToOne,
    VersionColumn,
} from "typeorm";
import { TenantEntity } from "../../../auth/tenant/entities/tenant.entity.js";

/**
 * Entity representing a status list for a tenant.
 * Multiple status lists can exist per tenant, optionally bound to specific credential configurations.
 */
@Entity()
export class StatusListEntity {
    /**
     * Unique identifier for the status list.
     */
    @Column("varchar", { primary: true })
    id!: string;

    @Column("varchar", { nullable: true })
    description?: string;

    /**
     * The ID of the tenant to which the status list belongs.
     */
    @Column("varchar", { primary: true })
    tenantId!: string;

    /**
     * The tenant that owns this object.
     */
    @ManyToOne(() => TenantEntity, { cascade: true, onDelete: "CASCADE" })
    tenant!: TenantEntity;

    /**
     * Optional credential configuration ID that this status list is exclusively bound to.
     * If null, this is a shared status list available for any credential configuration.
     */
    @Column("varchar", { nullable: true })
    credentialConfigurationId?: string | null;

    /**
     * Optional key chain ID to use for signing this status list's JWT.
     * If null, uses the tenant's default StatusList key chain.
     */
    @Column("varchar", { nullable: true })
    keyChainId?: string | null;

    /**
     * The elements of the status list.
     */
    @Column("json")
    elements!: number[];

    /**
     * The stack of available indexes for the status list.
     */
    @Column("json")
    stack!: number[];

    /**
     * The number of bits used for each status in the status list.
     */
    @Column("int")
    bits!: BitsPerStatus;

    /**
     * The JSON Web Token (JWT) for the status list.
     */
    @Column("varchar", { nullable: true })
    jwt?: string;

    /**
     * Base64url-encoded CBOR Web Token (CWT) for the status list.
     * Cached alongside JWT to avoid re-signing on each CWT request.
     */
    @Column("text", { nullable: true })
    cwt?: string;

    /**
     * When the current JWT expires (based on TTL).
     * Used for lazy regeneration - JWT is regenerated on request when expired.
     */
    @Column({ nullable: true })
    expiresAt?: Date;

    /**
     * Optimistic locking version for concurrency control.
     * Incremented on every modification to elements, cached tokens or
     * bindings, so tokens are never cached for values that changed while they
     * were signed. Allocation changes only `stack` and does not increment it;
     * it locks the row instead.
     */
    @VersionColumn()
    version!: number;

    /**
     * Timestamp when this status list was created.
     */
    @CreateDateColumn()
    createdAt!: Date;
}
