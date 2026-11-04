import { expect, test } from './support/test';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';
import { loginWithClientCredentials } from './support/login';

// The Web Client builds its menu from the roles the backend returns for the
// token (`GET /api/auth/me`). When they cannot be loaded, it says why.

test.use({ storageState: { cookies: [], origins: [] } });

test('says why the roles are missing and loads them on Retry', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET to run the caller test.'
  );
  let backendFails = true;
  await page.route('**/api/auth/me', (route) =>
    backendFails
      ? route.fulfill({
          status: 503,
          json: { statusCode: 503, message: 'Service Unavailable' },
        })
      : route.fallback()
  );

  await loginWithClientCredentials(
    page,
    resolvedE2EConfig.clientId!,
    resolvedE2EConfig.clientSecret!
  );

  const nav = page.locator('mat-sidenav');
  await expect(page.getByText('Could not load your roles: Service Unavailable.')).toBeVisible();
  await expect(nav.getByText('Credential Types', { exact: true })).toHaveCount(0);

  backendFails = false;
  await page.getByRole('button', { name: 'Retry' }).click();

  await expect(nav.getByText('Credential Types', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
});
