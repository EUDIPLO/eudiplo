import type { AuditLogControllerSearchAuditLogsData, AuditLogResponseDto } from '@eudiplo/sdk-core';

export type AuditActionType = AuditLogResponseDto['actionType'];
export type AuditActorType = AuditLogResponseDto['actorType'];
export type AuditObjectType = NonNullable<
  NonNullable<AuditLogControllerSearchAuditLogsData['query']>['objectType']
>;

/**
 * Labels of every action the backend records. Typed against the SDK, so a new
 * action type does not compile until it has a label here.
 */
export const ACTION_LABELS: Record<AuditActionType, string> = {
  tenant_created: 'Tenant Created',
  tenant_updated: 'Tenant Updated',
  tenant_deleted: 'Tenant Deleted',
  presentation_config_created: 'Presentation Config Created',
  presentation_config_updated: 'Presentation Config Updated',
  presentation_config_deleted: 'Presentation Config Deleted',
  issuance_config_updated: 'Issuance Config Updated',
  credential_config_created: 'Credential Config Created',
  credential_config_updated: 'Credential Config Updated',
  credential_config_deleted: 'Credential Config Deleted',
  status_list_config_updated: 'Status List Config Updated',
  status_list_config_reset: 'Status List Config Reset',
  webhook_endpoint_created: 'Webhook Endpoint Created',
  webhook_endpoint_updated: 'Webhook Endpoint Updated',
  webhook_endpoint_deleted: 'Webhook Endpoint Deleted',
  oidc_client_created: 'OpenID Connect Client Created',
  oidc_client_updated: 'OpenID Connect Client Updated',
  oidc_client_deleted: 'OpenID Connect Client Deleted',
  oidc_client_secret_added: 'OpenID Connect Client Secret Added',
  oidc_client_secret_updated: 'OpenID Connect Client Secret Updated',
  oidc_client_secret_deleted: 'OpenID Connect Client Secret Deleted',
  attribute_provider_created: 'Attribute Provider Created',
  attribute_provider_updated: 'Attribute Provider Updated',
  attribute_provider_deleted: 'Attribute Provider Deleted',
  federation_trust_anchor_created: 'Federation Trust Anchor Created',
  federation_trust_anchor_updated: 'Federation Trust Anchor Updated',
  federation_trust_anchor_deleted: 'Federation Trust Anchor Deleted',
  config_bundle_exported: 'Configuration Bundle Exported',
  config_bundle_imported: 'Configuration Bundle Imported',
  config_client_secret_generated: 'Client Secret Generated for Import',
  config_resource_detached: 'Configuration Detached from File',
  config_resource_reattached: 'Configuration Reattached to File',
  config_resource_exported: 'Configuration Exported',
  session_cancelled: 'Session Cancelled',
  audit_log_pruned: 'Old Entries Deleted',
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
export const ACTION_TYPES = Object.keys(ACTION_LABELS) as AuditActionType[];

export const ACTOR_LABELS: Record<AuditActorType, string> = {
  user: 'User',
  client: 'API Client',
  system: 'System',
};

/**
 * The object an action is about: the longest object type the action starts
 * with, so `oidc_client_secret_added` belongs to `oidc_client_secret`, not
 * to `oidc_client`.
 */
export function objectTypeOf(actionType: string): AuditObjectType | undefined {
  return OBJECT_TYPES.filter((objectType) => actionType.startsWith(`${objectType}_`)).sort(
    (a, b) => b.length - a.length
  )[0];
}

export function actionLabel(actionType: string | undefined): string {
  if (!actionType) return 'Unknown';
  return ACTION_LABELS[actionType as AuditActionType] ?? actionType;
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
