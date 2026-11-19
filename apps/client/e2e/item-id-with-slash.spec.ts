import { expect, test } from './support/test';
import { hasRootCredentials } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant, type TestTenant } from './support/tenants';

// Most IDs may contain a slash. The list links keep such an ID as one URL segment, so its
// row opens the item and its row action opens the editor, instead of a route that does not
// exist. The webhook endpoint list stands for the other lists, which link the same way.

test.use({ storageState: { cookies: [], origins: [] } });

let tenant: TestTenant;

test.beforeAll(async () => {
  test.skip(
    !hasRootCredentials,
    'Set AUTH_CLIENT_ID and AUTH_CLIENT_SECRET of the backend to create a tenant.'
  );
  tenant = await createTenant('slash-id', 'Slash ID', ['issuance:manage']);
});

test('opens an item whose ID contains a slash from its list row and edits it', async ({ page }) => {
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);
  await page.goto('/webhook-endpoints/create');
  await page.getByRole('textbox', { name: 'ID', exact: true }).fill('team/hook');
  await page.getByRole('textbox', { name: 'Name' }).fill('Team hook');
  await page.getByRole('textbox', { name: 'URL' }).fill('https://example.com/in');
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await expect(create).not.toHaveAttribute('aria-busy', 'true');
  await create.click();
  await expect(page.getByText('Webhook endpoint created successfully')).toBeVisible();

  await page.goto('/webhook-endpoints');
  await page.getByRole('link', { name: 'Team hook', exact: true }).click();
  await expect(page).toHaveURL(/\/webhook-endpoints\/team%2Fhook$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Team hook' })).toBeVisible();

  await page.goto('/webhook-endpoints');
  const edit = page.locator('a[href$="/team%2Fhook/edit"]');
  await expect(edit).toHaveCount(1);
  await edit.click();
  await expect(page).toHaveURL(/\/webhook-endpoints\/team%2Fhook\/edit$/);
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('Team hook');
});
