import { expect, test } from './support/test';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';

test.use({ storageState: { cookies: [], origins: [] } });

test('login page is accessible', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('login with client credentials redirects to dashboard', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET to run tenant login flow test.'
  );

  await page.goto('/login');
  await page.getByRole('tab', { name: 'Client ID and Secret' }).click();

  await page.getByLabel('EUDIPLO Instance').fill(resolvedE2EConfig.apiBaseUrl);
  await page.getByLabel('EUDIPLO Instance').blur();

  await page.getByRole('textbox', { name: 'Client ID' }).fill(resolvedE2EConfig.clientId!);
  await page.getByRole('textbox', { name: 'Client Secret' }).fill(resolvedE2EConfig.clientSecret!);

  await page.getByRole('button', { name: 'Login with Client Credentials' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});
