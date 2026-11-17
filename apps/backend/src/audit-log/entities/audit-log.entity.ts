import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
} from "typeorm";

export type AuditActionType =
    | "tenant_created"
    | "tenant_updated"
    | "tenant_deleted"
    | "presentation_config_created"
    | "presentation_config_updated"
    | "presentation_config_deleted"
    | "issuance_config_updated"
    | "credential_config_created"
    | "credential_config_updated"
    | "credential_config_deleted"
    | "status_list_config_updated"
    | "status_list_config_reset"
    | "webhook_endpoint_created"
    | "webhook_endpoint_updated"
    | "webhook_endpoint_deleted"
    | "oidc_client_created"
    | "oidc_client_updated"
    | "oidc_client_deleted"
    | "oidc_client_secret_added"
    | "oidc_client_secret_updated"
    | "oidc_client_secret_deleted"
    | "attribute_provider_created"
    | "attribute_provider_updated"
    | "attribute_provider_deleted"
    | "federation_trust_anchor_created"
    | "federation_trust_anchor_updated"
    | "federation_trust_anchor_deleted"
    | "config_bundle_exported"
    | "config_bundle_imported"
    | "config_client_secret_generated"
    | "config_resource_detached"
    | "config_resource_reattached"
    | "config_resource_exported"
    | "session_cancelled";

export type AuditActorType = "user" | "client" | "system";

// Keep the existing table name to avoid a migration
@Entity("tenant_action_log")
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
