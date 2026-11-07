import { Column, Entity, ManyToOne, PrimaryColumn } from "typeorm";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";

/** PostgreSQL returns every `bigint` as a string; read it as a number. */
const wholeNumber = {
    to: (value?: number | null) => value,
    from: (value?: string | number | null) =>
        value === null || value === undefined ? value : Number(value),
};

/**
 * The highest `LoTESequenceNumber` of a trust list that a tenant accepted
 * from `url`. A list numbered lower is an older version and is discarded.
 */
@Entity("trust_list_sequence_number")
export class TrustListSequenceNumberEntity {
    @PrimaryColumn("varchar")
    tenantId!: string;

    @ManyToOne(() => TenantEntity, { onDelete: "CASCADE" })
    tenant?: TenantEntity;

    /** The list URL as configured, after `<TENANT_URL>` was replaced. */
    @PrimaryColumn("varchar")
    url!: string;

    @Column({ type: "bigint", transformer: wholeNumber })
    sequenceNumber!: number;
}
