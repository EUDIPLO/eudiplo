import { generateKeyPairSync } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect } from './test';
import { resolvedE2EConfig } from './e2e-config';

const api = resolvedE2EConfig.apiBaseUrl;

/**
 * Registers an OpenID Federation trust anchor with a new P-256 key, as Issuer Settings and
 * presentation configurations accept only registered trust anchors. No trust anchor is
 * resolved in the E2E tests, so the key need not belong to a live federation.
 */
export async function registerTrustAnchor(
  token: string,
  id: string,
  entityId: string
): Promise<void> {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const response = await fetch(`${api}/api/federation-trust-anchor`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      entityId,
      jwks: { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: `${id}-key` }] },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
}

/** The OpenID Federation section on the Trust step of Issuer Settings, opened. */
export async function federationSection(page: Page): Promise<Locator> {
  const section = page
    .locator('mat-expansion-panel')
    .filter({ has: page.getByText('OpenID Federation', { exact: true }) })
    .first();
  const header = section.locator('mat-expansion-panel-header');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  return section;
}
