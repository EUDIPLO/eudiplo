import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { holdRequests } from './support/routes';
import { createTenant, tenantRequest, type TestTenant } from './support/tenants';

// API clients: deleting one from its row of the API Clients page. Each test runs in a tenant of
// its own whose admin client signs in and manages the tenant's other clients.

test.use({ storageState: { cookies: [], origins: [] } });

let tenant: TestTenant;
/** Two clients of the tenant; client IDs are unique across tenants, so they carry the tenant's. */
let shop: string;
let warehouse: string;

test.beforeEach(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  tenant = await createTenant('api-clients', 'API Clients', ['clients:manage', 'issuance:offer']);
  shop = `${tenant.id}-shop`;
  warehouse = `${tenant.id}-warehouse`;
  for (const clientId of [shop, warehouse]) {
    const response = await tenantRequest(tenant, 'POST', '/client', {
      clientId,
      description: 'A service of the tenant',
      roles: ['issuance:offer'],
    });
    expect(response.status, `create ${clientId}`).toBe(201);
  }
});

async function clientIds(): Promise<string[]> {
  const response = await tenantRequest(tenant, 'GET', '/client');
  expect(response.status).toBe(200);
  return ((await response.json()) as { clientId: string }[]).map(({ clientId }) => clientId);
}

test('deletes an API client from its row and keeps the table while it runs', async ({ page }) => {
  const { sent, release } = await holdRequests(page, 'DELETE', `/api/client/${shop}`);
  const deletes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'DELETE') deletes.push(new URL(request.url()).pathname);
  });
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/clients');
  const row = (clientId: string) =>
    page.getByRole('row').filter({ has: page.getByRole('link', { name: clientId, exact: true }) });
  const deleteButton = (clientId: string) =>
    row(clientId).getByRole('button', { name: 'Delete Client', exact: true });
  // appConfigManaged holds clicks back until its ownership lookup has answered.
  await expect(deleteButton(shop)).not.toHaveAttribute('aria-busy', 'true');

  // Dismissing the confirmation keeps the client: no DELETE leaves the page.
  const dismissed = new Promise<void>((resolve) =>
    page.once('dialog', (dialog) => void dialog.dismiss().then(resolve))
  );
  await deleteButton(shop).click();
  await dismissed;
  await expect(row(shop)).toBeVisible();

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain(`"${shop}"`);
    void dialog.accept();
  });
  await deleteButton(shop).click();
  await sent;

  // While the delete runs, the table stays and the other rows' Delete waits.
  await expect(page.getByRole('progressbar', { name: 'Loading clients' })).toHaveCount(0);
  const other = deleteButton(warehouse);
  await expect(other).toHaveAttribute('aria-disabled', 'true');
  await expect(other).toHaveAccessibleDescription('Wait until the other delete has finished');

  release();
  await expect(page.getByText('Client deleted successfully')).toBeVisible();
  await expect(row(shop)).toHaveCount(0);
  // The focused Delete left with its row: focus moves to the row now in its place.
  await expect(page.getByRole('link', { name: warehouse, exact: true })).toBeFocused();
  await expect(other).not.toHaveAttribute('aria-disabled', 'true');
  expect(deletes).toEqual([`/api/client/${shop}`]);
  expect(await clientIds()).not.toContain(shop);
  expect(await clientIds()).toContain(warehouse);
});
