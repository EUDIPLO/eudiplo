import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
} from "typeorm";
import type { AuditActionType, AuditActorType } from "../audit-action-types.js";

// Keep the existing table name to avoid a migration
@Entity("tenant_action_log")
// Every list query filters on the tenant and orders by time.
@Index("IDX_tenant_action_log_tenant_timestamp", ["tenantId", "timestamp"])
export class AuditLogEntity {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Index()
    @Column("varchar")
    tenantId!: string;

    @CreateDateColumn()
    timestamp!: Date;

    @Column("varchar")
    actionType!: AuditActionType;

    @Column("varchar")
    actorType!: AuditActorType;

    @Column("varchar", { nullable: true })
    actorId?: string;

    @Column("varchar", { nullable: true })
    actorDisplay?: string;

    @Column("json", { nullable: true })
    changedFields?: string[];

    @Column("json", { nullable: true })
    before?: Record<string, unknown>;

    @Column("json", { nullable: true })
    after?: Record<string, unknown>;

    @Column("varchar", { nullable: true })
    requestId?: string;
}
