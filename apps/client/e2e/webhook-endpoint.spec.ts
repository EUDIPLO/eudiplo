import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant, type TestTenant } from './support/tenants';

// A form's Save stays usable while fields are invalid (contributing/client.md). A click
// says in the snackbar which sections hold errors and focuses the first invalid field,
// which jsdom cannot show for a real browser. The webhook endpoint form stands for the
// other forms that follow the rule.

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
  await page.getByRole('button', { name: 'Create New Webhook Endpoint' }).click();
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
  await expect(page.getByText('Check the highlighted fields in Endpoint Details.')).toBeVisible();
  expect(saves).toEqual([]);

  await name.fill('Order events');
  await page.getByRole('textbox', { name: 'URL' }).fill('https://example.com/webhook');
  await create.click();

  await expect(page.getByText('Webhook endpoint created successfully')).toBeVisible();
  expect(saves).toHaveLength(1);
});
