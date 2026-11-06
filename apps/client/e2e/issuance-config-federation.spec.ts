import { generateKeyPairSync } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant, type TestTenant } from './support/tenants';

// Publishing the OpenID Federation entity configuration: Issuer Settings name the
// entity ID EUDIPLO serves it under and say when the federation key is missing;
// the key wizard creates that key and its page shows the public key to register.
// The spec creates its own tenant, so it starts without a federation key.

test.use({ storageState: { cookies: [], origins: [] } });
// Later tests build on the settings and the key the earlier ones saved.
test.describe.configure({ mode: 'serial' });

const api = resolvedE2EConfig.apiBaseUrl;
const trustAnchor = 'https://ta.example.org';

let tenant: TestTenant;
let entityId: string;

test.beforeAll(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  tenant = await createTenant('federation', 'Federation Entity', ['issuance:manage']);
  const response = await fetch(`${api}/api/frontend-config`, {
    headers: { Authorization: `Bearer ${tenant.token}` },
  });
  expect(response.ok).toBe(true);
  const { publicUrl } = (await response.json()) as { publicUrl?: string };
  expect(publicUrl, 'GET /api/frontend-config reports PUBLIC_URL').toBeTruthy();
  entityId = `${publicUrl}/issuers/${tenant.id}`;

  // Issuer Settings only offer registered trust anchors (with pinned keys).
  const anchor = await fetch(`${api}/api/federation-trust-anchor`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'example-ta',
      entityId: trustAnchor,
      jwks: {
        keys: [
          {
            ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
              format: 'jwk',
            }),
            kid: 'ta-2026',
          },
        ],
      },
    }),
  });
  expect(anchor.status, await anchor.text()).toBe(201);
});

/** The OpenID Federation section on the Trust tab, opened. */
async function federationSection(page: Page): Promise<Locator> {
  const section = page
    .locator('mat-expansion-panel')
    .filter({ has: page.getByText('OpenID Federation', { exact: true }).first() });
  const header = section.locator('mat-expansion-panel-header');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  return section;
}

async function savedFederation(): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(`${api}/api/issuer/config`, {
    headers: { Authorization: `Bearer ${tenant.token}` },
  });
  expect(response.ok).toBe(true);
  return (await response.json()).federation;
}

test('names the entity ID to use and says the federation key is missing', async ({ page }) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/issuance-config/edit');

  // The new tenant has no identity yet, so the guided setup opens.
  await expect(page.getByText('Step 1 of 4 · Identity')).toBeVisible();
  await page.getByRole('textbox', { name: 'Name' }).fill('Federation Entity');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('· Wallet access')).toBeVisible();

  // The tenant has no authorization server key; the link creates one for this form in a new tab.
  const server = page
    .locator('mat-expansion-panel')
    .filter({ has: page.locator('mat-panel-description', { hasText: 'built-in' }) });
  const serverHeader = server.locator('mat-expansion-panel-header');
  if ((await serverHeader.getAttribute('aria-expanded')) !== 'true') await serverHeader.click();
  await expect(server.getByText(/No Authorization Server key exists yet/)).toBeVisible();
  const createServerKey = server.getByRole('link', { name: 'create one (opens in a new tab)' });
  await expect(createServerKey).toHaveAttribute(
    'href',
    '/keys/create?usage=authorizationServer&from=form'
  );
  await expect(createServerKey).toHaveAttribute('target', '_blank');

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('· Trust')).toBeVisible();

  const federation = await federationSection(page);
  await federation.getByRole('switch', { name: /Enable OpenID Federation/ }).click();

  const entityIdField = federation.getByRole('textbox', { name: 'Entity ID (optional)' });
  await expect(federation.getByText(`Set to ${entityId} to publish`)).toBeVisible();
  const missingKey = federation.getByText(/No key with usage type OpenID Federation Entity Key/);
  await expect(missingKey).toHaveCount(0);

  // An entity ID other than the served URL is called out.
  await entityIdField.fill('https://proxy.example.com/federation');
  await expect(federation.getByText(`This entity ID differs from ${entityId}`)).toBeVisible();
  await expect(missingKey).toBeVisible();

  await federation.getByRole('button', { name: 'Use this URL' }).click();
  await expect(entityIdField).toHaveValue(entityId);
  await expect(federation.getByText(/This entity ID differs/)).toHaveCount(0);
  await expect(federation.getByRole('button', { name: 'Use this URL' })).toHaveCount(0);
  await expect(missingKey).toBeVisible();
  const createKey = federation.getByRole('link', { name: /Create a federation key/ });
  await expect(createKey).toHaveAttribute('href', '/keys/create?usage=federation&from=form');
  await expect(createKey).toHaveAttribute('target', '_blank');

  await federation.getByRole('button', { name: 'Add Trust Anchor' }).click();
  await federation.getByRole('combobox', { name: 'Trust Anchor 1' }).click();
  await page.getByRole('option', { name: /\(https:\/\/ta\.example\.org\)/ }).click();
  await expect(federation.getByRole('textbox', { name: 'Entity Configuration URI' })).toHaveValue(
    `${trustAnchor}/.well-known/openid-federation`
  );

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('· Review')).toBeVisible();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page).toHaveURL(/\/issuance-config$/);
  expect(await savedFederation()).toMatchObject({
    entityId,
    trustAnchors: [{ entityId: trustAnchor }],
  });
});

