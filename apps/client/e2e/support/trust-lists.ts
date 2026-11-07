import { expect } from './test';
import { resolvedE2EConfig } from './e2e-config';
import { certificatePem, createKeyChain } from './key-chains';

const api = resolvedE2EConfig.apiBaseUrl;

/**
 * Creates a trust list with one external wallet provider and the key chain
 * that signs it, which a trust list needs.
 */
export async function createTrustList(
  token: string,
  id: string,
  description: string
): Promise<void> {
  await createKeyChain(token, 'trustList', `${description} signing`);
  const response = await fetch(`${api}/api/trust-list`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      description,
      entities: [
        {
          type: 'external',
          providerType: 'wallet-provider',
          issuerCertPem: certificatePem,
          revocationCertPem: certificatePem,
          info: {
            name: 'Example Wallet Provider',
            contactUri: 'info@example.com',
            website: 'https://example.com/',
          },
        },
      ],
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
}
