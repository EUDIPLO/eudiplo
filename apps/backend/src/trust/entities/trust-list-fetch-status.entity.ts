import { Column, Entity, ManyToOne, PrimaryColumn } from "typeorm";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { epochMilliseconds } from "../../database/epoch-milliseconds.transformer.js";
import { wholeNumber } from "../../database/whole-number.transformer.js";
import type { TrustListFetchOutcome } from "../ports/trust-list-fetch-statuses.js";

/** The last load of a trust list by a tenant; see `TrustListFetchStatuses`. */
@Entity("trust_list_fetch_status")
export class TrustListFetchStatusEntity {
    @PrimaryColumn("varchar")
    tenantId!: string;

    @ManyToOne(() => TenantEntity, { onDelete: "CASCADE" })
    tenant?: TenantEntity;

    @PrimaryColumn("varchar")
    url!: string;

    @Column({ type: "varchar", nullable: true })
    trustListId!: string | null;

    @Column("varchar")
    outcome!: TrustListFetchOutcome;

    @Column({ type: "varchar", nullable: true })
    reason!: string | null;

    @Column({ type: "bigint", transformer: epochMilliseconds })
    checkedAt!: Date;

    @Column({ type: "bigint", nullable: true, transformer: epochMilliseconds })
    verifiedAt!: Date | null;

    @Column({ type: "bigint", nullable: true, transformer: epochMilliseconds })
    acceptedAt!: Date | null;

    @Column({ type: "varchar", nullable: true })
    nextUpdate!: string | null;

    @Column({ type: "bigint", nullable: true, transformer: wholeNumber })
    sequenceNumber!: number | null;

    @Column({ type: "integer", nullable: true })
    entities!: number | null;
}