test('creates the federation key in a new tab and checks again', async ({ page }) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/issuance-config/edit');
  await page.getByRole('tab', { name: 'Trust' }).click();
  const federation = await federationSection(page);
  const missingKey = federation.getByText(/No key with usage type OpenID Federation Entity Key/);
  await expect(missingKey).toBeVisible();

  // The link opens the wizard in a new tab with the usage preselected.
  const [wizard] = await Promise.all([
    page.context().waitForEvent('page'),
    federation.getByRole('link', { name: /Create a federation key/ }).click(),
  ]);
  await expect(wizard.getByRole('radio', { name: /OpenID Federation Entity Key/ })).toBeChecked();
  await wizard.getByRole('button', { name: 'Configure Key' }).click();
  const description = 'E2E federation key';
  await wizard.getByRole('textbox', { name: 'Description' }).fill(description);
  await wizard.getByRole('button', { name: 'Create Key Chain' }).click();

  // The wizard tab says to return to the form instead of moving on to another page.
  const created = wizard.getByRole('heading', { name: `Key chain "${description}" created` });
  await expect(created).toBeVisible();
  await expect(created).toBeFocused();
  await expect(wizard.getByText('Your form is still open in the tab you came from.')).toBeVisible();
  await expect(wizard).toHaveURL(/\/keys\/create\?usage=federation&from=form$/);
  await expect(wizard.getByRole('button', { name: 'Create Key Chain' })).toHaveCount(0);
  await expect(wizard.getByRole('link', { name: 'Open key chain' })).toHaveAttribute(
    'href',
    /^\/keys\/[^/?]+$/
  );
  await wizard.close();

  // The unsaved Issuer Settings tab is still there and finds the key on request.
  await federation.getByRole('button', { name: 'Check again' }).click();
  await expect(missingKey).toHaveCount(0);
});

test('shows the public key of the federation key', async ({ page }) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  const response = await fetch(`${api}/api/key-chain`, {
    headers: { Authorization: `Bearer ${tenant.token}` },
  });
  expect(response.ok).toBe(true);
  const keyChains = (await response.json()) as {
    id: string;
    usageType: string;
    activePublicKey: { kid: string };
  }[];
  const federationKey = keyChains.find((keyChain) => keyChain.usageType === 'federation');
  expect(federationKey).toBeDefined();
  await page.goto(`/keys/${federationKey!.id}`);

  const description = 'E2E federation key';
  await expect(page.getByRole('heading', { name: `Key Chain: ${description}` })).toBeVisible();
  const publicKey = page.locator('mat-card').filter({ hasText: 'Public Key' }).last();
  await expect(publicKey.getByText('Key ID (kid)')).toBeVisible();
  await expect(publicKey).toContainText(federationKey!.activePublicKey.kid);
  await expect(publicKey.getByRole('button', { name: 'Copy Public Key (JWK)' })).toBeVisible();
  await expect(page.getByText('Active Certificate')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy PEM' })).toHaveCount(0);
});

test('stops saying the federation key is missing once it exists', async ({ page }) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/issuance-config/edit');
  await page.getByRole('tab', { name: 'Trust' }).click();
  const federation = await federationSection(page);
  await expect(federation.getByRole('textbox', { name: 'Entity ID (optional)' })).toHaveValue(
    entityId
  );
  await expect(federation.getByText(`Set to ${entityId} to publish`)).toBeVisible();
  await expect(
    federation.getByText(/No key with usage type OpenID Federation Entity Key/)
  ).toHaveCount(0);
  await expect(federation.getByRole('button', { name: 'Use this URL' })).toHaveCount(0);
});
