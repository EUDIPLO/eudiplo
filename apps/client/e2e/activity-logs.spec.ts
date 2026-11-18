import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant, tenantRequest, type TestTenant } from './support/tenants';

// The activity log filters on the server and keeps the filters in the URL. A tenant
// of its own holds exactly the entries this test creates: its creation and one
// webhook endpoint.

test.use({ storageState: { cookies: [], origins: [] } });

let tenant: TestTenant;

test.beforeAll(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  tenant = await createTenant('activity-filter', 'Activity Filter', [
    'clients:manage',
    'issuance:manage',
  ]);
  const created = await tenantRequest(tenant, 'POST', '/issuer/webhook-endpoints', {
    id: 'audit-events',
    name: 'Audit events',
    url: 'https://example.com/webhook',
    auth: { type: 'none' },
  });
  expect(created.status, await created.text()).toBe(201);
});

test('filters the activity log on the server by search, object and time, and keeps the filters in the URL', async ({
  page,
}) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.locator('mat-sidenav').getByText('Activity Logs', { exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/activity-logs$/);
  const entries = page.locator('.entry-action');
  await expect(entries).toHaveCount(2);
  await expect(
    page.getByText('Entries are kept until the operator sets a retention.')
  ).toBeVisible();

  // The free-text search runs on the server and matches the action as the page shows it.
  const searched = page.waitForResponse(
    (response) =>
      response.url().includes('/api/admin/audit-logs/search') && response.url().includes('q=')
  );
  await page.getByRole('searchbox', { name: /Search activity/ }).fill('endpoint created');
  expect((await searched).ok()).toBe(true);
  await expect(entries).toHaveText(['Webhook Endpoint Created']);
  await expect(page).toHaveURL(/q=endpoint/);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(entries).toHaveCount(2);

  const filtered = page.waitForResponse(
    (response) =>
      response.url().includes('/api/admin/audit-logs/search') &&
      response.url().includes('objectType=webhook_endpoint')
  );
  await page.getByRole('option', { name: 'Webhook Endpoint', exact: true }).click();
  expect((await filtered).ok()).toBe(true);
  await expect(entries).toHaveText(['Webhook Endpoint Created']);
  await expect(page).toHaveURL(/objectType=webhook_endpoint/);

  // A shared or reloaded link shows the same view.
  await page.reload();
  await expect(entries).toHaveText(['Webhook Endpoint Created']);
  await expect(page.getByRole('option', { name: 'Webhook Endpoint', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );

  await page.getByRole('combobox', { name: 'Time' }).click();
  await page.getByRole('option', { name: 'Custom range' }).click();
  await page.getByLabel('From', { exact: true }).fill('2026-01-02T10:00');
  await page.getByLabel('To', { exact: true }).fill('2026-01-01T10:00');
  await expect(page.getByText('Must not be before From')).toBeVisible();
  await expect(entries).toHaveCount(0);

  await page.locator('.filter-row').getByRole('button', { name: 'Clear filters' }).click();
  await expect(entries).toHaveCount(2);
  await expect(page).toHaveURL(/\/admin\/activity-logs$/);
});
