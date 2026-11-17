import { randomBytes } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant, type TestTenant } from './support/tenants';

// "Request from EUDI Hub" on the key page. The backend's two EUDI Hub
// endpoints are stubbed in the browser, since they would call the real EUDI
// Hub; the backend side has its own E2E suite with a stub EUDI Hub. Each test
// gets its own tenant and access key chain.

test.use({ storageState: { cookies: [], origins: [] } });
test.skip(!hasRootCredentials, 'Creating test tenants needs the root credentials');

const api = resolvedE2EConfig.apiBaseUrl;
const ORG = '01932c5a-9abc-7000-8000-000000000010';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.portal.signature';

async function createAccessKey(tenant: TestTenant): Promise<string> {
  const response = await fetch(`${api}/api/key-chain`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      usageType: 'access',
      type: 'standalone',
      description: `Access key ${randomBytes(4).toString('hex')}`,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).id;
}

async function openDialog(page: Page, tenant: TestTenant, keyId: string): Promise<void> {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto(`/keys/${keyId}`);
  const action = page.getByRole('button', { name: 'Request from EUDI Hub' });
  // Clicks are held back while the key's config ownership is looked up.
  await expect(action).not.toHaveAttribute('aria-busy', 'true');
  await action.click();
  await expect(
    page.getByRole('heading', { name: 'Request Access Certificate from the EUDI Hub' })
  ).toBeVisible();
}

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test('requests a certificate with a pasted token and reloads the key', async ({ page }) => {
  const tenant = await createTenant('eudi-hub-e2e', 'EUDI Hub E2E', [
    'registrar:manage',
    'keys:manage',
  ]);
  const keyId = await createAccessKey(tenant);
  const sent: Record<string, unknown>[] = [];
  await page.route('**/api/eudi-hub/organizations', (route) =>
    json(route, 200, [{ id: ORG, name: 'Example Org' }])
  );
  await page.route('**/api/eudi-hub/access-certificate', (route) => {
    sent.push(route.request().postDataJSON());
    return json(route, 201, { id: 'hub-1', certId: keyId, crt: 'PEM', environment: 'live' });
  });

  await openDialog(page, tenant, keyId);
  await expect(page.getByLabel('Access token')).toBeFocused();
  await page.getByLabel('Access token').fill(`Bearer ${TOKEN}`);
  await page.getByRole('button', { name: 'Load Organizations' }).click();
  // The only organization is selected.
  await expect(page.getByRole('combobox', { name: 'Organization' })).toContainText('Example Org');
  await page.getByRole('radio', { name: 'Live' }).check();
  await expect(page.getByText('Live issues a production access certificate')).toBeVisible();
  await page.getByLabel('Support URI').fill('https://support.example');

  const reload = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/key-chain/${keyId}`) && response.request().method() === 'GET'
  );
  await page.getByRole('button', { name: 'Request Live Certificate' }).click();

  await expect(page.getByText('Access certificate from the EUDI Hub (live) stored')).toBeVisible();
  await reload;
  expect(sent).toEqual([
    {
      token: `Bearer ${TOKEN}`,
      organizationId: ORG,
      keyId,
      environment: 'live',
      supportUri: 'https://support.example',
    },
  ]);
});

test('shows why the EUDI Hub refused and keeps the dialog open', async ({ page }) => {
  const tenant = await createTenant('eudi-hub-e2e', 'EUDI Hub E2E', [
    'registrar:manage',
    'keys:manage',
  ]);
  const keyId = await createAccessKey(tenant);
  await page.route('**/api/eudi-hub/organizations', (route) =>
    json(route, 400, {
      statusCode: 400,
      message:
        'Could not read the organizations of the EUDI Hub user: the EUDI Hub did not accept the access token (HTTP 401).',
    })
  );

  await openDialog(page, tenant, keyId);
  await page.getByLabel('Access token').fill(TOKEN);
  await page.getByRole('button', { name: 'Load Organizations' }).click();

  await expect(page.getByRole('alert')).toContainText('did not accept the access token');
  await expect(page.getByRole('alert')).toContainText('enter the organization ID by hand');
  await expect(page.getByLabel('Organization ID')).toBeVisible();
});

test('does not offer the request without the registrar:manage role', async ({ page }) => {
  const tenant = await createTenant('eudi-hub-e2e', 'EUDI Hub E2E', ['keys:manage']);
  const keyId = await createAccessKey(tenant);

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto(`/keys/${keyId}`);

  await expect(page.getByRole('button', { name: 'Copy PEM' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request from EUDI Hub' })).toHaveCount(0);
});
