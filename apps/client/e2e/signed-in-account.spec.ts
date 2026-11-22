import { expect, test } from './support/test';
import { hasRootCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';
import { createTenant } from './support/tenants';

// The account menu and Connection Settings say who is signed in and which tenant a destructive
// action would hit. SSO needs an identity provider, so the unit tests cover it.

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(() => {
  test.skip(!hasRootCredentials, 'Needs the root credentials to create a tenant.');
});

test('names the tenant of the signed-in client in the account menu and Connection Settings', async ({
  page,
}) => {
  const tenant = await createTenant('account-e2e', 'Account E2E', ['clients:manage']);
  await loginWithClientCredentials(page, tenant.clientId, tenant.clientSecret);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.locator('.account-summary-client')).toHaveText(`Client ID: ${tenant.clientId}`);
  await expect(page.locator('.account-summary-tenant')).toHaveText(`Tenant: ${tenant.id}`);
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Connection Settings' }).click();
  await expect(page.getByRole('textbox', { name: 'Tenant' })).toHaveValue(tenant.id);
  await expect(page.getByRole('textbox', { name: 'Client ID' })).toHaveValue(tenant.clientId);
});

test('says the root client acts in no tenant', async ({ page }) => {
  await loginWithClientCredentials(
    page,
    resolvedE2EConfig.rootClientId!,
    resolvedE2EConfig.rootClientSecret!
  );

  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.locator('.account-summary-tenant')).toHaveText('Tenant: No tenant');
});
