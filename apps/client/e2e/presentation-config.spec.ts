import { expect, test } from './support/test';
import { hasAuthCredentials } from './support/e2e-config';

test('presentation config list is reachable when authenticated', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );

  await page.goto('/presentation-config');
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page).toHaveURL(/\/presentation-config(\/.*)?$/);
});

test('presentation config create page is reachable when authenticated', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );

  await page.goto('/presentation-config/create');
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page).toHaveURL(/\/presentation-config\/create$/);
  await expect(page.getByRole('heading', { name: 'Create Presentation' })).toBeVisible();
});
