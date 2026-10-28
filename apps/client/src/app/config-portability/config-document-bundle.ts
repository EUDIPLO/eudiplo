import type { ConfigBundle } from './config-portability.service';

/** Kind of each document schema file, as in `CONFIG_FORMATS` of the config format. */
const KIND_BY_SCHEMA_FILE: Record<string, string> = {
  TenantConfigFile: 'Tenant',
  ClientConfigFile: 'Client',
  KmsConfigFile: 'KmsConfig',
  KeyChainConfigFile: 'KeyChain',
  KeyChainDefaultsConfigFile: 'KeyChainDefaults',
  RegistrarConfigFile: 'RegistrarConfig',
  IssuanceConfigFile: 'IssuanceConfig',
  CredentialConfigFile: 'CredentialConfig',
  PresentationConfigFile: 'PresentationConfig',
  AttributeProviderConfigFile: 'AttributeProvider',
  WebhookEndpointConfigFile: 'WebhookEndpoint',
  TrustListConfigFile: 'TrustList',
  FederationTrustAnchorConfigFile: 'FederationTrustAnchor',
  StatusListConfigFile: 'StatusList',
};

const SINGLETON_IDS: Record<string, string> = {
  Tenant: 'tenant',
  KmsConfig: 'kms',
  RegistrarConfig: 'registrar',
  IssuanceConfig: 'issuance',
  KeyChainDefaults: 'defaults',
};

interface ConfigDocumentFile {
  $schema: string;
  metadata?: { generation?: number };
  spec: Record<string, unknown>;
}

/** A single configuration document (`$schema` and `spec`), as a resource download saves it. */
export function isConfigDocument(value: unknown): value is ConfigDocumentFile {
  const document = value as Partial<ConfigDocumentFile> | null;
  return (
    typeof document?.$schema === 'string' &&
    !!document.spec &&
    typeof document.spec === 'object' &&
    !Array.isArray(document.spec)
  );
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Wraps one configuration document into a bundle, so the import plans it like
 * a bundle export. The backend validates the document; this only names its
 * kind and ID for the manifest.
 */
export async function singleDocumentBundle(
  document: ConfigDocumentFile,
  tenant: string
): Promise<ConfigBundle> {
  const file = /^https:\/\/eudiplo\.dev\/schemas\/v[1-9]\d*\/([A-Za-z]+)\.schema\.json$/.exec(
    document.$schema
  )?.[1];
  const kind = file ? KIND_BY_SCHEMA_FILE[file] : undefined;
  if (!kind) throw new Error(`Unknown configuration schema: ${document.$schema}`);
  const id =
    SINGLETON_IDS[kind] ?? (kind === 'Client' ? document.spec['clientId'] : document.spec['id']);
  if (typeof id !== 'string' || !id) {
    throw new Error(`The ${kind} document names no ${kind === 'Client' ? 'clientId' : 'id'}`);
  }
  return {
    manifest: {
      format: 'eudiplo.config-bundle',
      formatVersion: 2,
      sourceVersion: 'document',
      exportedAt: new Date().toISOString(),
      tenant,
      resources: [
        {
          kind,
          id,
          $schema: document.$schema,
          path: 'resources/document.json',
          sha256: await sha256(JSON.stringify(document)),
          ownership: 'unmanaged',
          generation: document.metadata?.generation ?? 1,
        },
      ],
      assets: [],
      requirements: [],
      warnings: [],
    },
    documents: [document],
    assets: [],
  } as unknown as ConfigBundle;
}
