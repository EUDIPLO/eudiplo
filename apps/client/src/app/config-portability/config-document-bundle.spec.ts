import { describe, expect, it } from 'vitest';
import { isConfigDocument, singleDocumentBundle } from './config-document-bundle';

const schema = (file: string, version = 1) =>
  `https://eudiplo.dev/schemas/v${version}/${file}.schema.json`;

/** The checksum the backend compares: SHA-256 of the serialized document. */
async function expectedSha256(document: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(document))
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('singleDocumentBundle', () => {
  it('wraps a document with its kind, ID, generation and checksum', async () => {
    const document = {
      $schema: schema('WebhookEndpointConfigFile'),
      metadata: { generation: 3 },
      spec: { id: 'notification', name: 'Hook', url: 'https://hooks.example.com' },
    };

    const bundle = await singleDocumentBundle(document, 'acme');

    expect(bundle.manifest.tenant).toBe('acme');
    expect(bundle.documents).toEqual([document]);
    expect(bundle.manifest.resources).toEqual([
      {
        kind: 'WebhookEndpoint',
        id: 'notification',
        $schema: document.$schema,
        path: 'resources/document.json',
        sha256: await expectedSha256(document),
        ownership: 'unmanaged',
        generation: 3,
      },
    ]);
  });

  it('names a client by its clientId and a singleton by its fixed ID', async () => {
    const client = await singleDocumentBundle(
      { $schema: schema('ClientConfigFile', 2), spec: { clientId: 'shop' } },
      'acme'
    );
    const issuance = await singleDocumentBundle(
      { $schema: schema('IssuanceConfigFile', 4), spec: {} },
      'acme'
    );
    const kms = await singleDocumentBundle(
      { $schema: schema('KmsConfigFile', 2), spec: { providers: [] } },
      'acme'
    );

    expect(client.manifest.resources).toMatchObject([{ kind: 'Client', id: 'shop' }]);
    expect(issuance.manifest.resources).toMatchObject([{ kind: 'IssuanceConfig', id: 'issuance' }]);
    const defaults = await singleDocumentBundle(
      { $schema: schema('KeyChainDefaultsConfigFile', 1), spec: { access: 'access' } },
      'acme'
    );

    expect(kms.manifest.resources).toMatchObject([{ kind: 'KmsConfig', id: 'kms' }]);
    expect(defaults.manifest.resources).toMatchObject([
      { kind: 'KeyChainDefaults', id: 'defaults' },
    ]);
  });

  it('refuses an unknown schema and a document without ID', async () => {
    await expect(
      singleDocumentBundle({ $schema: 'https://example.com/x.json', spec: {} }, 'acme')
    ).rejects.toThrow('Unknown configuration schema');
    await expect(
      singleDocumentBundle({ $schema: schema('CredentialConfigFile', 2), spec: {} }, 'acme')
    ).rejects.toThrow('names no id');
  });
});

describe('isConfigDocument', () => {
  it('tells a document from a bundle', () => {
    expect(isConfigDocument({ $schema: schema('TrustListConfigFile'), spec: {} })).toBe(true);
    expect(isConfigDocument({ manifest: {}, documents: [] })).toBe(false);
    expect(isConfigDocument({ $schema: schema('TrustListConfigFile'), spec: [] })).toBe(false);
  });
});
