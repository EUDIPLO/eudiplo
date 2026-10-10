import { expect, test } from './support/test';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';

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

  await loginWithClientCredentials(
    page,
    resolvedE2EConfig.clientId!,
    resolvedE2EConfig.clientSecret!
  );
});
