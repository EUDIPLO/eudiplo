import type { AuditLogControllerSearchAuditLogsData, AuditLogResponseDto } from '@eudiplo/sdk-core';

export type AuditActionType = AuditLogResponseDto['actionType'];
export type AuditActorType = AuditLogResponseDto['actorType'];
export type AuditObjectType = NonNullable<
  NonNullable<AuditLogControllerSearchAuditLogsData['query']>['objectType']
>;

/**
 * The object and label of every action the backend records, as in the
 * backend's catalog (`audit-action-types.ts`). Typed against the SDK, so a
 * new action type does not compile until it is listed here.
 */
const ACTIONS: Record<AuditActionType, [AuditObjectType, string]> = {
  tenant_created: ['tenant', 'Tenant Created'],
  tenant_updated: ['tenant', 'Tenant Updated'],
  tenant_deleted: ['tenant', 'Tenant Deleted'],
  presentation_config_created: ['presentation_config', 'Presentation Config Created'],
  presentation_config_updated: ['presentation_config', 'Presentation Config Updated'],
  presentation_config_deleted: ['presentation_config', 'Presentation Config Deleted'],
  issuance_config_updated: ['issuance_config', 'Issuance Config Updated'],
  credential_config_created: ['credential_config', 'Credential Config Created'],
  credential_config_updated: ['credential_config', 'Credential Config Updated'],
  credential_config_deleted: ['credential_config', 'Credential Config Deleted'],
  status_list_config_updated: ['status_list_config', 'Status List Config Updated'],
  status_list_config_reset: ['status_list_config', 'Status List Config Reset'],
  webhook_endpoint_created: ['webhook_endpoint', 'Webhook Endpoint Created'],
  webhook_endpoint_updated: ['webhook_endpoint', 'Webhook Endpoint Updated'],
  webhook_endpoint_deleted: ['webhook_endpoint', 'Webhook Endpoint Deleted'],
  oidc_client_created: ['oidc_client', 'OpenID Connect Client Created'],
  oidc_client_updated: ['oidc_client', 'OpenID Connect Client Updated'],
  oidc_client_deleted: ['oidc_client', 'OpenID Connect Client Deleted'],
  oidc_client_secret_added: ['oidc_client_secret', 'OpenID Connect Client Secret Added'],
  oidc_client_secret_updated: ['oidc_client_secret', 'OpenID Connect Client Secret Updated'],
  oidc_client_secret_deleted: ['oidc_client_secret', 'OpenID Connect Client Secret Deleted'],
  attribute_provider_created: ['attribute_provider', 'Attribute Provider Created'],
  attribute_provider_updated: ['attribute_provider', 'Attribute Provider Updated'],
  attribute_provider_deleted: ['attribute_provider', 'Attribute Provider Deleted'],
  federation_trust_anchor_created: ['federation_trust_anchor', 'Federation Trust Anchor Created'],
  federation_trust_anchor_updated: ['federation_trust_anchor', 'Federation Trust Anchor Updated'],
  federation_trust_anchor_deleted: ['federation_trust_anchor', 'Federation Trust Anchor Deleted'],
  config_bundle_exported: ['config_bundle', 'Configuration Bundle Exported'],
  config_bundle_imported: ['config_bundle', 'Configuration Bundle Imported'],
  config_client_secret_generated: ['config_client_secret', 'Client Secret Generated for Import'],
  config_resource_detached: ['config_resource', 'Configuration Detached from File'],
  config_resource_reattached: ['config_resource', 'Configuration Reattached to File'],
  config_resource_exported: ['config_resource', 'Configuration Exported'],
  session_cancelled: ['session', 'Session Cancelled'],
  audit_log_pruned: ['audit_log', 'Old Entries Deleted'],
};

/** Labels of the objects actions are about, in the order the filter lists them. */
export const OBJECT_LABELS = {
  tenant: 'Tenant',
  credential_config: 'Credential Config',
  issuance_config: 'Issuance Config',
  presentation_config: 'Presentation Config',
  status_list_config: 'Status List Config',
  attribute_provider: 'Attribute Provider',
  webhook_endpoint: 'Webhook Endpoint',
  oidc_client: 'OpenID Connect Client',
  oidc_client_secret: 'OpenID Connect Client Secret',
  federation_trust_anchor: 'Federation Trust Anchor',
  config_bundle: 'Configuration Bundle',
  config_client_secret: 'Import Client Secret',
  config_resource: 'Configuration File',
  session: 'Session',
  audit_log: 'Activity Log',
} as const satisfies Record<AuditObjectType, string>;

export const OBJECT_TYPES = Object.keys(OBJECT_LABELS) as AuditObjectType[];
export const ACTION_TYPES = Object.keys(ACTIONS) as AuditActionType[];

export const ACTOR_LABELS: Record<AuditActorType, string> = {
  user: 'User',
  client: 'API Client',
  system: 'System',
};

/** The object an action is about. */
export function objectTypeOf(actionType: string): AuditObjectType | undefined {
  return ACTIONS[actionType as AuditActionType]?.[0];
}

export function actionLabel(actionType: string | undefined): string {
  if (!actionType) return 'Unknown';
  return ACTIONS[actionType as AuditActionType]?.[1] ?? actionType;
}

/** Changed fields, or what a retention run deleted. */
export function detailsOf(log: AuditLogResponseDto): string {
  if (log.actionType === 'audit_log_pruned') {
    const deleted = log.after?.['deletedEntries'];
    if (typeof deleted !== 'number') return 'Deleted by the retention settings';
    return `${deleted} ${deleted === 1 ? 'entry' : 'entries'} deleted by the retention settings`;
  }
  return log.changedFields?.length ? log.changedFields.join(', ') : '—';
}
