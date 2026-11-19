import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant, tenantRequest, type TestTenant } from './support/tenants';

// A form's Save stays usable while fields are invalid (contributing/client.md). A click
// says in the snackbar which sections hold errors and focuses the first invalid field,
// which jsdom cannot show for a real browser. The webhook endpoint form stands for the
// other forms that follow the rule. The second test runs the list's search, the row link
// to the endpoint and the row's Delete in a browser; the third edits an endpoint and deletes
// it from its own page.

test.use({ storageState: { cookies: [], origins: [] } });

let tenant: TestTenant;

test.beforeAll(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  tenant = await createTenant('webhook-save', 'Webhook Save', ['issuance:manage']);
});

test('says which fields keep a webhook endpoint from saving and focuses the first one', async ({
  page,
}) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.locator('mat-sidenav').getByText('Webhook Endpoints', { exact: true }).click();
  await page.locator('.page-header').getByRole('link', { name: 'Create webhook endpoint' }).click();
  await page.getByRole('textbox', { name: 'ID', exact: true }).fill('order-events');

  const saves: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/webhook-endpoints')) {
      saves.push(request.url());
    }
  });
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await expect(create).toBeEnabled();
  // appConfigManaged holds clicks back while it looks up the ownership.
  await expect(create).not.toHaveAttribute('aria-busy', 'true');
  await create.click();

  const name = page.getByRole('textbox', { name: 'Name' });
  await expect(name).toBeFocused();
  await expect(page.getByText('Name is required')).toBeVisible();
  await expect(page.getByText('URL is required')).toBeVisible();
  await expect(page.getByText('Check the highlighted fields in Endpoint.')).toBeVisible();
  expect(saves).toEqual([]);

  await name.fill('Order events');
  await page.getByRole('textbox', { name: 'URL' }).fill('https://example.com/webhook');
  await create.click();

  await expect(page.getByText('Webhook endpoint created successfully')).toBeVisible();
  expect(saves).toHaveLength(1);
});

test('finds a webhook endpoint by its URL, opens it and deletes it from the list', async ({
  page,
}) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/webhook-endpoints/create');
  await page.getByRole('textbox', { name: 'ID', exact: true }).fill('audit-events');
  await page.getByRole('textbox', { name: 'Name' }).fill('Audit events');
  await page.getByRole('textbox', { name: 'URL' }).fill('https://audit.example.com/in');
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await expect(create).not.toHaveAttribute('aria-busy', 'true');
  await create.click();
  await expect(page).toHaveURL(/\/webhook-endpoints$/);

  await page.getByRole('searchbox', { name: /Search webhook endpoints/ }).fill('audit.example');
  await expect(page.locator('a.endpoint-link')).toHaveText(['Audit events']);
  await page.getByRole('link', { name: 'Audit events', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Audit events' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Webhook Endpoints' }).click();

  page.once('dialog', (dialog) => dialog.accept());
  const remove = page.getByRole('button', { name: 'Delete webhook endpoint Audit events' });
  await expect(remove).not.toHaveAttribute('aria-busy', 'true');
  await remove.click();
  await expect(page.getByText('Webhook endpoint deleted successfully')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Audit events', exact: true })).toHaveCount(0);
});

test('edits a webhook endpoint, returns to its page and deletes it from there', async ({
  page,
}) => {
  const created = await tenantRequest(tenant, 'POST', '/issuer/webhook-endpoints', {
    id: 'billing-events',
    name: 'Billing events',
    url: 'https://billing.example.com/in',
    auth: { type: 'none' },
  });
  expect(created.status, await created.clone().text()).toBe(201);

  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/webhook-endpoints/billing-events');
  await expect(page.getByRole('heading', { level: 1, name: 'Billing events' })).toBeVisible();

  const edit = page.getByRole('link', { name: 'Edit', exact: true });
  await expect(edit).not.toHaveAttribute('aria-busy', 'true');
  await edit.click();
  const name = page.getByRole('textbox', { name: 'Name' });
  await expect(name).toHaveValue('Billing events');
  // The ID names the endpoint and stays as it is.
  await expect(page.getByRole('textbox', { name: 'ID', exact: true })).toBeDisabled();
  await name.fill('Invoice events');
  await page.getByRole('textbox', { name: 'URL' }).fill('https://invoices.example.com/in');
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  const update = page.getByRole('button', { name: 'Update', exact: true });
  await expect(update).not.toHaveAttribute('aria-busy', 'true');
  await update.click();
  await expect(page.getByText('Webhook endpoint updated successfully')).toBeVisible();
  await expect(page).toHaveURL(/\/webhook-endpoints\/billing-events$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Invoice events' })).toBeVisible();
  await expect(page.getByText('https://invoices.example.com/in')).toBeVisible();

  // Dismissing the confirmation keeps the endpoint.
  const remove = page.getByRole('button', { name: 'Delete', exact: true });
  await expect(remove).not.toHaveAttribute('aria-busy', 'true');
  page.once('dialog', (dialog) => void dialog.dismiss());
  await remove.click();
  await expect(page).toHaveURL(/\/webhook-endpoints\/billing-events$/);

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('Invoice events');
    void dialog.accept();
  });
  await remove.click();
  await expect(page.getByText('Webhook endpoint deleted successfully')).toBeVisible();
  await expect(page).toHaveURL(/\/webhook-endpoints$/);
  await expect(page.getByRole('link', { name: 'Invoice events', exact: true })).toHaveCount(0);
  expect(
    (await tenantRequest(tenant, 'GET', '/issuer/webhook-endpoints/billing-events')).status
  ).toBe(404);
});
