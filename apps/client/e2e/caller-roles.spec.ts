import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { hasAuthCredentials, resolvedE2EConfig } from './support/e2e-config';
import { submitClientCredentials } from './support/login';

// The Web Client builds its menu from the roles the backend returns for the
// token (`GET /api/auth/me`). When they cannot be loaded, it says why, opens no
// page that needs a role, and loads them again on Retry.

/** Answers `GET /api/auth/me` with `503` until the returned function is called. */
async function failCallerRequests(
  page: Page
): Promise<{ requests: () => number; recover: () => void }> {
  let backendFails = true;
  let requests = 0;
  await page.route('**/api/auth/me', (route) => {
    requests++;
    return backendFails
      ? route.fulfill({ status: 503, json: { statusCode: 503, message: 'Service Unavailable' } })
      : route.fallback();
  });
  return { requests: () => requests, recover: () => (backendFails = false) };
}

test.describe('after signing in', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('says why the roles are missing and loads the dashboard again on Retry', async ({
    page,
  }) => {
    test.skip(
      !hasAuthCredentials,
      'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET to run the caller test.'
    );
    const backend = await failCallerRequests(page);

    await submitClientCredentials(
      page,
      resolvedE2EConfig.clientId!,
      resolvedE2EConfig.clientSecret!
    );

    const nav = page.locator('mat-sidenav');
    await expect(page.getByText('Could not load your roles: Service Unavailable.')).toBeVisible();
    // The dashboard opens, so its toolbar offers Logout, but shows nothing of the roles.
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(nav.getByText('Credential Types', { exact: true })).toHaveCount(0);
    await expect(page.locator('.stat-value')).toHaveCount(0);
    expect(backend.requests()).toBe(1);

    backend.recover();
    // The dashboard offers its own Retry next to the notice's.
    await page.locator('.roles-missing-card').getByRole('button', { name: 'Retry' }).click();

    await expect(nav.getByText('Credential Types', { exact: true })).toBeVisible();
    // The dashboard loads its figures for the roles.
    await expect(page.locator('.stat-value').first()).toHaveText(/^\s*\d+\s*$/);
  });

  test('opens the dashboard instead of the page to return to, and that page on Retry', async ({
    page,
  }) => {
    test.skip(
      !hasAuthCredentials,
      'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET to run the caller test.'
    );
    const backend = await failCallerRequests(page);

    await submitClientCredentials(
      page,
      resolvedE2EConfig.clientId!,
      resolvedE2EConfig.clientSecret!,
      '/login?returnUrl=%2Fcredential-config'
    );

    await expect(page.getByText('Could not load your roles: Service Unavailable.')).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard$/);
    // The dashboard reuses the failure of the page asked for.
    expect(backend.requests()).toBe(1);

    backend.recover();
    await page.locator('mat-snack-bar-container').getByRole('button', { name: 'Retry' }).click();

    await expect(page.getByRole('heading', { name: 'Credential Configurations' })).toBeVisible();
    await expect(page).toHaveURL(/\/credential-config$/);
  });
});

test('opens a page whose roles could not be loaded on Retry', async ({ page }) => {
  test.skip(!hasAuthCredentials, 'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET.');
  const backend = await failCallerRequests(page);

  // Opening the page by address reloads the app, which loads the caller of its token.
  await page.goto('/credential-config');

  await expect(page.getByText('Could not load your roles: Service Unavailable.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Credential Configurations' })).toHaveCount(0);
  // AuthGuard and RoleGuard of the route share the failed request.
  expect(backend.requests()).toBe(1);

  backend.recover();
  await page.getByRole('button', { name: 'Retry' }).click();

  await expect(page.getByRole('heading', { name: 'Credential Configurations' })).toBeVisible();
  await expect(page).toHaveURL(/\/credential-config$/);
});
