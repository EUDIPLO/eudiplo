import { expect, test } from './support/test';
import { hasAuthCredentials } from './support/e2e-config';

test('session management list is reachable when authenticated', async ({ page }) => {
  test.skip(
    !hasAuthCredentials,
    'Set E2E_TENANT_CLIENT_ID and E2E_TENANT_CLIENT_SECRET for tenant flow tests.'
  );

  await page.goto('/session-management');
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page).toHaveURL(/\/session-management(\/.*)?$/);
});
