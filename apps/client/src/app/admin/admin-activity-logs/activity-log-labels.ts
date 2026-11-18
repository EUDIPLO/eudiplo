import type { AuditLogControllerSearchAuditLogsData, AuditLogResponseDto } from '@eudiplo/sdk-core';

export type AuditActionType = AuditLogResponseDto['actionType'];
export type AuditActorType = AuditLogResponseDto['actorType'];
export type AuditObjectType = NonNullable<
  NonNullable<AuditLogControllerSearchAuditLogsData['query']>['objectType']
>;

/**
 * Accepts only a list that names every action type of the SDK, so the
 * compiler reports an action the backend has added but the page has not.
 */
function everyActionType<const T extends readonly AuditActionType[]>(
  actions: T &
    ([Exclude<AuditActionType, T[number]>] extends [never] ? unknown : 'lists every action type')
): T {
  return actions;
}

/** Every action the backend records; the filters offer all of them. */
export const ACTION_TYPES = everyActionType([
  'tenant_created',
  'tenant_updated',
  'tenant_deleted',
  'presentation_config_created',
  'presentation_config_updated',
  'presentation_config_deleted',
  'issuance_config_updated',
  'credential_config_created',
  'credential_config_updated',
  'credential_config_deleted',
  'status_list_config_updated',
  'status_list_config_reset',
  'webhook_endpoint_created',
  'webhook_endpoint_updated',
  'webhook_endpoint_deleted',
  'oidc_client_created',
  'oidc_client_updated',
  'oidc_client_deleted',
  'oidc_client_secret_added',
  'oidc_client_secret_updated',
  'oidc_client_secret_deleted',
  'attribute_provider_created',
  'attribute_provider_updated',
  'attribute_provider_deleted',
  'federation_trust_anchor_created',
  'federation_trust_anchor_updated',
  'federation_trust_anchor_deleted',
  'config_bundle_exported',
  'config_bundle_imported',
  'config_client_secret_generated',
  'config_resource_detached',
  'config_resource_reattached',
  'config_resource_exported',
  'session_cancelled',
  'audit_log_pruned',
]);

export const ACTOR_LABELS: Record<AuditActorType, string> = {
  user: 'User',
  client: 'API Client',
  system: 'System',
};

/** What an entry's action did, as the page shows it. */
export interface ActionDescription {
  /** The object the action is about, such as `credential_config`. */
  object: string;
  /** The verb, such as `created`; empty when the action type has none of the known verbs. */
  verb: string;
  /** For example "Credential Config Created". */
  label: string;
  /** Colour role of the verb. */
  tone: 'tone-success' | 'tone-info' | 'tone-danger' | 'tone-neutral';
  icon: string;
}

/** The verbs action types end with, with their colour and icon. */
const verbs: Record<string, { tone: ActionDescription['tone']; icon: string }> = {
  created: { tone: 'tone-success', icon: 'add' },
  added: { tone: 'tone-success', icon: 'add' },
  imported: { tone: 'tone-success', icon: 'download' },
  generated: { tone: 'tone-success', icon: 'key' },
  updated: { tone: 'tone-info', icon: 'edit' },
  reset: { tone: 'tone-info', icon: 'restart_alt' },
  reattached: { tone: 'tone-info', icon: 'link' },
  exported: { tone: 'tone-neutral', icon: 'upload' },
  detached: { tone: 'tone-neutral', icon: 'link_off' },
  pruned: { tone: 'tone-neutral', icon: 'auto_delete' },
  deleted: { tone: 'tone-danger', icon: 'delete' },
  cancelled: { tone: 'tone-danger', icon: 'block' },
};

/** Words of object types that are not simply capitalised. */
const words: Record<string, string> = {
  oidc: 'OpenID Connect',
  config: 'Config',
};

/** "credential_config" as "Credential Config", "oidc_client" as "OpenID Connect Client". */
export function titleCase(snake: string): string {
  return snake
    .split('_')
    .map((word) => words[word] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Splits an action type into its object and verb, for any action the backend logs. */
export function describeAction(actionType: string | undefined): ActionDescription {
  if (!actionType) {
    return { object: '', verb: '', label: 'Unknown', tone: 'tone-neutral', icon: 'help' };
  }
  const verb = Object.keys(verbs).find((candidate) => actionType.endsWith(`_${candidate}`));
  if (!verb) {
    return {
      object: actionType,
      verb: '',
      label: titleCase(actionType),
      tone: 'tone-neutral',
      icon: 'history',
    };
  }
  const object = actionType.slice(0, -(verb.length + 1));
  return { object, verb, label: `${titleCase(object)} ${titleCase(verb)}`, ...verbs[verb] };
}

/**
 * The object an action is about: its type without the verb, as the backend's
 * catalog names it (`audit-action-types.ts` checks that convention).
 */
export function objectTypeOf(actionType: string): AuditObjectType | undefined {
  const { object, verb } = describeAction(actionType);
  return verb ? (object as AuditObjectType) : undefined;
}

/** Every object type, each once, in the order of the actions. */
export const OBJECT_TYPES = [...new Set(ACTION_TYPES.map((action) => objectTypeOf(action)!))];
