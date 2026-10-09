import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export type AuditActionTypeLiteral =
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
    | "attribute_provider_created"
    | "attribute_provider_updated"
    | "attribute_provider_deleted"
    | "config_bundle_exported"
    | "config_bundle_imported"
    | "config_client_secret_generated"
    | "config_resource_detached"
    | "config_resource_reattached"
    | "session_cancelled";

const ACTION_TYPE_VALUES: AuditActionTypeLiteral[] = [
    "tenant_created",
    "tenant_updated",
    "tenant_deleted",
    "presentation_config_created",
    "presentation_config_updated",
    "presentation_config_deleted",
    "issuance_config_updated",
    "credential_config_created",
    "credential_config_updated",
    "credential_config_deleted",
    "status_list_config_updated",
    "status_list_config_reset",
    "webhook_endpoint_created",
    "webhook_endpoint_updated",
    "webhook_endpoint_deleted",
    "attribute_provider_created",
    "attribute_provider_updated",
    "attribute_provider_deleted",
    "config_bundle_exported",
    "config_bundle_imported",
    "config_client_secret_generated",
    "config_resource_detached",
    "config_resource_reattached",
    "session_cancelled",
];

export class AuditLogResponseDto {
    @ApiProperty()
    id!: string;

    @ApiProperty()
    tenantId!: string;

    @ApiProperty({ enum: ACTION_TYPE_VALUES })
    actionType!: AuditActionTypeLiteral;

    @ApiProperty({ enum: ["user", "client", "system"] })
    actorType!: "user" | "client" | "system";

    @ApiPropertyOptional()
    actorId?: string;

    @ApiPropertyOptional()
    actorDisplay?: string;

    @ApiPropertyOptional({ type: [String] })
    changedFields?: string[];

    @ApiPropertyOptional({ type: "object", additionalProperties: true })
    before?: Record<string, unknown>;

    @ApiPropertyOptional({ type: "object", additionalProperties: true })
    after?: Record<string, unknown>;

    @ApiPropertyOptional()
    requestId?: string;

    @ApiProperty()
    timestamp!: Date;
}
