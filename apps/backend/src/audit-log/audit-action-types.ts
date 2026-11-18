/**
 * The object each audited action is about, keyed by action. The keys are the
 * action types the audit log records; adding an action here adds it to the
 * entity type, the API enum and the object type filter at once.
 */
const AUDIT_ACTION_OBJECT_TYPES = {
    tenant_created: "tenant",
    tenant_updated: "tenant",
    tenant_deleted: "tenant",
    presentation_config_created: "presentation_config",
    presentation_config_updated: "presentation_config",
    presentation_config_deleted: "presentation_config",
    issuance_config_updated: "issuance_config",
    credential_config_created: "credential_config",
    credential_config_updated: "credential_config",
    credential_config_deleted: "credential_config",
    status_list_config_updated: "status_list_config",
    status_list_config_reset: "status_list_config",
    webhook_endpoint_created: "webhook_endpoint",
    webhook_endpoint_updated: "webhook_endpoint",
    webhook_endpoint_deleted: "webhook_endpoint",
    oidc_client_created: "oidc_client",
    oidc_client_updated: "oidc_client",
    oidc_client_deleted: "oidc_client",
    oidc_client_secret_added: "oidc_client_secret",
    oidc_client_secret_updated: "oidc_client_secret",
    oidc_client_secret_deleted: "oidc_client_secret",
    attribute_provider_created: "attribute_provider",
    attribute_provider_updated: "attribute_provider",
    attribute_provider_deleted: "attribute_provider",
    federation_trust_anchor_created: "federation_trust_anchor",
    federation_trust_anchor_updated: "federation_trust_anchor",
    federation_trust_anchor_deleted: "federation_trust_anchor",
    config_bundle_exported: "config_bundle",
    config_bundle_imported: "config_bundle",
    config_client_secret_generated: "config_client_secret",
    config_resource_detached: "config_resource",
    config_resource_reattached: "config_resource",
    config_resource_exported: "config_resource",
    session_cancelled: "session",
    audit_log_pruned: "audit_log",
} as const;

export type AuditActionType = keyof typeof AUDIT_ACTION_OBJECT_TYPES;
export type AuditObjectType =
    (typeof AUDIT_ACTION_OBJECT_TYPES)[AuditActionType];

export const AUDIT_ACTION_TYPES = Object.keys(
    AUDIT_ACTION_OBJECT_TYPES,
) as AuditActionType[];

export const AUDIT_OBJECT_TYPES = [
    ...new Set(Object.values(AUDIT_ACTION_OBJECT_TYPES)),
] as AuditObjectType[];

export const AUDIT_ACTOR_TYPES = ["user", "client", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** The action types recorded for one kind of object. */
export function actionTypesOf(objectType: AuditObjectType): AuditActionType[] {
    return AUDIT_ACTION_TYPES.filter(
        (actionType) => AUDIT_ACTION_OBJECT_TYPES[actionType] === objectType,
    );
}
